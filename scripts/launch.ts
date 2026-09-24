// One-command launcher for the local Showdown setups.
//   node scripts/launch.ts spectate [--p1 mock-jev] [--p2 mock-jev-mercy] [--battles 3] [--timer]
//     local server on :8000 + two bots that challenge each other; watch at https://localhost.psim.us/
//   node scripts/launch.ts copilot [--provider mock-jev] [--opponent random|mock-jev|jev]
//     server on :8001 + Copilot proxy on :8000 + advice UI on :8010 + an opponent bot to challenge
// Player kinds: random | mock-jev | jev, with an optional `-mercy` suffix (strength --mercy-strength).
// Everything runs in ONE process so live JEV players share one budget lock and one rate limiter.
import { parseArgs } from 'node:util';
import { spawn, type ChildProcess } from 'node:child_process';
import { existsSync } from 'node:fs';
import { PLAYER_KINDS, baseKind, makeProvider, openBudget, openMockBudget } from '../src/config.ts';
import { RandomProvider } from '../src/decision/random.ts';
import { AutonomousClient } from '../src/server/client.ts';
import { startCopilot } from '../src/copilot/proxy.ts';
import { waitForServer } from '../src/server/wait.ts';

const { values: a, positionals } = parseArgs({
	allowPositionals: true,
	allowNegative: true,
	options: {
		p1: { type: 'string', default: 'mock-jev' },
		p2: { type: 'string', default: 'mock-jev' },
		provider: { type: 'string', default: 'mock-jev' },
		opponent: { type: 'string', default: 'random' },
		battles: { type: 'string', default: '1' },
		format: { type: 'string', default: 'gen9randombattle' },
		'mercy-strength': { type: 'string', default: '0.6' },
		'mock-profile': { type: 'string' },
		timer: { type: 'boolean', default: false },
		/** Keep the server up after the bots finish (to look around / watch replays). */
		'keep-server': { type: 'boolean', default: true },
	},
});
const mode = positionals[0];
if (mode !== 'spectate' && mode !== 'copilot') {
	console.error('usage: node scripts/launch.ts spectate|copilot [options] (see header comment)');
	process.exit(2);
}
if (!existsSync('vendor/pokemon-showdown/dist/server/index.js')) {
	console.error('local server not built: run `mise run server-setup` first');
	process.exit(1);
}

const runId = `${mode}-${new Date().toISOString().replace(/[:.]/g, '-')}`;
const logDir = `runs/${runId}`;
const kinds = mode === 'spectate' ? [a.p1!, a.p2!] : [a.provider!, a.opponent!];
for (const k of kinds) if (!PLAYER_KINDS.includes(baseKind(k))) { console.error(`unknown player kind ${k}`); process.exit(2); }

// Live spend goes through the project ledger (one lock for the whole process); mock never does.
const liveBudget = kinds.some(k => baseKind(k) === 'jev') ? openBudget(runId) : null;
const mockBudget = openMockBudget(logDir, runId);
let mockSeq = 0;
// Why: each mock-jev player gets its own gateway and seed; random/mercy stay unseeded here.
const playerFor = (kind: string, label: string) => makeProvider(kind, {
	liveBudget, mockBudget, label, mercyStrength: Number(a['mercy-strength']), mockProfile: a['mock-profile'],
	seed: part => part === 'mock' ? `sodium,${String(++mockSeq).padStart(32, '0')}` : undefined,
});

const children: ChildProcess[] = [];
const clients: AutonomousClient[] = [];
let copilot: { close(): void } | null = null;
function shutdown(code = 0) {
	for (const c of clients) c.close();
	copilot?.close();
	for (const c of children) c.kill();
	liveBudget?.release();
	mockBudget.release();
	process.exit(code);
}
// Why: without these, a signal or a crash leaves the server orphaned on its port.
for (const sig of ['SIGINT', 'SIGTERM', 'SIGHUP'] as const) process.on(sig, () => shutdown(0));
for (const ev of ['uncaughtException', 'unhandledRejection'] as const) {
	process.on(ev, err => { console.error(`[launch] fatal: ${(err as any)?.stack ?? err}`); shutdown(1); });
}
process.on('exit', () => { for (const c of children) c.kill(); });

async function startServer(port: number): Promise<void> {
	const server = spawn('node', ['pokemon-showdown', 'start', '--no-security', '--skip-build', String(port)], {
		cwd: 'vendor/pokemon-showdown', stdio: ['ignore', 'pipe', 'pipe'],
	});
	children.push(server);
	server.on('exit', code => { console.log(`[server] exited (${code})`); shutdown(1); });
	return new Promise<void>((resolve, reject) => {
		const t = setTimeout(() => reject(new Error('server did not start within 60s')), 60_000);
		server.stdout!.on('data', d => { if (String(d).includes('now listening')) { clearTimeout(t); resolve(); } });
		server.stderr!.on('data', d => process.stderr.write(`[server] ${d}`));
	}).then(() => waitForServer(port));
}

const expected = (liveSides: number) => liveBudget ? { requests: 80 * liveSides, costUsd: 80 * liveSides * liveBudget.config.maxCostPerRequestUsd } : undefined;
const common = {
	formats: [a.format!], logDir, enableTimer: a.timer,
	// Why: bots that are not in a chat room are invisible in the client's user list.
	joinRooms: ['lobby'],
	// Why: a slow JEV answer (rate limiting) must not lose on time; the fallback is logged.
	timerFallback: new RandomProvider(), budget: liveBudget,
	expectedBattle: expected(kinds.filter(k => baseKind(k) === 'jev').length),
};

if (mode === 'spectate') {
	await startServer(8000);
	const url = 'ws://127.0.0.1:8000/showdown/websocket';
	const battles = Number(a.battles);
	const [n1, n2] = ['JEV-Alpha', 'JEV-Beta'];
	const host = new AutonomousClient({ ...common, url, username: n2, provider: playerFor(a.p2!, `${a.p2}`), acceptFrom: [n1], maxBattles: battles });
	await host.connect();
	const guest = new AutonomousClient({
		...common, url, username: n1, provider: playerFor(a.p1!, `${a.p1}`), maxBattles: battles,
		challenge: { user: n2, format: a.format! }, rechallenge: true,
		onBattleStart: roomid => console.log(`[launch] watch: https://localhost.psim.us/${roomid}`),
	});
	clients.push(host, guest);
	await guest.connect();
	console.log(`[launch] ${n1} (${a.p1}) vs ${n2} (${a.p2}), ${battles} battle(s). Lobby: https://localhost.psim.us/ | logs: ${logDir}`);
	await Promise.all([host.finished, guest.finished]);
	const wins = guest.results.map(r => r.won === null ? 'tie' : r.won ? `${n1} (${a.p1})` : `${n2} (${a.p2})`);
	console.log(`[launch] done: ${wins.join(', ')}`);
	if (liveBudget) console.log('[budget]', liveBudget.snapshot);
	if (!a['keep-server']) shutdown(0);
	console.log('[launch] server still running for replays; Ctrl-C to stop');
} else {
	await startServer(8001);
	const opponent = new AutonomousClient({ ...common, url: 'ws://127.0.0.1:8001/showdown/websocket', username: 'JEV-Bot', provider: playerFor(a.opponent!, a.opponent!),
		// Why: humans usually press "Battle!" rather than challenging by name; support both.
		search: true });
	clients.push(opponent);
	await opponent.connect();
	copilot = startCopilot({
		listenPort: 8000, upstream: 'http://127.0.0.1:8001', uiPort: 8010, logDir,
		provider: playerFor(a.provider!, a.provider!), budgetInfo: () => (liveBudget ?? mockBudget).snapshot,
	});
	console.log(`[launch] Copilot ready. Open https://localhost.psim.us/, pick any name, choose "${a.format}" and press "Battle!"`);
	console.log(`[launch]   (or challenge "JEV-Bot" by name; it is listed in the Lobby). Opponent: JEV-Bot (${a.opponent}).`);
	console.log(`[launch] advice UI: http://127.0.0.1:8010/ (${a.provider}) | logs: ${logDir} | Ctrl-C to stop`);
}
