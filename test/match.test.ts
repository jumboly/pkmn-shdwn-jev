import { test } from 'node:test';
import assert from 'node:assert/strict';
import { matchHumanChoice } from '../src/copilot/match.ts';
import { legalChoices } from '../src/showdown/choices.ts';

const mon = (name: string, active: boolean) => ({ ident: `p1: ${name}`, details: `${name}, L80`, condition: '100/100', active, stats: {}, moves: [], baseAbility: '', item: '', pokeball: '' });
const request = {
	active: [{ moves: [{ move: 'Thunderbolt', id: 'thunderbolt', pp: 1, maxpp: 1, target: 'normal', disabled: false }, { move: 'Volt Switch', id: 'voltswitch', pp: 1, maxpp: 1, target: 'normal', disabled: false }], canTerastallize: 'Electric' }],
	side: { name: 'a', id: 'p1', pokemon: [mon('Zebstrika', true), mon('Great Tusk', false)] },
} as any;
const choices = legalChoices(request);

test('matches slot numbers, names and tera', () => {
	assert.equal(matchHumanChoice('/choose move 2', request, choices), 'move-2');
	assert.equal(matchHumanChoice('move Thunderbolt terastallize', request, choices), 'move-1-tera');
	assert.equal(matchHumanChoice('/choose switch 2', request, choices), 'switch-2');
	assert.equal(matchHumanChoice('switch Great Tusk', request, choices), 'switch-2');
	assert.equal(matchHumanChoice('/choose default', request, choices), null);
});
