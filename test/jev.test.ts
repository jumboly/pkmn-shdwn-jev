import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { JevProvider, buildEvaluateBody } from '../src/decision/jev.ts';
import { createMockGatewayFetch, mockProfile } from '../src/decision/mock-gateway.ts';
import { RandomProvider } from '../src/decision/random.ts';
import { BudgetExceededError } from '../src/budget.ts';
import { runSimBattle } from '../src/sim/run-battle.ts';
import { JsonlLog } from '../src/logging.ts';
import { seed, tempLedger } from './helpers.ts';
import { AdaptiveRateLimiter } from '../src/decision/rate-limiter.ts';

const ctx = () => ({
	battleId: 'b', side: 'p1' as const,
	state: {
		perspective: 'p1' as const, format: '[Gen 9] Random Battle', gen: 9, turn: 3,
		self: { name: 'A', pokemon: [], sideConditions: [] },
		opponent: { name: 'B', teamSize: 6, pokemon: [], sideConditions: [] },
		field: { weather: null, terrain: null, pseudoWeather: [] }, recentEvents: ['|move|p2a: X|Tackle|p1a: Y'],
	},
	choices: [
		{ id: 'move-1', command: 'move 1', kind: 'move' as const, label: 'Tackle', move: { name: 'Tackle', type: 'Normal', category: 'Physical', basePower: 40, accuracy: 100 as const, priority: 0 } },
		{ id: 'switch-2', command: 'switch 2', kind: 'switch' as const, label: 'Switch to Mew', switchTo: { slot: 2, species: 'Mew', hp: '100/100' } },
	],
});
const noSleep = async () => {};
const provider = (fetchImpl: typeof fetch, guard: any, extra = {}) =>
	new JevProvider({ apiKey: 'test-key-123', model: 'typesafe-ai/jev', budget: guard, fetch: fetchImpl, sleep: noSleep, rateLimiter: new AdaptiveRateLimiter({ sleep: noSleep }), ...extra });

test('payload: choice question keyed by legal choice ids, deterministic facts in criteria', () => {
	const body = buildEvaluateBody('typesafe-ai/jev', ctx(), 40);
	assert.deepEqual(Object.keys(body.questions.action.criteria), ['move-1', 'switch-2']);
	assert.match(body.questions.action.criteria['move-1'], /Normal, Physical, 40 base power, 100% accuracy/);
	assert.equal(body.model, 'typesafe-ai/jev');
});

test('mock JEV: decision, probabilities and cost are recorded in the ledger', async () => {
	const { guard, config } = tempLedger();
	const mock = createMockGatewayFetch();
	const d = await provider(mock.fetch, guard).decide(ctx());
	assert.ok(['move-1', 'switch-2'].includes(d.choiceId));
	assert.ok(d.scores && Object.keys(d.scores).length === 2);
	assert.equal(d.usage?.requests, 1);
	assert.ok(d.usage!.costUsd > 0 && !d.usage!.costEstimated);
	const ledger = readFileSync(config.ledgerPath, 'utf8').trim().split('\n').map(l => JSON.parse(l));
	assert.equal(ledger.length, 1);
	assert.equal(ledger[0].generationId, 'gen_mock_1');
	assert.ok(!readFileSync(config.ledgerPath, 'utf8').includes('test-key-123'));
});

test('budget guard blocks before any request is sent', async () => {
	const { guard } = tempLedger({ stopThresholdUsd: 0.005, maxCostPerRequestUsd: 0.01 });
	const mock = createMockGatewayFetch();
	await assert.rejects(provider(mock.fetch, guard).decide(ctx()), BudgetExceededError);
	assert.equal(mock.calls.length, 0);
});

test('429 is retried, 400 is not, 402 becomes a budget stop', async () => {
	const { guard } = tempLedger();
	const retry = createMockGatewayFetch({ fail: n => (n === 1 ? 429 : null) });
	const d = await provider(retry.fetch, guard).decide(ctx());
	assert.equal(d.usage?.requests, 2);

	const bad = createMockGatewayFetch({ fail: () => 400 });
	await assert.rejects(provider(bad.fetch, guard).decide(ctx()), /gateway 400/);
	assert.equal(bad.calls.length, 1);

	const quota = createMockGatewayFetch({ fail: () => 402 });
	await assert.rejects(provider(quota.fetch, guard).decide(ctx()), BudgetExceededError);
});

test('invalid answers are never turned into commands', async () => {
	const { guard } = tempLedger();
	const f = (async () => new Response(JSON.stringify({ answers: { action: { type: 'choice', choice: 'move 1' } }, providerMetadata: { gateway: { cost: '0' } } }))) as typeof fetch;
	await assert.rejects(provider(f, guard, { maxAttempts: 2 }).decide(ctx()), /invalid JEV answer/);
});

test('fallback is explicit and flagged', async () => {
	const { guard } = tempLedger();
	const bad = createMockGatewayFetch({ fail: () => 400 });
	const d = await provider(bad.fetch, guard, { fallback: new RandomProvider(seed(1)) }).decide(ctx());
	assert.equal(d.provider, 'random');
	assert.equal(d.fallback?.from, 'jev:typesafe-ai/jev');
});

test('oversized payload is rejected locally after trimming events', async () => {
	const { guard } = tempLedger();
	const mock = createMockGatewayFetch();
	const c = ctx();
	c.state.recentEvents = Array.from({ length: 200 }, (_, i) => `|-message|${'x'.repeat(500)}${i}`);
	const d = await provider(mock.fetch, guard, { maxPayloadBytes: 8000 }).decide(c);
	assert.ok(mock.calls[0].bytes <= 8000);
	assert.ok((d.raw as any).recentEventsSent < 40);
	await assert.rejects(provider(mock.fetch, guard, { maxPayloadBytes: 100 }).decide(c), /exceeds limit/);
});

test('mock JEV vs random: full battle through the real pipeline', async () => {
	const { guard } = tempLedger();
	const mock = createMockGatewayFetch();
	const log = new JsonlLog(null);
	const r = await runSimBattle({
		battleId: 'mj', format: 'gen9randombattle', seed: seed(42), log,
		p1: { name: 'JEV', provider: provider(mock.fetch, guard) },
		p2: { name: 'Rand', provider: new RandomProvider(seed(43)) },
	});
	assert.notEqual(r.outcome, 'aborted');
	assert.equal(guard.snapshot.requestsExperiment, mock.calls.length);
	assert.ok(Math.max(...mock.calls.map(c => c.bytes)) < 24000);
	// The API key must never reach logs.
	assert.ok(!JSON.stringify(log.events).includes('test-key-123'));
});

test('criteria include type-chart multiplier vs the visible active foe', () => {
	const c = ctx();
	c.state.opponent.pokemon = [{ ident: 'p2: Gengar', species: 'Gengar', level: 80, hpPercent: 100, fainted: false, active: true, types: ['Ghost', 'Poison'], possibleAbilities: [], baseStats: {}, revealedAbility: null, revealedItem: null, itemGone: false, revealedMoves: [], boosts: {}, volatiles: [] }] as any;
	const body = buildEvaluateBody('m', c, 40);
	assert.match(body.questions.action.criteria['move-1'], /vs Gengar: x0/);
});

test('undefined options do not erase safety defaults', async () => {
	const { guard } = tempLedger();
	const mock = createMockGatewayFetch();
	const c = ctx();
	c.state.recentEvents = Array.from({ length: 40 }, (_, i) => `|-message|${'x'.repeat(2000)}${i}`);
	const d = await provider(mock.fetch, guard, { maxPayloadBytes: undefined, maxAttempts: undefined }).decide(c);
	assert.ok(mock.calls[0].bytes <= 24000);
	assert.ok(d.choiceId);
});

test('flaky mock profile exercises every retry path and still yields legal decisions', async () => {
	const { guard } = tempLedger();
	// Why: high rates so a handful of decisions is guaranteed to hit each fault kind.
	const mock = createMockGatewayFetch({ faults: { networkRate: 0.15, rate429: 0.2, rate503: 0.2, invalidAnswerRate: 0.15 } });
	const p = provider(mock.fetch, guard, { maxAttempts: 20 });
	for (let i = 0; i < 20; i++) {
		const c = ctx();
		const d = await p.decide(c);
		assert.ok(c.choices.some(ch => ch.id === d.choiceId));
	}
	for (const k of ['network', 'http429', 'http503', 'invalidAnswer'] as const) assert.ok(mock.stats[k] > 0, k);
});

test('mock profiles: clean injects nothing, unknown names are rejected', () => {
	assert.deepEqual(mockProfile(undefined), {});
	assert.ok(mockProfile('flaky').rate429! > 0);
	assert.throws(() => mockProfile('nope'), /unknown mock profile/);
});
