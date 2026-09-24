import { createHash } from 'node:crypto';
import { legalChoices } from '../showdown/choices.ts';
import { BattleStream, getPlayerStreams, SHOWDOWN_VERSION } from '../showdown/sim.ts';
import { VisibleStateTracker } from '../showdown/state.ts';
import type { SideID } from '../showdown/protocol.ts';
import type { DecisionProvider } from '../decision/types.ts';
import type { JsonlLog } from '../logging.ts';

export interface PlayerConfig {
	name: string;
	provider: DecisionProvider;
}

export interface BattleResult {
	battleId: string;
	format: string;
	seed: string;
	/** `aborted` = battle stopped by us (provider failure, budget, turn limit); not a game result. */
	outcome: 'win' | 'tie' | 'aborted';
	winner: SideID | null;
	turns: number;
	decisions: number;
	abortReason?: string;
	/** Spectator-channel protocol (no hidden info), used for replays. */
	spectatorLog: string;
	inputLog: string[];
}

export interface RunBattleOptions {
	battleId: string;
	format: string;
	/** Showdown PRNG seed string, e.g. `sodium,<32 hex chars>`. */
	seed: string;
	p1: PlayerConfig;
	p2: PlayerConfig;
	log: JsonlLog;
	/** Why: some Random Battle matchups (e.g. two walls) can stall for hundreds of turns. */
	maxTurns?: number;
}

/**
 * Run one headless battle on the local simulator.
 *
 * Each side is driven only from its own player stream (`getPlayerStreams(...).p1/p2`),
 * which already resolves `|split|` into the public half for opponents, so providers
 * never see hidden information. The omniscient stream is read only for logging.
 */
export async function runSimBattle(opts: RunBattleOptions): Promise<BattleResult> {
	const { battleId, format, seed, log } = opts;
	const maxTurns = opts.maxTurns ?? 300;
	const battleStream = new BattleStream();
	const streams = getPlayerStreams(battleStream);
	let decisions = 0;
	let abortReason: string | undefined;

	log.write('battle-start', {
		battleId, format, seed, showdownVersion: SHOWDOWN_VERSION,
		players: { p1: { name: opts.p1.name, provider: opts.p1.provider.name }, p2: { name: opts.p2.name, provider: opts.p2.provider.name } },
	});

	const abort = (reason: string) => {
		if (abortReason) return;
		abortReason = reason;
		log.write('battle-abort', { battleId, reason });
		// Why: a forced tie ends the simulator cleanly; `outcome: aborted` keeps it out of win/loss stats.
		void streams.omniscient.write('>forcetie');
	};

	const drive = async (side: SideID, player: PlayerConfig) => {
		const tracker = new VisibleStateTracker(side);
		const stream = streams[side];
		for await (const chunk of stream) {
			tracker.feed(chunk);
			if (abortReason) continue;
			for (const line of chunk.split('\n')) {
				if (line.startsWith('|error|')) {
					log.write('sim-error', { battleId, side, message: line });
					// Why: `[Unavailable choice]` is followed by a corrected request; anything else
					// means we produced an illegal command, which is a controller bug.
					if (!line.startsWith('|error|[Unavailable choice]')) abort(`invalid choice from ${side}: ${line}`);
				}
			}
			if (!chunk.includes('|request|')) continue;
			const request = tracker.request;
			if (!request || request.wait) continue;
			if (tracker.turn > maxTurns) { abort(`turn limit ${maxTurns} reached`); continue; }

			const choices = legalChoices(request, tracker.gen);
			const state = tracker.snapshot();
			try {
				const decision = await player.provider.decide({ battleId, side, state, choices });
				const choice = choices.find(c => c.id === decision.choiceId);
				if (!choice) throw new Error(`provider ${player.provider.name} returned unknown choice ${decision.choiceId}`);
				decisions++;
				log.write('decision', {
					battleId, side, turn: state.turn, request, state, choices, decision, command: choice.command,
				});
				void stream.write(choice.command);
			} catch (err: any) {
				log.write('decision-error', { battleId, side, turn: state.turn, provider: player.provider.name, error: String(err?.message ?? err), code: err?.code });
				abort(`decision failed for ${side}: ${err?.message ?? err}`);
			}
		}
	};

	const spectator: string[] = [];
	const collectSpectator = (async () => {
		for await (const chunk of streams.spectator) spectator.push(chunk);
	})();

	void streams.omniscient.write(`>start ${JSON.stringify({ formatid: format, seed })}`);
	// Why: random-team formats draw each team from a per-player seed that defaults to a fresh
	// random value, so the battle seed alone does not reproduce a battle.
	for (const side of ['p1', 'p2'] as const) {
		const teamSeed = `sodium,${createHash('sha256').update(`${seed}|team|${side}`).digest('hex').slice(0, 32)}`;
		void streams.omniscient.write(`>player ${side} ${JSON.stringify({ name: opts[side].name, seed: teamSeed })}`);
	}

	await Promise.all([drive('p1', opts.p1), drive('p2', opts.p2), collectSpectator]);

	const battle = battleStream.battle!;
	const winnerSide = battle.winner
		? (battle.sides.find(s => s.name === battle.winner)?.id as SideID | undefined) ?? null
		: null;
	const outcome: BattleResult['outcome'] = abortReason ? 'aborted' : winnerSide ? 'win' : 'tie';
	const result: BattleResult = {
		battleId, format, seed, outcome, winner: abortReason ? null : winnerSide, turns: battle.turn,
		decisions, abortReason, spectatorLog: spectator.join('\n'), inputLog: [...battle.inputLog],
	};
	log.write('battle-end', {
		battleId, outcome, winner: result.winner, turns: result.turns, decisions, abortReason,
		// Full teams are logged for post-hoc analysis only; they are never passed to providers.
		teams: { p1: battle.sides[0].team, p2: battle.sides[1].team },
		inputLog: result.inputLog,
	});
	return result;
}
