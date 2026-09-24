import { PRNG } from '../showdown/sim.ts';
import type { VisibleState } from '../showdown/state.ts';
import type { Decision, DecisionContext, DecisionProvider } from './types.ts';

/**
 * Adaptive strength ("Mercy") applied *after* the model has ranked the legal choices:
 *   state -> JEV distribution -> HandicapPolicy -> selected choice
 * The model is never told to play badly; we only sometimes pick a lower-ranked choice that
 * JEV itself still rated reasonably. Uses the player-visible state only.
 */

export interface AdvantageBreakdown {
	/** -1 (hopeless) .. 0 (even) .. +1 (overwhelming), from this player's perspective. */
	value: number;
	selfRemaining: number;
	oppRemaining: number;
	selfHp: number;
	oppHp: number;
	countTerm: number;
	hpTerm: number;
	boostTerm: number;
}

const STATUS_FACTOR: Record<string, number> = { slp: 0.7, frz: 0.7, par: 0.85, brn: 0.85, psn: 0.9, tox: 0.85 };

/**
 * Simple, explainable heuristic. Unrevealed opponent Pokémon are counted as healthy, which is
 * what a human player would assume from `|teamsize|`; nothing hidden is consulted.
 */
export function battleAdvantage(state: VisibleState): AdvantageBreakdown {
	const self = state.self.pokemon;
	const selfAlive = self.filter(p => !p.fainted);
	const selfHp = selfAlive.reduce((s, p) => s + (p.hp / p.maxhp) * (STATUS_FACTOR[p.status ?? ''] ?? 1), 0);

	const opp = state.opponent.pokemon;
	const unrevealed = Math.max(0, state.opponent.teamSize - opp.length);
	const oppAlive = opp.filter(p => !p.fainted);
	const oppHp = unrevealed + oppAlive.reduce((s, p) => s + (p.hpPercent / 100) * (STATUS_FACTOR[p.status ?? ''] ?? 1), 0);
	const selfRemaining = selfAlive.length;
	const oppRemaining = oppAlive.length + unrevealed;

	const teamSize = Math.max(self.length, state.opponent.teamSize, 1);
	const countTerm = (selfRemaining - oppRemaining) / teamSize;
	const hpTerm = selfHp + oppHp > 0 ? (selfHp - oppHp) / (selfHp + oppHp) : 0;
	const net = (b: Record<string, number> | undefined) => Object.values(b ?? {}).reduce((s, v) => s + v, 0);
	const selfActive = self.find(p => p.active && !p.fainted);
	const oppActive = opp.find(p => p.active && !p.fainted);
	const boostTerm = Math.max(-0.1, Math.min(0.1, 0.02 * (net(selfActive?.boosts) - net(oppActive?.boosts))));
	const value = Math.max(-1, Math.min(1, 0.5 * countTerm + 0.5 * hpTerm + boostTerm));
	const r = (v: number) => Math.round(v * 1000) / 1000;
	return { value: r(value), selfRemaining, oppRemaining, selfHp: r(selfHp), oppHp: r(oppHp), countTerm: r(countTerm), hpTerm: r(hpTerm), boostTerm: r(boostTerm) };
}

export interface HandicapConfig {
	mode: 'no-mercy' | 'mercy';
	/** 0..1; how hard to hold back when clearly ahead. Ignored in no-mercy. */
	strength: number;
	/** Advantage at which mercy starts / reaches full effect. */
	startAdvantage?: number;
	fullAdvantage?: number;
	/** Candidates must have at least this JEV probability ... */
	minProbability?: number;
	/** ... and at least this fraction of the top choice's probability. */
	minRelativeToTop?: number;
	/** At most this many choices (including the top one) are ever considered. */
	maxCandidates?: number;
	seed?: string;
}

export interface HandicapRecord {
	mode: HandicapConfig['mode'];
	strength: number;
	advantage: AdvantageBreakdown;
	/** 0 = play at full strength this turn; 1 = maximum mercy. */
	mercyLevel: number;
	deviateProbability: number;
	originalChoiceId: string;
	finalChoiceId: string;
	changed: boolean;
	candidates: string[];
	reason: string;
}

export function mercyLevel(advantage: number, cfg: HandicapConfig) {
	if (cfg.mode === 'no-mercy' || cfg.strength <= 0) return 0;
	const a0 = cfg.startAdvantage ?? 0.15;
	const a1 = cfg.fullAdvantage ?? 0.6;
	const t = Math.max(0, Math.min(1, (advantage - a0) / (a1 - a0)));
	return Math.min(1, cfg.strength) * t;
}

export function applyHandicap(decision: Decision, ctx: DecisionContext, cfg: HandicapConfig, prng: InstanceType<typeof PRNG>): HandicapRecord {
	const advantage = battleAdvantage(ctx.state);
	const level = mercyLevel(advantage.value, cfg);
	const base = { mode: cfg.mode, strength: cfg.mode === 'no-mercy' ? 0 : cfg.strength, advantage, mercyLevel: Math.round(level * 1000) / 1000, originalChoiceId: decision.choiceId };
	const scores = decision.scores;
	if (level === 0 || !scores) {
		return { ...base, deviateProbability: 0, finalChoiceId: decision.choiceId, changed: false, candidates: [decision.choiceId], reason: level === 0 ? 'full strength (not clearly ahead or no-mercy)' : 'no probability distribution' };
	}
	const topP = scores[decision.choiceId] ?? Math.max(...Object.values(scores));
	// Why: the candidate floor loosens as mercy grows, but never below what JEV rated a
	// plausible move, so mercy looks like a slightly suboptimal play rather than a blunder.
	const relFloor = (cfg.minRelativeToTop ?? 0.35) + (1 - (cfg.minRelativeToTop ?? 0.35)) * (1 - level);
	const floor = Math.max(cfg.minProbability ?? 0.08, topP * relFloor);
	const others = ctx.choices.map(c => c.id)
		.filter(id => id !== decision.choiceId && (scores[id] ?? 0) >= floor)
		.sort((x, y) => scores[y] - scores[x])
		.slice(0, (cfg.maxCandidates ?? 3) - 1);
	const deviateProbability = Math.round(0.8 * level * 1000) / 1000;
	const candidates = [decision.choiceId, ...others];
	if (!others.length || prng.random() >= deviateProbability) {
		return { ...base, deviateProbability, finalChoiceId: decision.choiceId, changed: false, candidates, reason: others.length ? 'kept top choice' : 'no alternative above floor' };
	}
	const total = others.reduce((s, id) => s + scores[id], 0);
	let r = prng.random() * total;
	let pick = others[others.length - 1];
	for (const id of others) { r -= scores[id]; if (r <= 0) { pick = id; break; } }
	return { ...base, deviateProbability, finalChoiceId: pick, changed: true, candidates, reason: 'mercy: picked a lower-ranked plausible choice' };
}

/** Wraps a scoring provider (JEV) with the handicap policy. No-mercy is a pass-through. */
export class HandicapProvider implements DecisionProvider {
	readonly name: string;
	private inner: DecisionProvider;
	private cfg: HandicapConfig;
	private prng: InstanceType<typeof PRNG>;

	constructor(inner: DecisionProvider, cfg: HandicapConfig) {
		this.inner = inner;
		this.cfg = cfg;
		this.name = cfg.mode === 'no-mercy' ? inner.name : `${inner.name}+mercy${cfg.strength}`;
		this.prng = new PRNG((cfg.seed ?? 'sodium,0000000000000000000000000000abcd') as any);
	}

	async decide(ctx: DecisionContext): Promise<Decision> {
		const d = await this.inner.decide(ctx);
		// Why: a fallback decision is not JEV's distribution; leave it untouched and flagged.
		if (d.fallback) return d;
		const handicap = applyHandicap(d, ctx, this.cfg, this.prng);
		return { ...d, choiceId: handicap.finalChoiceId, provider: this.name, handicap };
	}
}
