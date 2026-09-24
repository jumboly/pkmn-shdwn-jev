/**
 * Adaptive client-side pacing for JEV requests (AIMD).
 *
 * Why: under gateway rate limiting, each concurrent request used to discover the 429 on its
 * own and back off independently, so most wall time was spent in repeated 429 waits. Sharing
 * one limiter per process means a single 429 pauses every sender (honouring `retry-after`)
 * and widens the gap between requests; consecutive successes narrow it again.
 */
export interface RateLimiterOptions {
	/** Gap after the first 429 when none was set yet. */
	initialIntervalMs?: number;
	maxIntervalMs?: number;
	/** Multiplicative decrease of the gap per success (0..1). */
	decay?: number;
	now?: () => number;
	sleep?: (ms: number) => Promise<void>;
}

export class AdaptiveRateLimiter {
	intervalMs = 0;
	private cooldownUntil = 0;
	private nextSlot = 0;
	private opts: Required<RateLimiterOptions>;
	readonly stats = { requests: 0, rateLimited: 0, waitedMs: 0 };

	constructor(opts: RateLimiterOptions = {}) {
		this.opts = {
			initialIntervalMs: 500, maxIntervalMs: 10_000, decay: 0.9,
			now: () => Date.now(), sleep: ms => new Promise(r => setTimeout(r, ms)),
			...Object.fromEntries(Object.entries(opts).filter(([, v]) => v !== undefined)),
		};
	}

	/** Wait for this request's slot. Slots are handed out in call order. */
	async acquire() {
		const now = this.opts.now();
		const slot = Math.max(now, this.cooldownUntil, this.nextSlot);
		this.nextSlot = slot + this.intervalMs;
		this.stats.requests++;
		const wait = slot - now;
		if (wait > 0) {
			this.stats.waitedMs += wait;
			await this.opts.sleep(wait);
		}
	}

	onSuccess() {
		this.intervalMs = this.intervalMs * this.opts.decay;
		if (this.intervalMs < 20) this.intervalMs = 0;
	}

	/** Returns how long the caller should consider itself paused (for logging). */
	onRateLimited(retryAfterMs: number | null) {
		this.stats.rateLimited++;
		this.intervalMs = Math.min(this.opts.maxIntervalMs, Math.max(this.opts.initialIntervalMs, this.intervalMs * 2));
		const now = this.opts.now();
		const pause = retryAfterMs && retryAfterMs > 0 ? retryAfterMs : this.intervalMs;
		this.cooldownUntil = Math.max(this.cooldownUntil, now + pause);
		// Why: queued slots computed before the 429 must not jump the cooldown.
		this.nextSlot = Math.max(this.nextSlot, this.cooldownUntil);
		return pause;
	}
}

/** Process-wide default, shared by every JevProvider that does not get its own. */
export const sharedRateLimiter = new AdaptiveRateLimiter();
