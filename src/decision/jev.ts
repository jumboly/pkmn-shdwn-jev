import type { BudgetGuard } from '../budget.ts';
import { BudgetExceededError } from '../budget.ts';
import type { LegalChoice } from '../showdown/choices.ts';
import type { VisibleState } from '../showdown/state.ts';
import { Dex } from '../showdown/sim.ts';
import type { Decision, DecisionContext, DecisionProvider } from './types.ts';
import { sharedRateLimiter, type AdaptiveRateLimiter } from './rate-limiter.ts';

export const GATEWAY_EVALUATE_URL = 'https://ai-gateway.vercel.sh/v1/evaluate';

export class JevError extends Error {
	readonly code: string;
	readonly status?: number;
	constructor(message: string, code: string, status?: number) {
		super(message);
		this.code = code;
		this.status = status;
	}
}

export interface JevProviderOptions {
	apiKey: string;
	model: string;
	budget: BudgetGuard;
	fetch?: typeof fetch;
	url?: string;
	/** Attempts per decision (each attempt is separately budgeted). */
	maxAttempts?: number;
	/** Reject payloads above this many bytes before sending (see docs/decisions.md). */
	maxPayloadBytes?: number;
	/** Keep at most this many recent protocol lines in the state. */
	maxRecentEvents?: number;
	/** Explicit, logged fallback. Absent by default: JEV failures abort the battle. */
	fallback?: DecisionProvider;
	sleep?: (ms: number) => Promise<void>;
	/** Shared pacing across providers in this process (see rate-limiter.ts). */
	rateLimiter?: AdaptiveRateLimiter;
	label?: string;
}

export interface EvaluateRequestBody {
	model: string;
	state: unknown;
	questions: Record<string, { type: 'choice', instructions: string, criteria: Record<string, string> }>;
}

/**
 * Type-chart multiplier against the opponent's *visible* active types (dex types, or the
 * revealed tera type). Abilities/items are ignored because they may be unrevealed.
 */
export function typeMultiplier(moveType: string, state?: VisibleState): { target: string, multiplier: number } | null {
	const foe = state?.opponent.pokemon.find(p => p.active && !p.fainted);
	if (!foe) return null;
	const dex = Dex.forGen(state!.gen);
	if (!dex.getImmunity(moveType, foe.types)) return { target: foe.species, multiplier: 0 };
	return { target: foe.species, multiplier: 2 ** dex.getEffectiveness(moveType, foe.types) };
}

export function describeChoice(c: LegalChoice, state?: VisibleState): string {
	if (c.move) {
		const m = c.move;
		// Why: Tera Blast becomes the tera type when terastallizing, which the type chart must reflect.
		const type = c.terastallize && m.name === 'Tera Blast' ? c.terastallize : m.type;
		const eff = m.category !== 'Status' ? typeMultiplier(type, state) : null;
		const effText = eff ? `; type chart vs ${eff.target}: x${eff.multiplier}` : '';
		const acc = m.accuracy === true ? 'never misses' : `${m.accuracy}% accuracy`;
		const bp = m.basePower ? `${m.basePower} base power` : 'no base power';
		const pri = m.priority ? `, priority ${m.priority > 0 ? '+' : ''}${m.priority}` : '';
		const pp = m.pp !== undefined ? `, PP ${m.pp}/${m.maxpp}` : '';
		const tera = c.terastallize ? `; ALSO Terastallize into ${c.terastallize} type this turn (once per battle)` : '';
		return `Use move ${m.name} (${type}, ${m.category}, ${bp}, ${acc}${pri}${pp}${effText})${tera}`;
	}
	if (c.switchTo) {
		const s = c.switchTo;
		return `Switch to ${s.species} (HP ${s.hp}${s.status ? `, ${s.status}` : ''})`;
	}
	return c.label;
}

/** Compact, player-visible state for the model; drops empty fields to save tokens. */
export function buildJevState(state: VisibleState, maxRecentEvents: number) {
	const strip = (o: any): any => {
		if (Array.isArray(o)) return o.map(strip);
		if (o && typeof o === 'object') {
			const out: any = {};
			for (const [k, v] of Object.entries(o)) {
				if (v === undefined || v === null || v === false) continue;
				if (Array.isArray(v) && !v.length) continue;
				if (typeof v === 'object' && !Array.isArray(v) && !Object.keys(v as object).length) continue;
				out[k] = strip(v);
			}
			return out;
		}
		return o;
	};
	return strip({
		game: `Pokémon Showdown ${state.format} (singles). You are ${state.perspective}.`,
		turn: state.turn,
		you: state.self,
		opponent: {
			...state.opponent,
			note: 'Only revealed information is listed. Unrevealed opponent Pokémon, moves, items and abilities are unknown.',
		},
		field: state.field,
		recentEvents: state.recentEvents.slice(-maxRecentEvents),
	});
}

export function buildEvaluateBody(model: string, ctx: DecisionContext, maxRecentEvents: number): EvaluateRequestBody {
	const criteria: Record<string, string> = {};
	for (const c of ctx.choices) criteria[c.id] = describeChoice(c, ctx.state);
	return {
		model,
		state: buildJevState(ctx.state, maxRecentEvents),
		questions: {
			action: {
				type: 'choice',
				instructions: 'You are playing this Pokémon battle to win. Given the visible battle state, which legal action gives you the best chance of winning the battle?',
				criteria,
			},
		},
	};
}

const RETRYABLE = new Set([408, 409, 425, 429, 500, 502, 503, 504, 529]);

export class JevProvider implements DecisionProvider {
	readonly name: string;
	private opts: Required<Omit<JevProviderOptions, 'fallback' | 'label'>> & Pick<JevProviderOptions, 'fallback'>;

	constructor(opts: JevProviderOptions) {
		if (!opts.apiKey) throw new JevError('AI_GATEWAY_API_KEY is not set', 'NO_API_KEY');
		this.name = opts.label ?? `jev:${opts.model}`;
		this.opts = {
			fetch: globalThis.fetch, url: GATEWAY_EVALUATE_URL, maxAttempts: 5, maxPayloadBytes: 24_000,
			maxRecentEvents: 40, sleep: ms => new Promise(r => setTimeout(r, ms)), rateLimiter: sharedRateLimiter,
			// Why: an explicit `undefined` (e.g. unset env var) must not erase a safety default.
			...Object.fromEntries(Object.entries(opts).filter(([, v]) => v !== undefined)) as JevProviderOptions,
		};
	}

	async decide(ctx: DecisionContext): Promise<Decision> {
		try {
			return await this.evaluate(ctx);
		} catch (err: any) {
			// Budget stops must propagate: falling back would hide that JEV was not consulted.
			if (!this.opts.fallback || err instanceof BudgetExceededError) throw err;
			const d = await this.opts.fallback.decide(ctx);
			return { ...d, fallback: { from: this.name, reason: String(err?.message ?? err) } };
		}
	}

	private async evaluate(ctx: DecisionContext): Promise<Decision> {
		const { budget } = this.opts;
		let events = this.opts.maxRecentEvents;
		let body = buildEvaluateBody(this.opts.model, ctx, events);
		let json = JSON.stringify(body);
		// Why: recent events are the only unbounded part; shrink them before giving up.
		while (Buffer.byteLength(json) > this.opts.maxPayloadBytes && events > 0) {
			events = Math.floor(events / 2);
			body = buildEvaluateBody(this.opts.model, ctx, events);
			json = JSON.stringify(body);
		}
		const payloadBytes = Buffer.byteLength(json);
		if (payloadBytes > this.opts.maxPayloadBytes) {
			throw new JevError(`payload ${payloadBytes}B exceeds limit ${this.opts.maxPayloadBytes}B`, 'PAYLOAD_TOO_LARGE');
		}

		const usage = { requests: 0, costUsd: 0, costEstimated: false, generationIds: [] as string[] };
		let lastErr: JevError | undefined;
		for (let attempt = 1; attempt <= this.opts.maxAttempts; attempt++) {
			await this.opts.rateLimiter.acquire();
			const reservation = budget.reserve();
			let res: Response;
			try {
				res = await this.opts.fetch(this.opts.url, {
					method: 'POST',
					headers: { 'Authorization': `Bearer ${this.opts.apiKey}`, 'Content-Type': 'application/json' },
					body: json,
					signal: AbortSignal.timeout(60_000),
				});
			} catch (err: any) {
				// We cannot know whether the provider processed it, so book the worst case.
				const entry = budget.settle(reservation, { status: 'error', reportedCostUsd: null, sent: true, note: `network: ${err?.message}` });
				usage.requests++; usage.costUsd += entry.costUsd; usage.costEstimated = true;
				lastErr = new JevError(`network error: ${err?.message ?? err}`, 'NETWORK');
				await this.opts.sleep(500 * 2 ** attempt);
				continue;
			}
			const text = await res.text();
			let data: any = null;
			try { data = JSON.parse(text); } catch {}
			const gw = data?.providerMetadata?.gateway;
			const reportedCost = gw?.cost !== undefined && gw.cost !== null ? Number(gw.cost) : (res.ok ? null : 0);
			// Why: failed requests without a cost field are rejected by the gateway before
			// inference and are not billed; successful ones without cost are booked pessimistically.
			const entry = budget.settle(reservation, {
				status: res.ok ? 'ok' : 'error', reportedCostUsd: Number.isFinite(reportedCost) ? reportedCost : null,
				marketCostUsd: gw?.marketCost !== undefined ? Number(gw.marketCost) : null,
				generationId: gw?.generationId ?? data?.generationId, inputTokens: data?.usage?.inputTokens,
				sent: true, note: res.ok ? undefined : `HTTP ${res.status}`,
			});
			usage.requests++; usage.costUsd += entry.costUsd; usage.costEstimated ||= entry.costEstimated;
			if (entry.generationId) usage.generationIds.push(entry.generationId);

			if (!res.ok) {
				const msg = data?.error?.message ?? text.slice(0, 300);
				const type = data?.error?.type ?? `HTTP_${res.status}`;
				lastErr = new JevError(`gateway ${res.status} ${type}: ${msg}`, type, res.status);
				if (res.status === 402) throw new BudgetExceededError(`gateway refused (402 ${type}): ${msg}`);
				if (!RETRYABLE.has(res.status)) throw lastErr;
				if (res.status === 429) {
					// The shared limiter pauses every sender; the next acquire() does the waiting.
					const retryAfter = Number(res.headers.get('retry-after'));
					this.opts.rateLimiter.onRateLimited(Number.isFinite(retryAfter) && retryAfter > 0 ? retryAfter * 1000 : null);
				} else {
					await this.opts.sleep(500 * 2 ** attempt);
				}
				continue;
			}

			this.opts.rateLimiter.onSuccess();
			const answer = data?.answers?.action;
			const valid = new Set(ctx.choices.map(c => c.id));
			if (answer?.type !== 'choice' || !valid.has(answer.choice)) {
				// Why: never coerce an out-of-set answer into a command; treat as a failed request.
				lastErr = new JevError(`invalid JEV answer: ${JSON.stringify(answer)?.slice(0, 300)}`, 'INVALID_ANSWER');
				continue;
			}
			const confidence = data?.providerMetadata?.typesafe?.confidence?.action;
			return {
				choiceId: answer.choice,
				provider: this.name,
				scores: answer.probabilities,
				confidence: typeof confidence === 'number' ? confidence : undefined,
				usage,
				raw: { answers: data.answers, usage: data.usage, providerMetadata: data.providerMetadata, payloadBytes, recentEventsSent: events },
			};
		}
		throw lastErr ?? new JevError('JEV request failed', 'UNKNOWN');
	}
}
