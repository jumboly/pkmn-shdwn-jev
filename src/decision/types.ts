import type { LegalChoice } from '../showdown/choices.ts';
import type { VisibleState } from '../showdown/state.ts';
import type { HandicapRecord } from './handicap.ts';

export interface DecisionContext {
	battleId: string;
	side: 'p1' | 'p2';
	/** Player-visible state only (see VisibleStateTracker). */
	state: VisibleState;
	choices: LegalChoice[];
}

export interface Decision {
	choiceId: string;
	/** Which provider actually produced this decision (differs from the configured one on fallback). */
	provider: string;
	/** Per-choice probability / preference as reported by the provider, if any. */
	scores?: Record<string, number>;
	confidence?: number;
	/** Explicitly flags a non-primary decision so it is never mixed up with real JEV output. */
	fallback?: { from: string, reason: string };
	usage?: { requests: number, costUsd: number, costEstimated: boolean, generationIds?: string[] };
	/** Adaptive-strength record; `originalChoiceId` is JEV's own top choice. */
	handicap?: HandicapRecord;
	raw?: unknown;
}

export interface DecisionProvider {
	readonly name: string;
	decide(ctx: DecisionContext): Promise<Decision>;
}
