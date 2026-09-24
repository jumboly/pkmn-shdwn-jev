import { join } from 'node:path';
import { BudgetGuard, budgetConfigFromEnv } from './budget.ts';
import { HandicapProvider } from './decision/handicap.ts';
import { JevProvider } from './decision/jev.ts';
import { RandomProvider } from './decision/random.ts';
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

/** Mock spend goes to a throwaway ledger inside the run directory, never the project ledger. */
export function openMockBudget(runDir: string, experimentId: string) {
	return new BudgetGuard(budgetConfigFromEnv(join(runDir, 'mock-ledger.jsonl')), experimentId);
}

export const PLAYER_KINDS = ['random', 'mock-jev', 'jev'];
/** Player kinds are `random | mock-jev | jev`, each with an optional `-mercy` suffix. */
export const baseKind = (kind: string) => kind.replace(/-mercy$/, '');

export interface ProviderOptions {
	liveBudget?: BudgetGuard | null;
	mockBudget?: BudgetGuard | null;
	/** JevProvider label (live and mock). */
	label?: string;
	fallback?: DecisionProvider;
	mercyStrength?: number;
	mockProfile?: string;
	/** Reuse this mock-jev provider instead of creating a gateway per call (shared fault stats). */
	mock?: DecisionProvider;
	/**
	 * Called lazily, only when that part is built, so callers can keep counters (launch's mockSeq).
	 * Returning undefined leaves that part unseeded, as the interactive CLIs always did.
	 */
	seed?: (part: 'provider' | 'mercy' | 'mock') => string | undefined;
}

export function makeProvider(kind: string, o: ProviderOptions = {}): DecisionProvider {
	if (kind.endsWith('-mercy')) {
		return new HandicapProvider(makeProvider(baseKind(kind), o), { mode: 'mercy', strength: o.mercyStrength ?? 0.6, seed: o.seed?.('mercy') });
	}
	if (kind === 'random') return new RandomProvider(o.seed?.('provider'));
	if (kind === 'mock-jev') {
		if (o.mock) return o.mock;
		if (!o.mockBudget) throw new Error('mock-jev player needs a mock budget');
		return mockJev(o.mockBudget, { label: o.label, profile: o.mockProfile, seed: o.seed?.('mock'), fallback: o.fallback }).provider;
	}
	if (kind === 'jev') {
		// Why: a live player without the project ledger would spend unguarded.
		if (!o.liveBudget) throw new Error('jev player needs the live budget (openBudget)');
		return jevFromEnv(o.liveBudget, { label: o.label ?? 'jev', fallback: o.fallback });
	}
	throw new Error(`unknown player kind ${kind}`);
}

export const isLocalHost = (host: string) => ['localhost', '127.0.0.1', '::1'].includes(host);
