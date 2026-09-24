import { test } from 'node:test';
import assert from 'node:assert/strict';
import { inlineFrame, renderInlineAdvice } from '../src/copilot/inline.ts';

const base: any = {
	roomid: 'battle-gen9randombattle-1', rqid: 7, turn: 3, side: 'p1', state: {},
	choices: [
		{ id: 'move-1', label: 'Tackle <script>', move: { type: 'Normal', basePower: 40, accuracy: 100 }, typeChart: { target: 'X', multiplier: 1 } },
		{ id: 'switch-2', label: 'Switch to Mew', switchTo: { hp: '100/100' } },
	],
};

test('inline advice: thinking box, then result sorted by probability with the pick marked', () => {
	assert.match(renderInlineAdvice(base), /JEV 考え中/);
	const html = renderInlineAdvice({ ...base, jev: { best: 'switch-2', probabilities: { 'move-1': 0.3, 'switch-2': 0.7 }, provider: 'mock' } });
	assert.ok(html.indexOf('Switch to Mew') < html.indexOf('Tackle'), 'higher probability first');
	assert.match(html, /Switch to Mew <b[^>]*>★推奨/);
	assert.match(html, /70%/);
	assert.doesNotMatch(html, /<script>/, 'labels are escaped');
	assert.doesNotMatch(html, /\n/, 'single protocol line');
});

test('inline advice: human choice and match are shown; errors say to decide yourself', () => {
	const html = renderInlineAdvice({ ...base, jev: { best: 'move-1', probabilities: {}, provider: 'mock' }, human: { choiceId: 'move-1', raw: '/choose move 1', matchesJev: true } });
	assert.match(html, /◀あなた/);
	assert.match(html, /JEV と一致/);
	assert.match(renderInlineAdvice({ ...base, error: 'gateway 503' }), /JEV エラー: gateway 503/);
});

test('inline frame: uhtml first, uhtmlchange for updates, one box per request', () => {
	assert.match(inlineFrame(base, false), /^>battle-gen9randombattle-1\n\|uhtml\|jevcopilot-7\|<div/);
	assert.match(inlineFrame(base, true), /^>battle-gen9randombattle-1\n\|uhtmlchange\|jevcopilot-7\|/);
});
