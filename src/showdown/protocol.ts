// Minimal helpers for the Pokémon Showdown text protocol (sim/SIM-PROTOCOL.md).

export interface ProtocolLine {
	cmd: string;
	args: string[];
	/** `[from] X`, `[of] Y`, `[silent]` style keyword tags that trail the positional args. */
	kwargs: Record<string, string>;
	raw: string;
}

export function parseLine(raw: string): ProtocolLine | null {
	if (!raw.startsWith('|')) return null;
	const parts = raw.slice(1).split('|');
	const cmd = parts[0];
	// Why: `|request|` / `|error|` payloads may legitimately contain `|`, so keep them intact.
	if (cmd === 'request' || cmd === 'error' || cmd === 'raw' || cmd === 'html') {
		return { cmd, args: [parts.slice(1).join('|')], kwargs: {}, raw };
	}
	const args: string[] = [];
	const kwargs: Record<string, string> = {};
	for (const part of parts.slice(1)) {
		const m = /^\[([a-z]+)\]\s?(.*)$/.exec(part);
		if (m) kwargs[m[1]] = m[2];
		else args.push(part);
	}
	return { cmd, args, kwargs, raw };
}

export type SideID = 'p1' | 'p2';

/** `p2a: Great Tusk` -> { side: 'p2', position: 'a', name: 'Great Tusk' } */
export function parsePokemonId(id: string): { side: SideID, position: string, name: string } | null {
	const m = /^(p[1-4])([a-z]?): (.*)$/.exec(id);
	if (!m) return null;
	return { side: m[1] as SideID, position: m[2], name: m[3] };
}

/** `Mimikyu, L79, M, tera:Fighting` */
export function parseDetails(details: string) {
	const [species, ...rest] = details.split(', ');
	let level = 100;
	let gender: 'M' | 'F' | undefined;
	let shiny = false;
	let teraType: string | undefined;
	for (const r of rest) {
		if (/^L\d+$/.test(r)) level = parseInt(r.slice(1));
		else if (r === 'M' || r === 'F') gender = r;
		else if (r === 'shiny') shiny = true;
		else if (r.startsWith('tera:')) teraType = r.slice(5);
	}
	return { species, level, gender, shiny, teraType };
}

/** `216/216 par`, `55/100`, `0 fnt` */
export function parseCondition(cond: string) {
	const [hpPart, status] = cond.split(' ');
	if (hpPart === '0') return { hp: 0, maxhp: 100, status: 'fnt' as string | undefined, fainted: true };
	const [hp, maxhp] = hpPart.split('/').map(Number);
	return { hp, maxhp: maxhp || 100, status: status || undefined, fainted: status === 'fnt' };
}

/** Strip `move: ` / `ability: ` / `item: ` prefixes used in effect names. */
export function effectName(effect: string): { kind: string | null, name: string } {
	const m = /^(move|ability|item): (.*)$/.exec(effect);
	return m ? { kind: m[1], name: m[2] } : { kind: null, name: effect };
}
