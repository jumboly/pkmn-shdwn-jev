import type { Decision, DecisionContext, DecisionProvider } from '../decision/types.ts';

export interface DeadlineResult {
	decision: Decision;
	/** Set when the primary provider did not answer in time and `fallback` was used. */
	timedOut: boolean;
	/** Settles when the primary finishes (useful for logging a late answer that was not used). */
	primary: Promise<Decision | { error: string }>;
}

/**
 * Ask `primary`, but switch to `fallback` if it has not answered within `budgetMs`.
 *
 * Why: under gateway rate limiting a single JEV decision can take tens of seconds, and the
 * battle timer turns a slow answer into a loss. A late but explicit, logged fallback is
 * better than timing out. The primary is not cancelled (its request may already be billed);
 * its answer is just not used.
 */
export async function decideWithDeadline(primary: DecisionProvider, ctx: DecisionContext, budgetMs: number | null, fallback: DecisionProvider | null): Promise<DeadlineResult> {
	const started = primary.decide(ctx);
	const settled = started.then(d => d, (err: any) => ({ error: String(err?.message ?? err) }));
	if (budgetMs === null || !fallback) return { decision: await started, timedOut: false, primary: settled };

	let timer: NodeJS.Timeout | undefined;
	const expired = new Promise<'timeout'>(r => { timer = setTimeout(() => r('timeout'), Math.max(0, budgetMs)); });
	const first = await Promise.race([started.then(d => ({ d }), err => ({ err })), expired]);
	clearTimeout(timer);
	if (first !== 'timeout') {
		if ('err' in first) throw first.err;
		return { decision: first.d, timedOut: false, primary: settled };
	}
	const d = await fallback.decide(ctx);
	return {
		decision: { ...d, fallback: { from: primary.name, reason: `battle timer: no answer within ${Math.round(budgetMs)}ms` } },
		timedOut: true, primary: settled,
	};
}
