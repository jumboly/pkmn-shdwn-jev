import type { LegalChoice } from '../showdown/choices.ts';
import { parseDetails } from '../showdown/protocol.ts';
import type { ChoiceRequest } from '../showdown/types.ts';
import { toID } from '../server/room.ts';

/**
 * Map a human's `/choose ...` text (as sent by the Showdown client) to one of our legal
 * choice ids, so Copilot can log whether the human followed JEV. Accepts slot numbers or
 * names (`move 2`, `move thunderbolt terastallize`, `switch 3`, `switch Great Tusk`).
 */
export function matchHumanChoice(text: string, request: ChoiceRequest, choices: LegalChoice[]): string | null {
	const cmd = text.trim().replace(/^\/choose\s+/, '').replace(/^\//, '');
	const m = /^(move|switch)\s+(.+?)(\s+(terastallize|terastal|tera))?$/i.exec(cmd);
	if (!m) return null;
	const [, kind, rawTarget, , tera] = m;
	const target = rawTarget.trim();
	if (kind.toLowerCase() === 'move') {
		if (request.wait || request.teamPreview || request.forceSwitch) return null;
		const moves = request.active[0].moves;
		const slot = /^\d+$/.test(target) ? Number(target) : moves.findIndex(mv => toID(mv.move) === toID(target) || mv.id === toID(target)) + 1;
		const id = `move-${slot}${tera ? '-tera' : ''}`;
		return choices.some(c => c.id === id) ? id : null;
	}
	const team = request.side.pokemon;
	const slot = /^\d+$/.test(target) ? Number(target) : team.findIndex(p => toID(parseDetails(p.details).species) === toID(target) || toID(p.ident.slice(4)) === toID(target)) + 1;
	const id = `switch-${slot}`;
	return choices.some(c => c.id === id) ? id : null;
}
