import { test } from 'node:test';
import assert from 'node:assert/strict';
import { jevFromEnv, openBudget } from '../src/config.ts';
import { sampleContext } from '../scripts/sample-context.ts';

// Why: paid API. Runs only with RUN_LIVE_JEV_TESTS=1 and always through the project ledger.
const live = process.env.RUN_LIVE_JEV_TESTS === '1' && !!process.env.AI_GATEWAY_API_KEY;

test('live JEV: one budget-guarded decision', { skip: !live && 'set RUN_LIVE_JEV_TESTS=1 (costs money)' }, async () => {
	const budget = openBudget(`live-test-${new Date().toISOString()}`);
	try {
		const ctx = await sampleContext();
		const d = await jevFromEnv(budget, { label: 'jev' }).decide(ctx);
		assert.ok(ctx.choices.some(c => c.id === d.choiceId));
		assert.ok(d.scores && Object.keys(d.scores).length === ctx.choices.length);
		assert.equal(budget.snapshot.requestsExperiment, d.usage?.requests);
	} finally {
		budget.release();
	}
});
