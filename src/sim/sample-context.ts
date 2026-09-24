import { RandomProvider } from '../decision/random.ts';
import type { DecisionContext } from '../decision/types.ts';
import { JsonlLog } from '../logging.ts';
import { runSimBattle } from './run-battle.ts';

/** A realistic mid-battle decision context, produced offline by a random-vs-random battle. */
export async function sampleContext(turn = 5): Promise<DecisionContext> {
	let picked: DecisionContext | undefined;
	const rand = new RandomProvider('sodium,000000000000000000000000000000aa');
	await runSimBattle({
		battleId: 'sample', format: 'gen9randombattle', seed: 'sodium,000000000000000000000000000000ab', log: new JsonlLog(null),
		p1: { name: 'JEV', provider: { name: 'capture', decide: async ctx => { if (!picked && ctx.state.turn >= turn && ctx.choices.length > 2) picked = ctx; return rand.decide(ctx); } } },
		p2: { name: 'Opponent', provider: new RandomProvider('sodium,000000000000000000000000000000ac') },
	});
	if (!picked) throw new Error('no context captured');
	return picked;
}
