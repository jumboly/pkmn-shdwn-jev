// Autonomous Mode: connect JEV to a LOCAL / self-hosted Showdown server as a normal player.
//   node scripts/jev-bot.ts --name JEV-Bot [--mercy 0.6] [--provider jev|random|mock-jev [--mock-profile flaky]] [--max-battles 3]
//     [--challenge OTHER-BOT [--rechallenge]] [--timer] [--timer-fallback random|none]
// Then challenge "JEV-Bot" to [Gen 9] Random Battle from the Showdown UI.
import { parseArgs } from 'node:util';
import { jevFromEnv, mockJev, openBudget } from '../src/config.ts';
import { HandicapProvider } from '../src/decision/handicap.ts';
import { RandomProvider } from '../src/decision/random.ts';
import { BudgetGuard, budgetConfigFromEnv } from '../src/budget.ts';
import type { DecisionProvider } from '../src/decision/types.ts';
import { AutonomousClient } from '../src/server/client.ts';

const { values: a } = parseArgs({ options: {
	url: { type: 'string', default: process.env.PS_SERVER_URL || 'ws://localhost:8000/showdown/websocket' },
	name: { type: 'string', default: 'JEV-Bot' },
	provider: { type: 'string', default: 'jev' },
	mercy: { type: 'string' },
	format: { type: 'string', default: 'gen9randombattle' },
	'accept-from': { type: 'string' },
	'max-battles': { type: 'string', default: '0' },
	search: { type: 'boolean', default: false },
	'allow-remote': { type: 'boolean', default: false },
	/** Fault injection for --provider mock-jev: clean | flaky. */
	'mock-profile': { type: 'string' },
	/** Challenge this user after login (and again after each battle with --rechallenge). */
	challenge: { type: 'string' },
	rechallenge: { type: 'boolean', default: false },
	/** Turn the battle timer on in each battle. */
	timer: { type: 'boolean', default: false },
	/** What to play when the battle timer would expire first: random | none. */
	'timer-fallback': { type: 'string', default: 'random' },
	'timer-margin': { type: 'string', default: '8' },
	'no-reconnect': { type: 'boolean', default: false },
	/** Comma-separated chat rooms to join so the bot shows in the user list (default: lobby). */
	join: { type: 'string', default: 'lobby' },
} });

// Why: connecting a bot to the official public server needs an explicit, separate decision
// (rules/etiquette); this CLI refuses non-local hosts unless deliberately overridden.
const host = new URL(a.url!).hostname;
if (!['localhost', '127.0.0.1', '::1'].includes(host) && !a['allow-remote']) {
	console.error(`refusing to connect to non-local server ${host} (pass --allow-remote for a self-hosted server you control)`);
	process.exit(1);
}
if (/pokemonshowdown\.com|psim\.us/.test(host)) { console.error('official servers are not allowed'); process.exit(1); }

const runId = `server-${new Date().toISOString().replace(/[:.]/g, '-')}-${a.name}`;
let budget: BudgetGuard | null = null;
let provider: DecisionProvider;
if (a.provider === 'jev') {
	budget = openBudget(runId);
	provider = jevFromEnv(budget, { label: 'jev' });
} else if (a.provider === 'mock-jev') {
	const mockBudget = new BudgetGuard(budgetConfigFromEnv(`runs/${runId}/mock-ledger.jsonl`), runId);
	provider = mockJev(mockBudget, { profile: a['mock-profile'] }).provider;
} else {
	provider = new RandomProvider();
}
if (a.mercy !== undefined) {
	const strength = Number(a.mercy);
	provider = new HandicapProvider(provider, { mode: strength > 0 ? 'mercy' : 'no-mercy', strength });
}

const client = new AutonomousClient({
	url: a.url!, username: a.name!, provider, formats: [a.format!], logDir: `runs/${runId}`,
	acceptFrom: a['accept-from']?.split(',').map(s => s.trim()).filter(Boolean),
	maxBattles: Number(a['max-battles']), search: a.search, budget,
	challenge: a.challenge ? { user: a.challenge, format: a.format! } : undefined, rechallenge: a.rechallenge,
	enableTimer: a.timer, joinRooms: a.join!.split(',').map(r => r.trim()).filter(Boolean), reconnect: a['no-reconnect'] ? false : undefined,
	// Why: losing on time is worse than an explicitly logged fallback move.
	timerFallback: a['timer-fallback'] === 'none' ? null : new RandomProvider(), timerMarginSeconds: Number(a['timer-margin']),
	expectedBattle: budget ? { requests: 80, costUsd: 80 * budget.config.maxCostPerRequestUsd } : undefined,
});
await client.connect();
console.log(`[${a.name}] ready on ${a.url} (provider ${provider.name}); challenge "${a.name}" to ${a.format}. logs: runs/${runId}`);
process.on('SIGINT', () => { client.close(); });
await client.finished;
if (budget) { console.log('[budget]', budget.snapshot); budget.release(); }
