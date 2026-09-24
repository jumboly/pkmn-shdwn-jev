import { appendFileSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';

/**
 * Project-wide JEV spend guard.
 *
 * The ledger is a persistent append-only JSONL file shared by every experiment, because the
 * 5 USD cap is for the whole project, not per run. Vercel's per-key budget is a soft cap
 * (the request that crosses it still completes), so we additionally refuse to *send* any
 * request unless `spent + inFlight + maxCostPerRequest <= stopThreshold`.
 */

export class BudgetExceededError extends Error {
	readonly code = 'BUDGET_EXCEEDED';
}

export interface BudgetConfig {
	ledgerPath: string;
	/** Hard cap that must never be exceeded. */
	budgetUsd: number;
	/** App-side stop line (< budgetUsd) that absorbs reporting lag and estimation error. */
	stopThresholdUsd: number;
	/** Pessimistic upper bound for a single request, reserved before sending. */
	maxCostPerRequestUsd: number;
	/** Optional per-experiment caps. */
	maxRequests?: number;
	maxExperimentCostUsd?: number;
}

export interface LedgerEntry {
	ts: string;
	experimentId: string;
	requestId: string;
	status: 'ok' | 'error';
	/** Cost we accounted for: max(reported, market), or the reservation when not reported. */
	costUsd: number;
	reportedCostUsd: number | null;
	/** List price without promotions/credits (`providerMetadata.gateway.marketCost`). */
	marketCostUsd?: number | null;
	costEstimated: boolean;
	generationId?: string;
	inputTokens?: number;
	note?: string;
}

export function budgetConfigFromEnv(ledgerPath = 'runs/jev-cost-ledger.jsonl', env = process.env): BudgetConfig {
	const num = (name: string, def: number) => {
		const raw = env[name];
		if (raw === undefined || raw === '') return def;
		const v = Number(raw);
		if (!Number.isFinite(v) || v < 0) throw new Error(`${name} must be a non-negative number, got ${raw}`);
		return v;
	};
	const cfg: BudgetConfig = {
		ledgerPath,
		budgetUsd: num('EXPERIMENT_BUDGET_USD', 5),
		stopThresholdUsd: num('EXPERIMENT_STOP_THRESHOLD_USD', 4.5),
		maxCostPerRequestUsd: num('JEV_MAX_COST_PER_REQUEST_USD', 0.01),
	};
	if (env.EXPERIMENT_MAX_REQUESTS) cfg.maxRequests = num('EXPERIMENT_MAX_REQUESTS', 0);
	if (env.EXPERIMENT_MAX_COST_USD) cfg.maxExperimentCostUsd = num('EXPERIMENT_MAX_COST_USD', 0);
	if (cfg.stopThresholdUsd >= cfg.budgetUsd) {
		throw new Error('EXPERIMENT_STOP_THRESHOLD_USD must be below EXPERIMENT_BUDGET_USD');
	}
	return cfg;
}

export class BudgetGuard {
	readonly config: BudgetConfig;
	readonly experimentId: string;
	/** Spend across all experiments recorded in the ledger (including this one). */
	private spentTotal = 0;
	private spentExperiment = 0;
	private requestsExperiment = 0;
	private requestsTotal = 0;
	private inFlight = new Map<string, number>();
	private lockPath: string;
	private seq = 0;

	constructor(config: BudgetConfig, experimentId: string) {
		this.config = config;
		this.experimentId = experimentId;
		this.lockPath = `${config.ledgerPath}.lock`;
		mkdirSync(dirname(config.ledgerPath), { recursive: true });
		this.acquireLock();
		if (existsSync(config.ledgerPath)) {
			for (const line of readFileSync(config.ledgerPath, 'utf8').split('\n')) {
				if (!line.trim()) continue;
				const e = JSON.parse(line) as LedgerEntry;
				this.spentTotal += e.costUsd;
				this.requestsTotal++;
			}
		}
	}

	/**
	 * Why a lock: two concurrent processes would each read the same `spent` and could
	 * jointly overshoot. Stale locks (dead pid) are reclaimed.
	 */
	private acquireLock() {
		if (existsSync(this.lockPath)) {
			const pid = Number(readFileSync(this.lockPath, 'utf8'));
			let alive = false;
			try { process.kill(pid, 0); alive = pid !== process.pid; } catch {}
			if (alive) throw new Error(`Budget ledger is locked by running process ${pid} (${this.lockPath})`);
		}
		writeFileSync(this.lockPath, String(process.pid));
		process.once('exit', () => this.release());
	}

	release() {
		try {
			if (existsSync(this.lockPath) && readFileSync(this.lockPath, 'utf8') === String(process.pid)) rmSync(this.lockPath);
		} catch {}
	}

	get snapshot() {
		const reserved = [...this.inFlight.values()].reduce((a, b) => a + b, 0);
		return {
			budgetUsd: this.config.budgetUsd,
			stopThresholdUsd: this.config.stopThresholdUsd,
			spentTotalUsd: round(this.spentTotal),
			spentExperimentUsd: round(this.spentExperiment),
			reservedUsd: round(reserved),
			remainingToStopUsd: round(this.config.stopThresholdUsd - this.spentTotal - reserved),
			requestsTotal: this.requestsTotal,
			requestsExperiment: this.requestsExperiment,
		};
	}

	/** Returns null if another request may be sent, else a human-readable stop reason. */
	checkRequest(): string | null {
		const c = this.config;
		const s = this.snapshot;
		if (c.maxRequests !== undefined && s.requestsExperiment + this.inFlight.size >= c.maxRequests) {
			return `experiment request cap reached (${c.maxRequests})`;
		}
		if (this.spentTotal + s.reservedUsd + c.maxCostPerRequestUsd > c.stopThresholdUsd) {
			return `project spend ${s.spentTotalUsd} + reserved ${s.reservedUsd} + worst-case request ${c.maxCostPerRequestUsd} would exceed stop threshold ${c.stopThresholdUsd} (hard budget ${c.budgetUsd})`;
		}
		if (c.maxExperimentCostUsd !== undefined && this.spentExperiment + s.reservedUsd + c.maxCostPerRequestUsd > c.maxExperimentCostUsd) {
			return `experiment spend would exceed EXPERIMENT_MAX_COST_USD ${c.maxExperimentCostUsd}`;
		}
		return null;
	}

	/**
	 * Can a new battle start? The caller passes the expected requests and cost for one battle
	 * so a battle is not predictably cut off mid-game. Individual requests are still guarded
	 * by the worst-case reservation in `reserve()`, so an optimistic estimate cannot overspend.
	 */
	checkNewBattle(expected: { requests: number, costUsd: number }): string | null {
		const c = this.config;
		const s = this.snapshot;
		if (this.spentTotal + s.reservedUsd + expected.costUsd + c.maxCostPerRequestUsd > c.stopThresholdUsd) {
			return `not enough budget headroom for another battle (expected ~${round(expected.costUsd)} USD, ${s.remainingToStopUsd} left before stop threshold ${c.stopThresholdUsd})`;
		}
		if (c.maxExperimentCostUsd !== undefined && this.spentExperiment + expected.costUsd > c.maxExperimentCostUsd) {
			return `not enough experiment budget for another battle (EXPERIMENT_MAX_COST_USD ${c.maxExperimentCostUsd})`;
		}
		if (c.maxRequests !== undefined && s.requestsExperiment + expected.requests > c.maxRequests) {
			return `not enough request quota for another battle (EXPERIMENT_MAX_REQUESTS ${c.maxRequests})`;
		}
		return null;
	}

	/** Reserve worst-case cost; throws BudgetExceededError instead of letting a request go out. */
	reserve(): string {
		const reason = this.checkRequest();
		if (reason) throw new BudgetExceededError(`JEV request blocked by budget guard: ${reason}`);
		const id = `${this.experimentId}#${++this.seq}`;
		this.inFlight.set(id, this.config.maxCostPerRequestUsd);
		return id;
	}

	/**
	 * Settle a reservation. When the gateway did not report a cost (e.g. network error after
	 * the request may have reached the provider) we conservatively book the full reservation.
	 */
	settle(requestId: string, r: { status: 'ok' | 'error', reportedCostUsd: number | null, marketCostUsd?: number | null, generationId?: string, inputTokens?: number, note?: string, sent: boolean }): LedgerEntry {
		const reserved = this.inFlight.get(requestId);
		if (reserved === undefined) throw new Error(`unknown reservation ${requestId}`);
		this.inFlight.delete(requestId);
		// Why: a request that provably never left the process (e.g. pre-flight validation) costs nothing.
		const costEstimated = r.reportedCostUsd === null && r.sent;
		// Why: promotions report `cost: 0`; budgeting on the list price keeps the guard valid
		// once the promotion ends and never under-counts.
		const reported = r.reportedCostUsd === null ? null : Math.max(r.reportedCostUsd, r.marketCostUsd ?? 0);
		const costUsd = reported ?? (r.sent ? reserved : 0);
		const entry: LedgerEntry = {
			ts: new Date().toISOString(), experimentId: this.experimentId, requestId, status: r.status,
			costUsd, reportedCostUsd: r.reportedCostUsd, marketCostUsd: r.marketCostUsd ?? null, costEstimated,
			generationId: r.generationId, inputTokens: r.inputTokens, note: r.note,
		};
		if (r.sent) {
			appendFileSync(this.config.ledgerPath, JSON.stringify(entry) + '\n');
			this.spentTotal += costUsd;
			this.spentExperiment += costUsd;
			this.requestsTotal++;
			this.requestsExperiment++;
		}
		return entry;
	}
}

function round(v: number) {
	return Math.round(v * 1e8) / 1e8;
}
