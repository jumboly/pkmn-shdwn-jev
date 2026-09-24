import { test } from 'node:test';
import assert from 'node:assert/strict';
import { runSimBattle } from '../src/sim/run-battle.ts';
import { RandomProvider } from '../src/decision/random.ts';
import { JsonlLog } from '../src/logging.ts';
import { Dex } from '../src/showdown/sim.ts';
import { seed } from './helpers.ts';

const play = (n: number) => {
	const log = new JsonlLog(null);
	return runSimBattle({
		battleId: `t${n}`, format: 'gen9randombattle', seed: seed(n), log,
		p1: { name: 'Alice', provider: new RandomProvider(seed(1000 + n)) },
		p2: { name: 'Bob', provider: new RandomProvider(seed(2000 + n)) },
	}).then(result => ({ result, log }));
};

test('random vs random battles finish with only legal commands', async () => {
	for (let n = 1; n <= 15; n++) {
		const { result, log } = await play(n);
		assert.notEqual(result.outcome, 'aborted', `battle ${n}: ${result.abortReason}`);
		assert.ok(result.turns > 0);
		assert.equal(log.events.filter(e => e.type === 'decision-error').length, 0);
	}
});

test('same seeds reproduce the same battle', async () => {
	const a = await play(7);
	const b = await play(7);
	assert.deepEqual(a.result.inputLog, b.result.inputLog);
	assert.equal(a.result.winner, b.result.winner);
});

test('information boundary: decision state never contains unrevealed opponent info', async () => {
	for (let n = 20; n < 26; n++) {
		const { result, log } = await play(n);
		const end = log.events.find(e => e.type === 'battle-end') as any;
		const spectatorLines = result.spectatorLog.split('\n');
		for (const e of log.events.filter(e => e.type === 'decision') as any[]) {
			const me = e.side as 'p1' | 'p2';
			const opp = me === 'p1' ? 'p2' : 'p1';
			const oppTeam: any[] = end.teams[opp];
			for (const o of e.state.opponent.pokemon) {
				const set = oppTeam.find(s => (s.name ?? s.species) === o.ident.slice(4));
				assert.ok(set, `unknown opponent ${o.ident}`);
				// Only revealed moves may appear.
				for (const m of o.revealedMoves) {
					assert.ok(spectatorLines.some(l => l.startsWith(`|move|${opp}a: ${o.ident.slice(4)}|${m}|`)), `move ${m} never shown`);
				}
				assert.ok(!('stats' in o), 'opponent stats leaked');
				assert.ok(!('teraType' in o), 'opponent tera type leaked');
				assert.ok(o.hpPercent >= 0 && o.hpPercent <= 100);
				if (o.revealedItem) {
					const item = Dex.items.get(o.revealedItem).name;
					assert.ok(result.spectatorLog.includes(item), `item ${item} never shown`);
				}
			}
			// Opponent mons that never switched in must be absent.
			const seen = new Set(spectatorLines.filter(l => /^\|(switch|drag|replace)\|/.test(l) && l.split('|')[2].startsWith(opp)).map(l => l.split('|')[2].slice(5)));
			for (const o of e.state.opponent.pokemon) assert.ok(seen.has(o.ident.slice(4)));
			// Own side comes from our own request only.
			assert.deepEqual(e.state.self.pokemon.map((p: any) => p.ident), e.request.side.pokemon.map((p: any) => p.ident));
			assert.ok(e.state.self.pokemon.every((p: any) => p.ident.startsWith(me)));
		}
	}
});
