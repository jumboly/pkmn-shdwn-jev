import type { Advice } from './proxy.ts';

/**
 * Advice rendered INTO the battle log of the human's own Showdown client.
 *
 * Why: a second window next to the battle is awkward to use. The official client already
 * renders `|uhtml|NAME|HTML` from the server (and replaces it on `|uhtmlchange|`), so the
 * proxy can show advice in place without forking the (AGPL) client. The proxy only ADDS
 * display lines on the server->client path; it still never sends anything upstream.
 */

const esc = (s: unknown) => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]!));

/** One uhtml box per request, so each turn keeps its own (updatable) advice. */
export function inlineName(a: Pick<Advice, 'rqid' | 'turn'>) {
	return `jevcopilot-${a.rqid ?? `t${a.turn}`}`;
}

export function renderInlineAdvice(a: Advice): string {
	const head = `<b>JEV Copilot</b> <small>ターン ${esc(a.turn)}</small>`;
	if (a.error) return box(`${head}<br><span style="color:#b3261e">JEV エラー: ${esc(a.error)}</span><br><small>自分で判断してください。</small>`);
	if (!a.jev) return box(`${head}<br><small>JEV 考え中…</small>`);

	const probs = a.jev.probabilities ?? {};
	// Why: sort by JEV's probability so the top candidates are read first in a narrow log.
	const choices = [...a.choices].sort((x, y) => (probs[y.id] ?? -1) - (probs[x.id] ?? -1));
	const rows = choices.map(c => {
		const p = probs[c.id];
		const best = a.jev!.best === c.id;
		const mine = a.human?.choiceId === c.id;
		const m = c.move;
		const facts = m
			? [m.type, m.basePower ? `${m.basePower}` : '', m.accuracy === true ? '必中' : `${m.accuracy}%`, c.typeChart ? `x${c.typeChart.multiplier}` : '', c.terastallize ? `テラス→${c.terastallize}` : ''].filter(Boolean).join(' ')
			: c.switchTo ? `HP ${c.switchTo.hp}` : '';
		const pct = p !== undefined ? Math.round(p * 100) : null;
		const bar = pct !== null ? `<span style="display:inline-block;height:6px;width:${Math.max(1, Math.round(pct * 0.6))}px;background:#3b6fd8;border-radius:3px;vertical-align:middle"></span> ${pct}%` : '';
		const tags = `${best ? ' <b style="color:#1d6fd8">★推奨</b>' : ''}${mine ? ' <b style="color:#b07b00">◀あなた</b>' : ''}`;
		return `<tr${best ? ' style="background:rgba(59,111,216,.12)"' : ''}><td>${esc(c.label)}${tags}<br><small style="opacity:.75">${esc(facts)}</small></td><td style="white-space:nowrap;text-align:right">${bar}</td></tr>`;
	}).join('');
	const verdict = a.human && a.human.matchesJev !== null
		? `<br>${a.human.matchesJev ? '<span style="color:#1d8a4a">JEV と一致</span>' : '<span style="color:#b3261e">JEV と不一致</span>'}`
		: '';
	const conf = a.jev.confidence !== undefined ? ` · 確信度 ${a.jev.confidence.toFixed(2)}` : '';
	return box(`${head}<small>${esc(conf)}</small><table style="width:100%;border-collapse:collapse;margin-top:4px">${rows}</table>${verdict}<br><small style="opacity:.7">助言のみ。行動はあなたが選びます。</small>`);
}

function box(inner: string) {
	// Why: the protocol is line-based; any newline would end the uhtml message early.
	return `<div class="infobox">${inner}</div>`.replace(/[\r\n]+/g, ' ');
}

/** A server->client frame that creates or replaces the advice box in that battle room. */
export function inlineFrame(a: Advice, change: boolean): string {
	return `>${a.roomid}\n|${change ? 'uhtmlchange' : 'uhtml'}|${inlineName(a)}|${renderInlineAdvice(a)}`;
}
