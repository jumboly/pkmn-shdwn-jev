// Headless experiment runner (Simulator transport).
//   node scripts/experiment.ts --p1 jev --p2 random --battles 3
// Players: random | mock-jev | jev. Any live `jev` player makes this spend real money and is
// always budget-guarded; mock-jev uses a throwaway ledger inside the run directory.
import { parseArgs } from 'node:util';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { execSync } from 'node:child_process';
import { BudgetGuard, budgetConfigFromEnv } from '../src/budget.ts';
import { jevFromEnv, mockJev, openBudget } from '../src/config.ts';
import { RandomProvider } from '../src/decision/random.ts';
import { HandicapProvider } from '../src/decision/handicap.ts';
import { sharedRateLimiter } from '../src/decision/rate-limiter.ts';
import type { DecisionProvider } from '../src/decision/types.ts';
import { JsonlLog, writeText } from '../src/logging.ts';
import { replayHtml } from '../src/replay.ts';
import { SHOWDOWN_VERSION } from '../src/showdown/sim.ts';
import { runSimBattle, type BattleResult } from '../src/sim/run-battle.ts';

const { values: a } = parseArgs({
	options: {
		p1: { type: 'string', default: 'jev' },
		p2: { type: 'string', default: 'random' },
		battles: { type: 'string', default: '1' },
		format: { type: 'string', default: 'gen9randombattle' },
		seed: { type: 'string', default: 'jev-experiment' },
		id: { type: 'string' },
		concurrency: { type: 'string', default: '1' },
		fallback: { type: 'string', default: 'none' },
		'max-turns': { type: 'string', default: '300' },
		/** Pessimistic requests per JEV side per battle, for the "can we start another battle" check. */
		'requests-per-side': { type: 'string', default: '80' },
		'swap-sides': { type: 'boolean', default: true },
		/** Used by `*-mercy` player kinds (e.g. jev-mercy, mock-jev-mercy). */
		'mercy-strength': { type: 'string', default: process.env.MERCY_STRENGTH || '0.6' },
		/** Fault injection for mock-jev players: clean | flaky (see mock-gateway.ts). */
		'mock-profile': { type: 'string' },
	},
});

const startedAt = Date.now();
const experimentId = a.id ?? `${new Date().toISOString().replace(/[:.]/g, '-')}-${a.p1}-vs-${a.p2}`;
const outDir = join('runs', experimentId);
const events = new JsonlLog(join(outDir, 'events.jsonl'));
const kinds = [a.p1!, a.p2!];
const baseKind = (k: string) => k.replace(/-mercy$/, '');
const usesLive = kinds.some(k => baseKind(k) === 'jev');
const usesMock = kinds.some(k => baseKind(k) === 'mock-jev');

// Live spend always goes through the persistent project ledger; mock spend never touches it.
const liveBudget = usesLive ? openBudget(experimentId) : null;
const mockBudget = usesMock ? new BudgetGuard({ ...budgetConfigFromEnv(join(outDir, 'mock-ledger.jsonl')) }, experimentId) : null;
if (!usesLive) console.log('[budget] no live JEV player: no paid requests will be made');

const fallback = a.fallback === 'random' ? new RandomProvider('sodium,00000000000000000000000000000fb0') : undefined;
// Why: one mock gateway per run (not per battle) so its fault stats aggregate into the summary.
const mock = usesMock ? mockJev(mockBudget!, { profile: a['mock-profile'], seed: 'sodium,0000000000000000000000000000beef', fallback }) : null;
function makeProvider(kind: string, label: string): DecisionProvider {
	if (kind.endsWith('-mercy')) {
		return new HandicapProvider(makeProvider(kind.slice(0, -'-mercy'.length), label), {
			mode: 'mercy', strength: Number(a['mercy-strength']), seed: seedFor(`${label}|mercy`),
		});
	}
	if (kind === 'random') return new RandomProvider(seedFor(`${label}|provider`));
	if (kind === 'mock-jev') return mock!.provider;
	if (kind === 'jev') return jevFromEnv(liveBudget!, { label: 'jev', fallback });
	throw new Error(`unknown player kind ${kind}`);
}
function seedFor(label: string) {
	return `sodium,${createHash('sha256').update(`${a.seed}|${label}`).digest('hex').slice(0, 32)}`;
}

let showdownCommit: string | undefined;
try { showdownCommit = execSync('git -C vendor/pokemon-showdown rev-parse HEAD', { stdio: ['ignore', 'pipe', 'ignore'] }).toString().trim(); } catch {}
const config = { experimentId, ...a, showdownVersion: SHOWDOWN_VERSION, vendoredServerCommit: showdownCommit, budget: liveBudget?.snapshot ?? null, maxCostPerRequestUsd: liveBudget?.config.maxCostPerRequestUsd };
writeText(join(outDir, 'config.json'), JSON.stringify(config, null, 2));
events.write('experiment-start', config);

const total = Number(a.battles);
const results: (BattleResult & { p1Kind: string, p2Kind: string })[] = [];
let stopReason: string | null = null;
let next = 0;

function expectedBattle() {
	const liveSides = kinds.filter(k => baseKind(k) === 'jev').length;
	const requests = liveSides * Number(a['requests-per-side']);
	// Why: use observed cost per request (x2 safety) once we have data; worst case until then.
	const s = liveBudget!.snapshot;
	const perReq = s.requestsExperiment >= 20 ? Math.max(2 * s.spentExperimentUsd / s.requestsExperiment, 1e-5) : liveBudget!.config.maxCostPerRequestUsd;
	return { requests, costUsd: requests * perReq };
}

async function worker() {
	while (!stopReason && next < total) {
		if (liveBudget) {
			const reason = liveBudget.checkNewBattle(expectedBattle());
			if (reason) { stopReason = `budget: ${reason}`; events.write('budget-stop', { reason, budget: liveBudget.snapshot }); console.log(`[budget] STOP before battle ${next + 1}: ${reason}`); break; }
		}
		const i = next++;
		// Why: alternate sides so a first-mover or seat bias does not skew head-to-head results.
		const swap = a['swap-sides'] && i % 2 === 1;
		const [k1, k2] = swap ? [kinds[1], kinds[0]] : kinds;
		const battleId = `${experimentId}-b${String(i + 1).padStart(4, '0')}`;
		const battleLog = new JsonlLog(join(outDir, 'battles', `${battleId}.jsonl`));
		const r = await runSimBattle({
			battleId, format: a.format!, seed: seedFor(`battle|${i}`), log: battleLog, maxTurns: Number(a['max-turns']),
			p1: { name: `${k1}-p1`, provider: makeProvider(k1, `${battleId}|p1`) },
			p2: { name: `${k2}-p2`, provider: makeProvider(k2, `${battleId}|p2`) },
		});
		const decisions = battleLog.events.filter(e => e.type === 'decision') as any[];
		const jevUsage = decisions.reduce((acc, d) => {
			if (d.decision.usage) { acc.requests += d.decision.usage.requests; acc.costUsd += d.decision.usage.costUsd; }
			if (d.decision.fallback) acc.fallbacks++;
			if (d.decision.handicap?.mode === 'mercy') { acc.mercyDecisions++; if (d.decision.handicap.changed) acc.mercyChanged++; }
			return acc;
		}, { requests: 0, costUsd: 0, fallbacks: 0, mercyDecisions: 0, mercyChanged: 0 });
		writeText(join(outDir, 'battles', `${battleId}.spectator.log`), r.spectatorLog);
		writeText(join(outDir, 'battles', `${battleId}.inputlog`), r.inputLog.join('\n') + '\n');
		writeText(join(outDir, 'battles', `${battleId}.replay.html`), replayHtml({ log: r.spectatorLog, title: `${battleId}: ${k1} vs ${k2}`, replayId: battleId }));
		const winnerKind = r.winner === 'p1' ? k1 : r.winner === 'p2' ? k2 : null;
		const row = { ...r, spectatorLog: undefined, inputLog: undefined, p1Kind: k1, p2Kind: k2, winnerKind, jevUsage };
		results.push({ ...r, p1Kind: k1, p2Kind: k2 });
		events.write('battle-result', row);
		console.log(`[${i + 1}/${total}] ${k1} vs ${k2}: ${r.outcome}${winnerKind ? ` -> ${winnerKind} (${r.winner})` : ''} in ${r.turns} turns, ${r.decisions} decisions, JEV req ${jevUsage.requests}, $${jevUsage.costUsd.toFixed(6)}${jevUsage.mercyDecisions ? `, mercy changed ${jevUsage.mercyChanged}/${jevUsage.mercyDecisions}` : ''}${r.abortReason ? ` | ${r.abortReason}` : ''}`);
		if (r.abortReason && /budget/i.test(r.abortReason)) { stopReason = `budget: ${r.abortReason}`; events.write('budget-stop', { reason: r.abortReason }); }
	}
}
await Promise.all(Array.from({ length: Number(a.concurrency) }, worker));

const finished = results.filter(r => r.outcome !== 'aborted');
const winsByKind: Record<string, number> = {};
for (const r of finished) {
	const k = r.winner === 'p1' ? r.p1Kind : r.winner === 'p2' ? r.p2Kind : 'tie';
	winsByKind[k] = (winsByKind[k] ?? 0) + 1;
}
const summary = {
	experimentId, players: kinds, battlesPlanned: total, battlesRun: results.length, finished: finished.length,
	aborted: results.length - finished.length, winsByKind,
	avgTurns: finished.length ? finished.reduce((s, r) => s + r.turns, 0) / finished.length : null,
	stopReason, wallSeconds: Math.round((Date.now() - startedAt) / 1000), mockFaults: mock?.stats ?? null, rateLimiter: { ...sharedRateLimiter.stats, finalIntervalMs: Math.round(sharedRateLimiter.intervalMs) }, liveBudget: liveBudget?.snapshot ?? null, mockBudget: mockBudget?.snapshot ?? null,
};
writeText(join(outDir, 'summary.json'), JSON.stringify(summary, null, 2));
events.write('experiment-end', summary);
console.log(JSON.stringify(summary, null, 2));
console.log(`output: ${outDir}`);
liveBudget?.release();
mockBudget?.release();
