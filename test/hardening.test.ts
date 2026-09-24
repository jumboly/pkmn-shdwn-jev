import { test } from 'node:test';
import assert from 'node:assert/strict';
import { decideWithDeadline } from '../src/server/deadline.ts';
import { BattleRoomObserver } from '../src/server/room.ts';
import type { DecisionProvider } from '../src/decision/types.ts';

const ctx = { battleId: 'b', side: 'p1' as const, state: {} as any, choices: [{ id: 'move-1' }, { id: 'move-2' }] as any };
const slow = (ms: number, choiceId = 'move-1'): DecisionProvider => ({
	name: 'slow', decide: () => new Promise(r => setTimeout(() => r({ choiceId, provider: 'slow' }), ms)),
});
const fixed = (choiceId: string): DecisionProvider => ({ name: 'fallback', decide: async () => ({ choiceId, provider: 'fallback' }) });

test('deadline: a fast primary is used as-is', async () => {
	const r = await decideWithDeadline(slow(5), ctx, 200, fixed('move-2'));
	assert.equal(r.timedOut, false);
	assert.equal(r.decision.choiceId, 'move-1');
	assert.equal(r.decision.fallback, undefined);
});

test('deadline: a slow primary is replaced by an explicitly flagged fallback', async () => {
	const r = await decideWithDeadline(slow(300), ctx, 20, fixed('move-2'));
	assert.equal(r.timedOut, true);
	assert.equal(r.decision.choiceId, 'move-2');
	assert.equal(r.decision.fallback?.from, 'slow');
	assert.match(r.decision.fallback!.reason, /battle timer/);
	// The late primary answer is still observable for logging.
	assert.equal(((await r.primary) as any).choiceId, 'move-1');
});

test('deadline: no timer or no fallback means waiting for the primary', async () => {
	assert.equal((await decideWithDeadline(slow(30), ctx, null, fixed('move-2'))).decision.choiceId, 'move-1');
	assert.equal((await decideWithDeadline(slow(30), ctx, 1, null)).decision.choiceId, 'move-1');
});

test('deadline: primary errors propagate (no silent fallback)', async () => {
	const failing: DecisionProvider = { name: 'x', decide: async () => { throw new Error('boom'); } };
	await assert.rejects(decideWithDeadline(failing, ctx, 1000, fixed('move-2')), /boom/);
});

const request = (rqid: number) => `|request|${JSON.stringify({ rqid, side: { id: 'p1', name: 'Bot', pokemon: [] }, active: [{ moves: [{ move: 'Tackle', id: 'tackle', pp: 35, maxpp: 35, target: 'normal' }] }] })}`;

test('observer: reads the battle timer and counts it down', () => {
	let t = 1_000_000;
	const o = new BattleRoomObserver('battle-x', 'Bot', () => {}, 1, () => t);
	o.feed(['|player|p1|Bot|', '|inactive|Time left: 150 sec this turn | 280 sec total']);
	assert.equal(o.secondsLeft(), 150);
	t += 10_000;
	assert.equal(o.secondsLeft(), 140);
	o.feed(['|inactive|Time left: 60 sec this turn | 40 sec total']);
	assert.equal(o.secondsLeft(), 40, 'the smaller of turn/total wins');
	o.feed(['|inactiveoff|Battle timer is now OFF.']);
	assert.equal(o.secondsLeft(), null);
});

test('observer: a re-sent request with |sentchoice| is not answered again', async () => {
	const decided: number[] = [];
	const o = new BattleRoomObserver('battle-x', 'Bot', d => decided.push(d.request.rqid!), 1);
	o.feed(['|player|p1|Bot|', '|gen|9', request(3), '|sentchoice|move 1']);
	await new Promise(r => setTimeout(r, 20));
	assert.deepEqual(decided, []);
	o.feed([request(4)]);
	await new Promise(r => setTimeout(r, 20));
	assert.deepEqual(decided, [4]);
});

test('observer: invalid-choice retries are capped per request', async () => {
	const decided: number[] = [];
	const o = new BattleRoomObserver('battle-x', 'Bot', d => decided.push(d.request.rqid!), 1);
	o.feed(['|player|p1|Bot|', '|gen|9', request(5)]);
	await new Promise(r => setTimeout(r, 10));
	const results = [o.retry(2), o.retry(2), o.retry(2)];
	assert.deepEqual(results, [true, true, false]);
});
