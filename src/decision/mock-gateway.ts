import { PRNG } from '../showdown/sim.ts';

/**
 * Transport faults the real gateway shows. Rates are per request, checked in this order.
 * Why: everything except JEV's judgement (retries, limiter, ledger, fallback, logging, battle
 * lifecycle) must be verifiable without paid requests, including the error paths that live
 * runs hit often (~15% of live requests were 429/503 as of 2026-09-24).
 */
export interface MockFaults {
	/** Uniform response delay range; real requests take ~0.4-1s. */
	latencyMs?: [number, number];
	/** fetch() rejects, as with a dropped connection. */
	networkRate?: number;
	rate429?: number;
	rate503?: number;
	/** 200 OK whose answer is outside the legal choice set. */
	invalidAnswerRate?: number;
}

/** Named presets so CLIs and `mise run dry` share one definition. */
export const MOCK_PROFILES: Record<string, MockFaults> = {
	clean: {},
	// Why: roughly the live mix (429 > 503), with shorter latency so dry runs stay quick.
	flaky: { latencyMs: [20, 150], networkRate: 0.01, rate429: 0.1, rate503: 0.05, invalidAnswerRate: 0.02 },
};

export function mockProfile(name: string | undefined): MockFaults {
	const p = MOCK_PROFILES[name || 'clean'];
	if (!p) throw new Error(`unknown mock profile "${name}" (known: ${Object.keys(MOCK_PROFILES).join(', ')})`);
	return p;
}

/**
 * In-process fake of `POST /v1/evaluate` (response shape per
 * https://vercel.com/docs/ai-gateway/modalities/evaluation). Lets JevProvider run its real
 * payload/parse/budget path in tests and dry runs without any paid request.
 */
export function createMockGatewayFetch(opts: { seed?: string, costPerByteUsd?: number, fail?: (n: number) => number | null, faults?: MockFaults } = {}) {
	const prng = new PRNG((opts.seed ?? 'sodium,00000000000000000000000000000000') as any);
	// Why: a separate stream keeps the answer sequence identical whether or not faults are on.
	const faultPrng = new PRNG('sodium,000000000000000000000000000fa017' as any);
	const faults = opts.faults ?? {};
	let n = 0;
	const calls: { body: any, bytes: number }[] = [];
	const stats = { requests: 0, network: 0, http429: 0, http503: 0, invalidAnswer: 0 };
	const hit = (rate?: number) => !!rate && faultPrng.random() < rate;
	const fetchImpl = (async (_url: string | URL | Request, init?: RequestInit) => {
		n++;
		stats.requests++;
		const bytes = Buffer.byteLength(String(init?.body));
		const body = JSON.parse(String(init?.body));
		calls.push({ body, bytes });
		if (faults.latencyMs) {
			const [lo, hi] = faults.latencyMs;
			await new Promise(r => setTimeout(r, lo + faultPrng.random() * (hi - lo)));
		}
		if (hit(faults.networkRate)) { stats.network++; throw new TypeError('mock network failure'); }
		const status = opts.fail?.(n) ?? (hit(faults.rate429) ? 429 : hit(faults.rate503) ? 503 : null);
		if (status) {
			if (status === 429) stats.http429++;
			if (status === 503) stats.http503++;
			return new Response(JSON.stringify({ error: { message: 'mock failure', type: 'mock_error' } }), { status });
		}
		const keys = Object.keys(body.questions.action.criteria);
		const weights = keys.map(() => prng.random() + 0.01);
		const total = weights.reduce((a, b) => a + b, 0);
		const probabilities = Object.fromEntries(keys.map((k, i) => [k, Math.round(100 * weights[i] / total) / 100]));
		let choice = keys[weights.indexOf(Math.max(...weights))];
		if (hit(faults.invalidAnswerRate)) { stats.invalidAnswer++; choice = 'not-a-legal-choice'; }
		const inputTokens = Math.ceil(bytes / 4);
		const cost = (bytes * (opts.costPerByteUsd ?? 0.042e-6 / 4)).toFixed(8);
		return new Response(JSON.stringify({
			model: body.model,
			answers: { action: { type: 'choice', choice, probabilities } },
			usage: { inputTokens, outputTokens: 1 },
			providerMetadata: { gateway: { cost, generationId: `gen_mock_${n}` } },
		}), { status: 200, headers: { 'content-type': 'application/json' } });
	}) as typeof fetch;
	return { fetch: fetchImpl, calls, stats };
}
