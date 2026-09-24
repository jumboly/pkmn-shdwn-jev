import type { ChoiceRequest } from './types.ts';
import { parseCondition, parseDetails } from './protocol.ts';
import { Dex } from './sim.ts';

/**
 * One legal option for the current request. `command` is exactly what gets sent to
 * Showdown (`>p1 <command>` in the simulator, `/choose <command>` on a server), so the
 * decision maker only ever picks an `id`; it never authors commands itself.
 */
export interface LegalChoice {
	id: string;
	command: string;
	kind: 'move' | 'switch' | 'team';
	label: string;
	/** Deterministic dex facts, so JEV does not have to guess them. */
	move?: {
		name: string, type: string, category: string, basePower: number,
		accuracy: number | true, priority: number, pp?: number, maxpp?: number, target?: string,
	};
	terastallize?: string;
	switchTo?: { slot: number, species: string, hp: string, status?: string };
}

/**
 * Enumerate legal choices for a singles request.
 *
 * The simulator is still the authority: a choice listed here can be rejected with
 * `[Unavailable choice]` when hidden information (e.g. an unrevealed trapping ability)
 * applies, in which case Showdown sends an updated request and we enumerate again.
 */
export function legalChoices(request: ChoiceRequest, gen = 9): LegalChoice[] {
	if (request.wait) return [];
	const dex = Dex.forGen(gen);
	const team = request.side.pokemon;

	if (request.teamPreview) {
		// Why: Random Battle has no team preview; keep order rather than guessing a lead.
		return [{ id: 'team-default', command: 'default', kind: 'team', label: 'Keep team order' }];
	}

	const switchOptions = (reviving: boolean) => team.flatMap((p, i) => {
		const cond = parseCondition(p.condition);
		// Revival Blessing asks for a *fainted* party member instead of a healthy one.
		if (p.active || cond.fainted !== reviving) return [];
		const species = parseDetails(p.details).species;
		return [{
			id: `switch-${i + 1}`, command: `switch ${i + 1}`, kind: 'switch' as const,
			label: `Switch to ${species}`,
			switchTo: { slot: i + 1, species, hp: p.condition.split(' ')[0], status: cond.status },
		}];
	});

	if (request.forceSwitch) {
		if (request.forceSwitch.length !== 1) throw new Error('Only singles is supported');
		return switchOptions(!!team[0]?.reviving);
	}

	if (request.active.length !== 1) throw new Error('Only singles is supported');
	const active = request.active[0];
	const choices: LegalChoice[] = [];
	active.moves.forEach((m, i) => {
		if (m.disabled) return;
		const data = dex.moves.get(m.id);
		const move = {
			name: m.move, type: data.type, category: data.category, basePower: data.basePower,
			accuracy: data.accuracy, priority: data.priority, pp: m.pp, maxpp: m.maxpp, target: m.target,
		};
		choices.push({ id: `move-${i + 1}`, command: `move ${i + 1}`, kind: 'move', label: m.move, move });
		if (active.canTerastallize) {
			choices.push({
				id: `move-${i + 1}-tera`, command: `move ${i + 1} terastallize`, kind: 'move',
				label: `${m.move} + Terastallize (${active.canTerastallize})`,
				move, terastallize: active.canTerastallize,
			});
		}
	});
	if (!active.trapped) choices.push(...switchOptions(false));
	return choices;
}
