import { PRNG } from '../showdown/sim.ts';
import type { Decision, DecisionContext, DecisionProvider } from './types.ts';

/** Uniform random over legal choices; seeded so baseline runs are reproducible. */
export class RandomProvider implements DecisionProvider {
	readonly name = 'random';
	private prng: InstanceType<typeof PRNG>;

	constructor(seed?: string) {
		this.prng = new PRNG(seed as any);
	}

	async decide(ctx: DecisionContext): Promise<Decision> {
		const choice = this.prng.sample(ctx.choices);
		return { choiceId: choice.id, provider: this.name };
	}
}
