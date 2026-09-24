import { test } from 'node:test';
import assert from 'node:assert/strict';
import { BudgetExceededError, BudgetGuard, budgetConfigFromEnv } from '../src/budget.ts';
import { tempLedger } from './helpers.ts';

test('blocks a request that could cross the stop threshold', () => {
	const { guard } = tempLedger({ stopThresholdUsd: 0.025, maxCostPerRequestUsd: 0.01 });
	const a = guard.reserve();
	const b = guard.reserve();
	// 2 in flight * 0.01 + next 0.01 = 0.03 > 0.025
	assert.throws(() => guard.reserve(), BudgetExceededError);
	guard.settle(a, { status: 'ok', reportedCostUsd: 0.001, sent: true });
	guard.settle(b, { status: 'ok', reportedCostUsd: 0.001, sent: true });
	assert.equal(guard.snapshot.spentTotalUsd, 0.002);
	guard.reserve(); // 0.002 + 0.01 <= 0.025
});

test('unreported cost is booked at the reservation (pessimistic)', () => {
	const { guard } = tempLedger();
	const r = guard.reserve();
	const e = guard.settle(r, { status: 'error', reportedCostUsd: null, sent: true });
	assert.equal(e.costUsd, 0.01);
	assert.equal(e.costEstimated, true);
});

test('ledger persists across experiments', () => {
	const { guard, config } = tempLedger();
	guard.settle(guard.reserve(), { status: 'ok', reportedCostUsd: 1.25, sent: true });
	const again = new BudgetGuard(config, 'second');
	assert.equal(again.snapshot.spentTotalUsd, 1.25);
	assert.equal(again.snapshot.requestsTotal, 1);
	assert.equal(again.snapshot.spentExperimentUsd, 0);
});

test('per-experiment request cap and new-battle headroom', () => {
	const { guard } = tempLedger({ maxRequests: 2 });
	guard.settle(guard.reserve(), { status: 'ok', reportedCostUsd: 0, sent: true });
	guard.settle(guard.reserve(), { status: 'ok', reportedCostUsd: 0, sent: true });
	assert.match(guard.checkRequest()!, /request cap/);
	const { guard: g2 } = tempLedger({ stopThresholdUsd: 0.5, maxCostPerRequestUsd: 0.01 });
	assert.equal(g2.checkNewBattle({ requests: 40, costUsd: 0.4 }), null);
	assert.match(g2.checkNewBattle({ requests: 60, costUsd: 0.6 })!, /headroom/);
});

test('env config validation', () => {
	assert.throws(() => budgetConfigFromEnv('x', { EXPERIMENT_BUDGET_USD: '5', EXPERIMENT_STOP_THRESHOLD_USD: '5' }));
	const c = budgetConfigFromEnv('x', {});
	assert.equal(c.budgetUsd, 5);
	assert.equal(c.stopThresholdUsd, 4.5);
});

test('promotional zero cost is budgeted at market cost', () => {
	const { guard } = tempLedger();
	const e = guard.settle(guard.reserve(), { status: 'ok', reportedCostUsd: 0, marketCostUsd: 0.0000916, sent: true });
	assert.equal(e.costUsd, 0.0000916);
	assert.equal(guard.snapshot.spentTotalUsd, 0.0000916);
});
