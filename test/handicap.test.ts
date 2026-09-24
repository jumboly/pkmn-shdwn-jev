import { test } from 'node:test';
import assert from 'node:assert/strict';
import { applyHandicap, battleAdvantage, HandicapProvider, mercyLevel } from '../src/decision/handicap.ts';
import { PRNG } from '../src/showdown/sim.ts';

const own = (hp: number, fainted = false) => ({ ident: 'p1: X', species: 'X', level: 80, hp, maxhp: 100, fainted, active: false, types: [], stats: {}, ability: '', item: '', moves: [], boosts: {}, volatiles: [] });
const foe = (hp: number, fainted = false) => ({ ident: 'p2: Y', species: 'Y', level: 80, hpPercent: hp, fainted, active: false, types: [], possibleAbilities: [], baseStats: {}, revealedAbility: null, revealedItem: null, itemGone: false, revealedMoves: [], boosts: {}, volatiles: [] });
const state = (self: any[], opp: any[], teamSize = 6) => ({
	perspective: 'p1', format: '', gen: 9, turn: 10,
	self: { name: 'a', pokemon: self, sideConditions: [] },
	opponent: { name: 'b', teamSize, pokemon: opp, sideConditions: [] },
	field: { weather: null, terrain: null, pseudoWeather: [] }, recentEvents: [],
}) as any;
const choices = ['a', 'b', 'c', 'd'].map(id => ({ id, command: id, kind: 'move', label: id })) as any;
const decision = { choiceId: 'a', provider: 'jev', scores: { a: 0.4, b: 0.3, c: 0.2, d: 0.01 } };

test('advantage: even start is 0; unrevealed foes count as healthy', () => {
	const even = battleAdvantage(state(Array.from({ length: 6 }, () => own(100)), [foe(100)]));
	assert.equal(even.value, 0);
	const ahead = battleAdvantage(state(Array.from({ length: 6 }, () => own(100)), [foe(0, true), foe(0, true), foe(0, true), foe(20)]));
	assert.ok(ahead.value > 0.4 && ahead.oppRemaining === 3, JSON.stringify(ahead));
	const behind = battleAdvantage(state([own(100), own(0, true), own(0, true), own(0, true), own(0, true), own(0, true)], [foe(100)]));
	assert.ok(behind.value < -0.5);
});

test('mercy level scales with advantage and strength; zero when even/behind or no-mercy', () => {
	assert.equal(mercyLevel(0.1, { mode: 'mercy', strength: 1 }), 0);
	assert.equal(mercyLevel(-0.5, { mode: 'mercy', strength: 1 }), 0);
	assert.equal(mercyLevel(0.9, { mode: 'no-mercy', strength: 1 }), 0);
	assert.ok(mercyLevel(0.3, { mode: 'mercy', strength: 1 }) < mercyLevel(0.6, { mode: 'mercy', strength: 1 }));
	assert.equal(mercyLevel(0.9, { mode: 'mercy', strength: 0.5 }), 0.5);
});

test('no-mercy is a pass-through', () => {
	const s = state(Array.from({ length: 6 }, () => own(100)), [foe(0, true), foe(0, true), foe(0, true), foe(0, true), foe(10)]);
	const r = applyHandicap(decision, { battleId: '', side: 'p1', state: s, choices }, { mode: 'no-mercy', strength: 1 }, new PRNG());
	assert.equal(r.finalChoiceId, 'a');
	assert.equal(r.changed, false);
});

test('mercy only deviates to choices JEV rated plausibly, and only when ahead', () => {
	const winning = state(Array.from({ length: 6 }, () => own(100)), [foe(0, true), foe(0, true), foe(0, true), foe(0, true), foe(10)]);
	const prng = new PRNG('sodium,00000000000000000000000000000001' as any);
	const picks = new Map<string, number>();
	for (let i = 0; i < 400; i++) {
		const r = applyHandicap(decision, { battleId: '', side: 'p1', state: winning, choices }, { mode: 'mercy', strength: 1 }, prng);
		picks.set(r.finalChoiceId, (picks.get(r.finalChoiceId) ?? 0) + 1);
		assert.ok(r.mercyLevel > 0.9);
	}
	assert.ok(!picks.has('d'), 'never picks a choice JEV rated implausible');
	assert.ok((picks.get('b') ?? 0) > 0 && (picks.get('a') ?? 0) > 0);

	const even = state(Array.from({ length: 6 }, () => own(100)), [foe(100)]);
	for (let i = 0; i < 50; i++) {
		assert.equal(applyHandicap(decision, { battleId: '', side: 'p1', state: even, choices }, { mode: 'mercy', strength: 1 }, prng).finalChoiceId, 'a');
	}
});

test('HandicapProvider records original and final choice; leaves fallbacks untouched', async () => {
	const winning = state(Array.from({ length: 6 }, () => own(100)), [foe(0, true), foe(0, true), foe(0, true), foe(0, true), foe(10)]);
	const p = new HandicapProvider({ name: 'jev', decide: async () => decision }, { mode: 'mercy', strength: 1 });
	const d = await p.decide({ battleId: '', side: 'p1', state: winning, choices });
	assert.equal(d.handicap?.originalChoiceId, 'a');
	assert.equal(d.handicap?.changed, d.choiceId !== 'a');
	const fb = new HandicapProvider({ name: 'jev', decide: async () => ({ ...decision, fallback: { from: 'jev', reason: 'x' } }) }, { mode: 'mercy', strength: 1 });
	assert.equal((await fb.decide({ battleId: '', side: 'p1', state: winning, choices })).handicap, undefined);
});
