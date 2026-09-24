import type { ChoiceRequest } from './types.ts';
import { effectName, parseCondition, parseDetails, parseLine, parsePokemonId, type ProtocolLine, type SideID } from './protocol.ts';
import { Dex } from './sim.ts';

/**
 * Player-visible battle state.
 *
 * INFORMATION BOUNDARY: this tracker must only be fed
 *   1. protocol lines from *this player's* channel (split lines already resolved to
 *      the public half for the opponent), and
 *   2. this player's own `|request|` JSON.
 * It never touches the Battle object, the omniscient stream, or the `end` log
 * (which contains both full teams). Anything about the opponent here was
 * therefore shown to the player on screen.
 */

export interface OwnPokemon {
	ident: string;
	species: string;
	level: number;
	hp: number;
	maxhp: number;
	status?: string;
	fainted: boolean;
	active: boolean;
	types: string[];
	stats: Record<string, number>;
	ability: string;
	item: string;
	moves: string[];
	teraType?: string;
	terastallized?: string;
	boosts: Record<string, number>;
	volatiles: string[];
}

export interface OpponentPokemon {
	ident: string;
	species: string;
	level: number;
	/** Percentage (0-100) as displayed to opponents under HP Percentage Mod. */
	hpPercent: number;
	status?: string;
	fainted: boolean;
	active: boolean;
	/** Current types (dex types, or tera type once terastallized). */
	types: string[];
	/** Public dex knowledge of which abilities this species may have. */
	possibleAbilities: string[];
	baseStats: Record<string, number>;
	/** Only what has been revealed in battle. `null` = not yet revealed. */
	revealedAbility: string | null;
	revealedItem: string | null;
	/** True once the item has been shown to be consumed/removed. */
	itemGone: boolean;
	revealedMoves: string[];
	terastallized?: string;
	boosts: Record<string, number>;
	volatiles: string[];
}

export interface VisibleState {
	perspective: SideID;
	format: string;
	gen: number;
	turn: number;
	self: { name: string, pokemon: OwnPokemon[], sideConditions: string[] };
	opponent: { name: string, teamSize: number, pokemon: OpponentPokemon[], sideConditions: string[] };
	field: { weather: string | null, terrain: string | null, pseudoWeather: string[] };
	/** Public protocol lines since the previous decision (this player's channel only). */
	recentEvents: string[];
}

interface Tracked {
	species: string;
	level: number;
	hpPercent: number;
	hp?: number;
	maxhp?: number;
	status?: string;
	fainted: boolean;
	active: boolean;
	ability: string | null;
	item: string | null;
	itemGone: boolean;
	moves: string[];
	terastallized?: string;
	boosts: Record<string, number>;
	volatiles: string[];
}

// Why: these lines are noise for decision-making and bloat the JEV payload.
const IGNORED_EVENTS = new Set(['t:', 'j', 'l', 'n', 'c', 'chat', 'raw', 'html', 'inactive', 'inactiveoff', 'timer', 'request', 'rule', 'upkeep', 'teampreview', 'clearpoke', 'poke', 'gametype', 'gen', 'tier', 'player', 'teamsize', 'start', '']);

export class VisibleStateTracker {
	readonly perspective: SideID;
	readonly opponentSide: SideID;
	format = '';
	gen = 9;
	turn = 0;
	names: Record<SideID, string> = { p1: '', p2: '' };
	teamSize: Record<SideID, number> = { p1: 6, p2: 6 };
	/** Keyed by `p1: Name`. */
	mons = new Map<string, Tracked>();
	sideConditions: Record<SideID, string[]> = { p1: [], p2: [] };
	weather: string | null = null;
	terrain: string | null = null;
	pseudoWeather: string[] = [];
	recentEvents: string[] = [];
	request: ChoiceRequest | null = null;
	winner: string | null = null;
	ended = false;

	constructor(perspective: SideID) {
		this.perspective = perspective;
		this.opponentSide = perspective === 'p1' ? 'p2' : 'p1';
	}

	feed(chunk: string) {
		for (const raw of chunk.split('\n')) {
			const line = parseLine(raw);
			if (line) this.apply(line);
		}
	}

	private key(id: string) {
		const p = parsePokemonId(id);
		return p ? `${p.side}: ${p.name}` : id;
	}

	private get(id: string): Tracked | undefined {
		return this.mons.get(this.key(id));
	}

	private ensure(id: string, details: string): Tracked {
		const key = this.key(id);
		let mon = this.mons.get(key);
		const d = parseDetails(details);
		if (!mon) {
			mon = {
				species: d.species, level: d.level, hpPercent: 100, fainted: false, active: false,
				ability: null, item: null, itemGone: false, moves: [], boosts: {}, volatiles: [],
			};
			this.mons.set(key, mon);
		}
		mon.species = d.species;
		mon.level = d.level;
		if (d.teraType) mon.terastallized = d.teraType;
		return mon;
	}

	private setHp(mon: Tracked, cond: string) {
		const c = parseCondition(cond);
		mon.hpPercent = c.fainted ? 0 : Math.round(100 * c.hp / c.maxhp);
		if (c.maxhp !== 100) { mon.hp = c.hp; mon.maxhp = c.maxhp; }
		mon.fainted = c.fainted;
		mon.status = c.fainted ? 'fnt' : c.status;
	}

	/** `[from] ability: X` / `[from] item: Y` tags reveal info about `[of]` or the subject. */
	private revealFromTags(line: ProtocolLine, subject?: Tracked) {
		const from = line.kwargs.from;
		if (!from) return;
		const eff = effectName(from);
		const target = line.kwargs.of ? this.get(line.kwargs.of) : subject;
		if (!target) return;
		if (eff.kind === 'ability') target.ability = eff.name;
		if (eff.kind === 'item') target.item = eff.name;
	}

	private apply(line: ProtocolLine) {
		const { cmd, args } = line;
		if (!IGNORED_EVENTS.has(cmd)) {
			this.recentEvents.push(line.raw);
		}
		switch (cmd) {
		case 'player': if (args[1]) this.names[args[0] as SideID] = args[1]; break;
		case 'teamsize': this.teamSize[args[0] as SideID] = parseInt(args[1]); break;
		case 'gen': this.gen = parseInt(args[0]); break;
		case 'tier': this.format = args[0]; break;
		case 'turn': this.turn = parseInt(args[0]); break;
		case 'win': this.winner = args[0]; this.ended = true; break;
		case 'tie': this.ended = true; break;
		case 'request': this.request = JSON.parse(args[0]); break;
		case 'switch': case 'drag': case 'replace': {
			const p = parsePokemonId(args[0]);
			if (!p) break;
			if (cmd !== 'replace') {
				for (const [k, m] of this.mons) {
					if (k.startsWith(`${p.side}: `) && m.active) {
						m.active = false; m.boosts = {}; m.volatiles = [];
					}
				}
			} else {
				// Why: Illusion broke; the previously displayed mon was never actually out.
				for (const [k, m] of this.mons) if (k.startsWith(`${p.side}: `)) m.active = false;
			}
			const mon = this.ensure(args[0], args[1]);
			mon.active = true;
			if (args[2]) this.setHp(mon, args[2]);
			break;
		}
		case 'detailschange': case '-formechange': {
			const mon = this.get(args[0]);
			if (mon && cmd === 'detailschange') this.ensure(args[0], args[1]);
			else if (mon) mon.volatiles = [...mon.volatiles.filter(v => !v.startsWith('forme:')), `forme:${args[1]}`];
			break;
		}
		case '-damage': case '-heal': case '-sethp': {
			const mon = this.get(args[0]);
			if (mon && args[1]) this.setHp(mon, args[1]);
			this.revealFromTags(line, mon);
			break;
		}
		case 'faint': { const mon = this.get(args[0]); if (mon) { mon.fainted = true; mon.hpPercent = 0; mon.status = 'fnt'; } break; }
		case '-status': { const mon = this.get(args[0]); if (mon) mon.status = args[1]; this.revealFromTags(line, mon); break; }
		case '-curestatus': { const mon = this.get(args[0]); if (mon) mon.status = undefined; break; }
		case '-cureteam': {
			const p = parsePokemonId(args[0]);
			if (p) for (const [k, m] of this.mons) if (k.startsWith(`${p.side}: `) && !m.fainted) m.status = undefined;
			break;
		}
		case '-boost': case '-unboost': {
			const mon = this.get(args[0]);
			if (mon) {
				const delta = parseInt(args[2]) * (cmd === '-boost' ? 1 : -1);
				mon.boosts[args[1]] = Math.max(-6, Math.min(6, (mon.boosts[args[1]] ?? 0) + delta));
			}
			this.revealFromTags(line, mon);
			break;
		}
		case '-setboost': { const mon = this.get(args[0]); if (mon) mon.boosts[args[1]] = parseInt(args[2]); break; }
		case '-clearboost': { const mon = this.get(args[0]); if (mon) mon.boosts = {}; break; }
		case '-clearallboost': for (const m of this.mons.values()) m.boosts = {}; break;
		case '-clearnegativeboost': {
			const mon = this.get(args[0]);
			if (mon) for (const s of Object.keys(mon.boosts)) if (mon.boosts[s] < 0) delete mon.boosts[s];
			break;
		}
		case '-invertboost': { const mon = this.get(args[0]); if (mon) for (const s of Object.keys(mon.boosts)) mon.boosts[s] *= -1; break; }
		case '-copyboost': {
			const src = this.get(args[0]); const dst = this.get(args[1]);
			if (src && dst) dst.boosts = { ...src.boosts };
			break;
		}
		case 'move': {
			const mon = this.get(args[0]);
			// Why: moves invoked by other moves (Sleep Talk, Metronome, ...) carry `[from]`
			// and are not part of the user's moveset.
			if (mon && !line.kwargs.from && !mon.moves.includes(args[1])) mon.moves.push(args[1]);
			break;
		}
		case '-item': {
			const mon = this.get(args[0]);
			if (mon) { mon.item = args[1]; mon.itemGone = false; }
			this.revealFromTags(line, undefined);
			break;
		}
		case '-enditem': { const mon = this.get(args[0]); if (mon) { mon.item = args[1]; mon.itemGone = true; } break; }
		case '-ability': { const mon = this.get(args[0]); if (mon) mon.ability = args[1]; this.revealFromTags(line, undefined); break; }
		case '-terastallize': { const mon = this.get(args[0]); if (mon) mon.terastallized = args[1]; break; }
		case '-start': {
			const mon = this.get(args[0]);
			if (mon) {
				const v = effectName(args[1]).name;
				if (!mon.volatiles.includes(v)) mon.volatiles.push(v);
			}
			this.revealFromTags(line, mon);
			break;
		}
		case '-end': {
			const mon = this.get(args[0]);
			if (mon) { const v = effectName(args[1]).name; mon.volatiles = mon.volatiles.filter(x => x !== v); }
			break;
		}
		case '-weather': this.weather = args[0] === 'none' ? null : args[0]; this.revealFromTags(line, undefined); break;
		case '-fieldstart': {
			const name = effectName(args[0]).name;
			if (/Terrain$/.test(name)) this.terrain = name;
			else if (!this.pseudoWeather.includes(name)) this.pseudoWeather.push(name);
			this.revealFromTags(line, undefined);
			break;
		}
		case '-fieldend': {
			const name = effectName(args[0]).name;
			if (this.terrain === name) this.terrain = null;
			this.pseudoWeather = this.pseudoWeather.filter(x => x !== name);
			break;
		}
		case '-sidestart': case '-sideend': {
			const side = args[0].slice(0, 2) as SideID;
			const name = effectName(args[1]).name;
			const list = this.sideConditions[side].filter(x => x !== name);
			// Why: hazards like Spikes stack; keep one entry per layer for the model.
			if (cmd === '-sidestart') list.push(...this.sideConditions[side].filter(x => x === name), name);
			this.sideConditions[side] = list;
			break;
		}
		}
	}

	/** Build the snapshot handed to decision providers, then reset the recent-event window. */
	snapshot(): VisibleState {
		const dex = Dex.forGen(this.gen);
		const req = this.request;
		const self: OwnPokemon[] = (req?.side.pokemon ?? []).map(p => {
			const tracked = this.mons.get(p.ident);
			const d = parseDetails(p.details);
			const c = parseCondition(p.condition);
			const species = dex.species.get(d.species);
			const tera = p.terastallized || undefined;
			return {
				ident: p.ident, species: d.species, level: d.level,
				hp: c.hp, maxhp: c.maxhp, status: c.status, fainted: c.fainted, active: p.active,
				types: tera ? [tera] : [...species.types],
				stats: { ...p.stats }, ability: dex.abilities.get(p.ability ?? p.baseAbility).name,
				item: p.item ? dex.items.get(p.item).name : '(none)',
				moves: p.moves.map(m => dex.moves.get(m).name),
				teraType: p.teraType, terastallized: tera,
				boosts: p.active ? { ...tracked?.boosts } : {},
				volatiles: p.active ? [...(tracked?.volatiles ?? [])] : [],
			};
		});
		const opponent: OpponentPokemon[] = [];
		for (const [key, m] of this.mons) {
			if (!key.startsWith(`${this.opponentSide}: `)) continue;
			const species = dex.species.get(m.species);
			opponent.push({
				ident: key, species: m.species, level: m.level, hpPercent: m.hpPercent,
				status: m.status, fainted: m.fainted, active: m.active,
				types: m.terastallized ? [m.terastallized] : [...species.types],
				possibleAbilities: Object.values(species.abilities),
				baseStats: { ...species.baseStats },
				revealedAbility: m.ability, revealedItem: m.item, itemGone: m.itemGone,
				revealedMoves: [...m.moves], terastallized: m.terastallized,
				boosts: { ...m.boosts }, volatiles: [...m.volatiles],
			});
		}
		const state: VisibleState = {
			perspective: this.perspective,
			format: this.format,
			gen: this.gen,
			turn: this.turn,
			self: { name: this.names[this.perspective], pokemon: self, sideConditions: [...this.sideConditions[this.perspective]] },
			opponent: {
				name: this.names[this.opponentSide], teamSize: this.teamSize[this.opponentSide],
				pokemon: opponent, sideConditions: [...this.sideConditions[this.opponentSide]],
			},
			field: { weather: this.weather, terrain: this.terrain, pseudoWeather: [...this.pseudoWeather] },
			recentEvents: this.recentEvents,
		};
		this.recentEvents = [];
		return state;
	}
}
