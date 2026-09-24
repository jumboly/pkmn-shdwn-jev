import { BudgetGuard, budgetConfigFromEnv } from './budget.ts';
import { JevProvider } from './decision/jev.ts';
import type { DecisionProvider } from './decision/types.ts';
import { createMockGatewayFetch, mockProfile } from './decision/mock-gateway.ts';

export const LEDGER_PATH = process.env.JEV_LEDGER_PATH || 'runs/jev-cost-ledger.jsonl';

export function openBudget(experimentId: string) {
	const guard = new BudgetGuard(budgetConfigFromEnv(LEDGER_PATH), experimentId);
	const s = guard.snapshot;
	console.log(`[budget] hard cap $${s.budgetUsd} | stop at $${s.stopThresholdUsd} | spent so far $${s.spentTotalUsd} over ${s.requestsTotal} requests | worst-case/request $${guard.config.maxCostPerRequestUsd}`);
	return guard;
}

export function jevFromEnv(budget: BudgetGuard, extra: { fallback?: DecisionProvider, label?: string } = {}) {
	return new JevProvider({
		apiKey: process.env.AI_GATEWAY_API_KEY ?? '',
		model: process.env.JEV_MODEL || 'typesafe-ai/jev',
		budget,
		maxPayloadBytes: process.env.JEV_MAX_PAYLOAD_BYTES ? Number(process.env.JEV_MAX_PAYLOAD_BYTES) : undefined,
		maxAttempts: process.env.JEV_MAX_ATTEMPTS ? Number(process.env.JEV_MAX_ATTEMPTS) : undefined,
		...extra,
	});
}

/**
 * JevProvider wired to the in-process mock gateway: the real request/retry/budget path with
 * no paid requests. `profile` (or MOCK_JEV_PROFILE) picks injected faults, e.g. "flaky".
 */
export function mockJev(budget: BudgetGuard, extra: { fallback?: DecisionProvider, label?: string, profile?: string, seed?: string } = {}) {
	const mock = createMockGatewayFetch({ seed: extra.seed, faults: mockProfile(extra.profile ?? process.env.MOCK_JEV_PROFILE) });
	const provider = new JevProvider({
		apiKey: 'mock', model: 'mock/jev', budget, fetch: mock.fetch, label: extra.label ?? 'mock-jev', fallback: extra.fallback,
		maxAttempts: process.env.JEV_MAX_ATTEMPTS ? Number(process.env.JEV_MAX_ATTEMPTS) : undefined,
	});
	return { provider, stats: mock.stats };
}
