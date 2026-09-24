import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseCondition, parseDetails, parseLine, parsePokemonId } from '../src/showdown/protocol.ts';

test('parseLine splits args and kwargs', () => {
	const l = parseLine('|-damage|p2a: Great Tusk|55/100|[from] item: Rocky Helmet|[of] p1a: Ferrothorn')!;
	assert.equal(l.cmd, '-damage');
	assert.deepEqual(l.args, ['p2a: Great Tusk', '55/100']);
	assert.deepEqual(l.kwargs, { from: 'item: Rocky Helmet', of: 'p1a: Ferrothorn' });
});

test('parseLine keeps request JSON intact', () => {
	const l = parseLine('|request|{"a":"x|y"}')!;
	assert.equal(l.args[0], '{"a":"x|y"}');
});

test('details / condition / ident parsing', () => {
	assert.deepEqual(parseDetails('Mimikyu, L79, M, tera:Fighting'), { species: 'Mimikyu', level: 79, gender: 'M', shiny: false, teraType: 'Fighting' });
	assert.deepEqual(parseCondition('216/216 par'), { hp: 216, maxhp: 216, status: 'par', fainted: false });
	assert.equal(parseCondition('0 fnt').fainted, true);
	assert.deepEqual(parsePokemonId('p2a: Iron Leaves'), { side: 'p2', position: 'a', name: 'Iron Leaves' });
});
