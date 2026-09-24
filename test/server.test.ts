import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawn } from 'node:child_process';
import { AutonomousClient } from '../src/server/client.ts';
import { waitForServer } from '../src/server/wait.ts';
import { RandomProvider } from '../src/decision/random.ts';
import { seed, tempLedger } from './helpers.ts';
import { startCopilot } from '../src/copilot/proxy.ts';
import { JevProvider } from '../src/decision/jev.ts';
import { createMockGatewayFetch, mockProfile } from '../src/decision/mock-gateway.ts';
import { legalChoices } from '../src/showdown/choices.ts';

const SERVER_DIR = 'vendor/pokemon-showdown';
const built = existsSync(join(SERVER_DIR, 'dist/server/index.js'));

async function startServer(port: number) {
	const server = spawn('node', ['pokemon-showdown', 'start', '--no-security', '--skip-build', String(port)], {
		cwd: SERVER_DIR, stdio: ['ignore', 'pipe', 'pipe'],
	});
	await new Promise<void>((resolve, reject) => {
		const t = setTimeout(() => reject(new Error('server did not start')), 60_000);
		server.stdout.on('data', d => { if (String(d).includes('now listening')) { clearTimeout(t); resolve(); } });
	});
	await waitForServer(port);
	return server;
}

// Integration test against a real local Showdown server (skipped until `mise run server-setup`).
test('two autonomous clients play a full battle on a local server', { skip: !built && 'vendored server not built', timeout: 120_000 }, async () => {
	const port = 18000 + Math.floor(Math.random() * 1000);
	const server = await startServer(port);
	try {
		const url = `ws://127.0.0.1:${port}/showdown/websocket`;
		const logDir = mkdtempSync(join(tmpdir(), 'ps-server-'));
		const common = { url, formats: ['gen9randombattle'], logDir, maxBattles: 1, quiet: true };
		const a = new AutonomousClient({ ...common, username: 'BotAlpha', provider: new RandomProvider(seed(1)) });
		const b = new AutonomousClient({ ...common, username: 'BotBeta', provider: new RandomProvider(seed(2)) });
		await b.connect();
		await a.connect();
		(a as any).send('|/challenge BotBeta, gen9randombattle');
		await Promise.all([a.finished, b.finished]);
		assert.equal(a.results.length, 1);
		assert.equal(a.results[0].roomid, b.results[0].roomid);
		assert.equal(a.results[0].winner, b.results[0].winner);
		assert.ok(a.results[0].turns > 0);
		assert.notEqual(a.results[0].won, b.results[0].won);
		const events = readFileSync(join(logDir, `${a.results[0].roomid}.jsonl`), 'utf8').trim().split('\n').map(l => JSON.parse(l));
		assert.ok(events.filter(e => e.type === 'decision').length > 0);
		assert.equal(events.filter(e => e.type === 'decision-error').length, 0);
		// Player-channel logs must be split-resolved (safe for replay).
		assert.ok(!readFileSync(join(logDir, `${a.results[0].roomid}.player.log`), 'utf8').includes('|split|'));
	} finally {
		server.kill();
	}
});

test('copilot proxy advises the human and never sends choices itself', { skip: !built && 'vendored server not built', timeout: 120_000 }, async () => {
	const port = 19000 + Math.floor(Math.random() * 500);
	const server = await startServer(port);
	const logDir = mkdtempSync(join(tmpdir(), 'copilot-'));
	const mock = createMockGatewayFetch();
	const { guard } = tempLedger();
	const copilot = startCopilot({
		listenPort: port + 1000, upstream: `http://127.0.0.1:${port}`, uiPort: port + 2000, logDir,
		provider: new JevProvider({ apiKey: 'mock', model: 'mock/jev', budget: guard, fetch: mock.fetch, label: 'mock-jev' }),
	});
	try {
		const bot = new AutonomousClient({ url: `ws://127.0.0.1:${port}/showdown/websocket`, username: 'CopilotFoe', provider: new RandomProvider(seed(3)), formats: ['gen9randombattle'], logDir, maxBattles: 1, quiet: true });
		await bot.connect();
		// A scripted "human" connected through the proxy; it always picks its first legal choice.
		const human = new WebSocket(`ws://127.0.0.1:${port + 1000}/showdown/websocket`);
		let humanChooses = 0;
		let inlineBoxes = 0;
		await new Promise<void>((resolve) => {
			human.onmessage = e => {
				const text = String(e.data);
				if (/^>battle-\S+\n\|uhtml(change)?\|jevcopilot-/.test(text)) inlineBoxes++;
				if (text.includes('|challstr|')) human.send('|/trn CopilotHuman');
				if (/\|updateuser\| ?CopilotHuman/.test(text)) { human.send('|/utm null'); human.send('|/challenge CopilotFoe, gen9randombattle'); }
				const room = text.startsWith('>battle-') ? text.split('\n')[0].slice(1) : '';
				for (const line of text.split('\n')) {
					if (line.startsWith('|request|') && line.length > 9) {
						const req = JSON.parse(line.slice(9));
						if (req.wait) continue;
						const c = legalChoices(req)[0];
						setTimeout(() => { humanChooses++; human.send(`${room}|/choose ${c.command}|${req.rqid}`); }, 250);
					}
					if (line.startsWith('|win|') || line === '|tie') resolve();
				}
			};
		});
		human.close();
		await bot.finished;
		const events = readFileSync(join(logDir, 'copilot.jsonl'), 'utf8').trim().split('\n').map(l => JSON.parse(l));
		const advice = events.filter(e => e.type === 'copilot-advice');
		const choices = events.filter(e => e.type === 'copilot-human-choice');
		assert.ok(advice.length > 0);
		// In-battle advice reached the human's own client (thinking box + its update per turn).
		assert.ok(inlineBoxes >= advice.length, `inline boxes ${inlineBoxes} < advice ${advice.length}`);
		assert.equal(choices.length, humanChooses, 'every human /choose is observed exactly once');
		assert.ok(choices.every(c => c.humanChoiceId !== null && typeof c.matchesJev === 'boolean'));
		// One JEV call per advice; the proxy has no code path that sends frames of its own
		// (it only forwards client frames), so the human's /choose count above is the total.
		assert.equal(mock.calls.length, advice.length);
		// Information boundary: advice state is the human's own view.
		assert.ok(advice.every(a => a.state.self.pokemon.every((p: any) => p.ident.startsWith(a.side))));
	} finally {
		copilot.close();
		server.kill();
	}
});

test('a dropped connection mid-battle reconnects and the battle still finishes', { skip: !built && 'vendored server not built', timeout: 180_000 }, async () => {
	const port = 19600 + Math.floor(Math.random() * 300);
	const server = await startServer(port);
	try {
		const url = `ws://127.0.0.1:${port}/showdown/websocket`;
		const logDir = mkdtempSync(join(tmpdir(), 'ps-reconnect-'));
		const { guard } = tempLedger();
		// Why: the flaky mock adds latency and retries, so decisions are in flight when we drop.
		const flaky = createMockGatewayFetch({ faults: mockProfile('flaky') });
		const jev = new JevProvider({ apiKey: 'mock', model: 'mock/jev', budget: guard, fetch: flaky.fetch, label: 'mock-jev' });
		const common = { url, formats: ['gen9randombattle'], logDir, maxBattles: 1, quiet: true, reconnect: { baseDelayMs: 200 } };
		const a = new AutonomousClient({ ...common, username: 'DropAlpha', provider: jev });
		const b = new AutonomousClient({ ...common, username: 'DropBeta', provider: new RandomProvider(seed(4)) });
		await b.connect();
		await a.connect();
		(a as any).send('|/challenge DropBeta, gen9randombattle');
		// Drop twice at different points of the battle.
		let drops = 0;
		const iv = setInterval(() => {
			const room = [...(a as any).rooms.values()][0];
			if (room && !room.closed && room.observer.turn >= 2 + 3 * drops && drops < 2) { drops++; a.dropConnection(); }
		}, 50);
		await Promise.all([a.finished, b.finished]);
		clearInterval(iv);
		assert.equal(drops, 2);
		assert.equal(a.results.length, 1);
		assert.equal(a.results[0].winner, b.results[0].winner);
		const roomid = a.results[0].roomid;
		const events = readFileSync(join(logDir, `${roomid}.jsonl`), 'utf8').trim().split('\n').map(l => JSON.parse(l));
		assert.equal(events.filter(e => e.type === 'decision-error').length, 0);
		assert.ok(events.filter(e => e.type === 'rejoined').length >= 1);
		const client = readFileSync(join(logDir, 'client-dropalpha.jsonl'), 'utf8');
		assert.match(client, /"reconnected"/);
		// Nobody forfeited: the battle ended by knockouts, not by a disconnect or /forfeit.
		const log = readFileSync(join(logDir, `${roomid}.player.log`), 'utf8');
		assert.doesNotMatch(log, /forfeited/);
	} finally {
		server.kill();
	}
});

test('ladder search: a searching bot is matched from "Battle!" and re-queues after each game', { skip: !built && 'vendored server not built', timeout: 180_000 }, async () => {
	const port = 20600 + Math.floor(Math.random() * 300);
	const server = await startServer(port);
	try {
		const url = `ws://127.0.0.1:${port}/showdown/websocket`;
		const logDir = mkdtempSync(join(tmpdir(), 'ps-search-'));
		const common = { url, formats: ['gen9randombattle'], logDir, maxBattles: 2, quiet: true, search: true };
		const bot = new AutonomousClient({ ...common, username: 'LadderBot', provider: new RandomProvider(seed(5)), joinRooms: ['lobby'] });
		const human = new AutonomousClient({ ...common, username: 'LadderHuman', provider: new RandomProvider(seed(6)) });
		await bot.connect();
		// The bot must be visible in the lobby user list (what a human sees on the home screen).
		const inLobby = await new Promise<boolean>(resolve => {
			const probe = new WebSocket(url);
			probe.onmessage = e => {
				const t = String(e.data);
				if (t.includes('|challstr|')) probe.send('|/trn LadderProbe');
				if (/\|updateuser\| ?LadderProbe/.test(t)) probe.send('|/cmd userdetails ladderbot');
				const m = /\|queryresponse\|userdetails\|(.*)/.exec(t);
				if (m) { probe.close(); resolve('lobby' in (JSON.parse(m[1]).rooms ?? {})); }
			};
		});
		assert.ok(inLobby, 'bot joined the lobby');
		await human.connect();
		await Promise.all([bot.finished, human.finished]);
		assert.equal(bot.results.length, 2);
		assert.deepEqual(bot.results.map(r => r.roomid), human.results.map(r => r.roomid));
	} finally {
		server.kill();
	}
});
