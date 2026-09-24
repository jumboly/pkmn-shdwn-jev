import { test } from 'node:test';
import assert from 'node:assert/strict';
import { legalChoices } from '../src/showdown/choices.ts';

const mon = (name: string, cond: string, active: boolean) => ({
	ident: `p1: ${name}`, details: `${name}, L80`, condition: cond, active, stats: { atk: 1, def: 1, spa: 1, spd: 1, spe: 1 },
	moves: [], baseAbility: 'pressure', item: '', pokeball: 'pokeball',
}) as any;
const side = { name: 'A', id: 'p1', pokemon: [mon('Mew', '100/100', true), mon('Ditto', '50/100', false), mon('Eevee', '0 fnt', false)] } as any;
const moves = [
	{ move: 'Psychic', id: 'psychic', pp: 16, maxpp: 16, target: 'normal', disabled: false },
	{ move: 'Recover', id: 'recover', pp: 0, maxpp: 8, target: 'self', disabled: true },
];

test('move request: disabled moves excluded, tera variants, fainted not switchable', () => {
	const c = legalChoices({ active: [{ moves, canTerastallize: 'Fairy' }], side } as any);
	assert.deepEqual(c.map(x => x.command), ['move 1', 'move 1 terastallize', 'switch 2']);
	assert.equal(c[0].move?.basePower, 90);
	assert.equal(c[0].move?.type, 'Psychic');
});

test('trapped: no switches', () => {
	const c = legalChoices({ active: [{ moves, trapped: true }], side } as any);
	assert.deepEqual(c.map(x => x.command), ['move 1']);
});

test('force switch and revival blessing', () => {
	assert.deepEqual(legalChoices({ forceSwitch: [true], side } as any).map(x => x.command), ['switch 2']);
	const reviving = { ...side, pokemon: [{ ...side.pokemon[0], reviving: true }, ...side.pokemon.slice(1)] };
	assert.deepEqual(legalChoices({ forceSwitch: [true], side: reviving } as any).map(x => x.command), ['switch 3']);
});

test('wait request has no choices', () => {
	assert.deepEqual(legalChoices({ wait: true, side } as any), []);
});
