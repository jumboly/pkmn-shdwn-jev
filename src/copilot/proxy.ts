import http from 'node:http';
import { join } from 'node:path';
import { WebSocket, WebSocketServer } from 'ws';
import type { DecisionProvider, Decision } from '../decision/types.ts';
import { typeMultiplier } from '../decision/jev.ts';
import { applyHandicap } from '../decision/handicap.ts';
import { JsonlLog } from '../logging.ts';
import { BattleRoomObserver, parseFrame, type PendingDecision } from '../server/room.ts';
import { PRNG } from '../showdown/sim.ts';
import { matchHumanChoice } from './match.ts';
import { inlineFrame, inlineName } from './inline.ts';

/**
 * Copilot Mode: a transparent WebSocket proxy between the human's normal Showdown client and
 * the (local) server. It reads only what the server sends to *this human's* connection, asks
 * JEV for advice, and shows it in a companion page. It NEVER sends choices on the human's
 * behalf; client->server traffic is forwarded byte-for-byte and only observed for logging.
 */

export interface CopilotOptions {
	listenPort: number;
	upstream: string; // e.g. http://127.0.0.1:8001
	uiPort: number;
	provider: DecisionProvider;
	logDir: string;
	/** Also show what Mercy mode would have picked (display only). */
	showMercy?: number;
	budgetInfo?: () => unknown;
	/** Also show advice inside the battle log of the human's client (default true). */
	inline?: boolean;
}

export interface Advice {
	roomid: string;
	rqid?: number;
	turn: number;
	side: string;
	state: PendingDecision['state'];
	/** Game facts computed deterministically by the controller (not by JEV). */
	choices: (PendingDecision['choices'][number] & { typeChart?: { target: string, multiplier: number } | null })[];
	jev?: { best: string, probabilities?: Record<string, number>, confidence?: number, costUsd?: number, requests?: number, provider: string };
	mercy?: { choiceId: string, advantage: number, mercyLevel: number };
	error?: string;
	human?: { choiceId: string | null, raw: string, matchesJev: boolean | null };
}

export function startCopilot(opts: CopilotOptions) {
	const log = new JsonlLog(join(opts.logDir, 'copilot.jsonl'));
	const advice = new Map<string, Advice>();
	const pendingRequests = new Map<string, PendingDecision>();
	const sseClients = new Set<http.ServerResponse>();
	const mercyPrng = new PRNG('sodium,00000000000000000000000000000c00' as any);
	/** Human client connections per battle room, for in-battle (inline) advice. */
	const roomClients = new Map<string, Set<WebSocket>>();
	const shownBoxes = new Set<string>();
	const publish = (a: Advice) => {
		advice.set(a.roomid, a);
		const data = `data: ${JSON.stringify(a)}\n\n`;
		for (const res of sseClients) res.write(data);
		if (opts.inline === false) return;
		const key = `${a.roomid}|${inlineName(a)}`;
		const frame = inlineFrame(a, shownBoxes.has(key));
		shownBoxes.add(key);
		for (const c of roomClients.get(a.roomid) ?? []) if (c.readyState === WebSocket.OPEN) c.send(frame);
	};

	async function advise(d: PendingDecision) {
		pendingRequests.set(d.roomid, d);
		const base: Advice = {
			roomid: d.roomid, rqid: d.request.rqid, turn: d.state.turn, side: d.side, state: d.state,
			choices: d.choices.map(c => ({ ...c, typeChart: c.move && c.move.category !== 'Status' ? typeMultiplier(c.terastallize && c.move.name === 'Tera Blast' ? c.terastallize : c.move.type, d.state) : null })),
		};
		publish(base);
		try {
			const decision: Decision = await opts.provider.decide({ battleId: d.roomid, side: d.side, state: d.state, choices: d.choices });
			const a: Advice = {
				...base,
				jev: { best: decision.choiceId, probabilities: decision.scores, confidence: decision.confidence, costUsd: decision.usage?.costUsd, requests: decision.usage?.requests, provider: decision.provider },
			};
			if (opts.showMercy) {
				const h = applyHandicap(decision, { battleId: d.roomid, side: d.side, state: d.state, choices: d.choices }, { mode: 'mercy', strength: opts.showMercy }, mercyPrng);
				a.mercy = { choiceId: h.finalChoiceId, advantage: h.advantage.value, mercyLevel: h.mercyLevel };
			}
			// Why: the human may have already chosen while JEV was thinking; keep their choice.
			const prev = advice.get(d.roomid);
			if (prev && prev.rqid === a.rqid && prev.human) a.human = { ...prev.human, matchesJev: prev.human.choiceId === a.jev!.best };
			log.write('copilot-advice', { roomid: d.roomid, rqid: d.request.rqid, turn: d.state.turn, side: d.side, request: d.request, state: d.state, choices: d.choices, decision });
			publish(a);
		} catch (err: any) {
			log.write('copilot-error', { roomid: d.roomid, turn: d.state.turn, error: String(err?.message ?? err), code: err?.code });
			publish({ ...base, error: String(err?.message ?? err) });
		}
	}

	function onHumanMessage(text: string) {
		// Client->server frames look like `battle-xxx|/choose move 1|rqid`.
		const [roomid, body, rqid] = text.split('|');
		if (!roomid?.startsWith('battle-') || !body) return;
		if (!/^\/(choose|move|switch)\b/.test(body)) return;
		const d = pendingRequests.get(roomid);
		const a = advice.get(roomid);
		if (!d) return;
		const choiceId = matchHumanChoice(body.replace(/^\/(move|switch)/, '$1'), d.request, d.choices);
		const jevBest = a?.jev?.best ?? null;
		const record = { roomid, rqid: rqid ? Number(rqid) : d.request.rqid, turn: d.state.turn, humanRaw: body, humanChoiceId: choiceId, jevBestChoiceId: jevBest, matchesJev: jevBest ? choiceId === jevBest : null, jevCostUsd: a?.jev?.costUsd ?? null };
		log.write('copilot-human-choice', record);
		if (a) publish({ ...a, human: { choiceId, raw: body, matchesJev: record.matchesJev } });
	}

	// --- proxy ---------------------------------------------------------------
	const upstreamWs = opts.upstream.replace(/^http/, 'ws');
	const proxy = http.createServer(async (req, res) => {
		// Plain HTTP (e.g. /showdown/info) is forwarded unchanged.
		try {
			const r = await fetch(opts.upstream + req.url, { method: req.method, headers: { accept: req.headers.accept ?? '*/*' } });
			res.writeHead(r.status, Object.fromEntries([...r.headers].filter(([k]) => !['content-encoding', 'content-length', 'transfer-encoding'].includes(k))));
			res.end(Buffer.from(await r.arrayBuffer()));
		} catch (err) {
			res.writeHead(502).end(String(err));
		}
	});
	const wss = new WebSocketServer({ noServer: true });
	proxy.on('upgrade', (req, socket, head) => {
		wss.handleUpgrade(req, socket, head, client => {
			const upstream = new WebSocket(upstreamWs + req.url);
			const queue: string[] = [];
			let username = '';
			const observers = new Map<string, BattleRoomObserver>();
			upstream.on('open', () => { for (const m of queue.splice(0)) upstream.send(m); });
			upstream.on('message', data => {
				const text = data.toString();
				client.send(text);
				const { roomid, lines } = parseFrame(text);
				for (const line of lines) {
					if (line.startsWith('|updateuser|')) username = line.split('|')[2].trim().replace(/^[^a-zA-Z0-9]/, '');
				}
				if (!roomid.startsWith('battle-') || !username) return;
				let obs = observers.get(roomid);
				if (!obs) {
					obs = new BattleRoomObserver(roomid, username, d => void advise(d));
					observers.set(roomid, obs);
					if (!roomClients.has(roomid)) roomClients.set(roomid, new Set());
					roomClients.get(roomid)!.add(client);
				}
				obs.feed(lines);
			});
			client.on('message', data => {
				const text = data.toString();
				if (upstream.readyState === WebSocket.OPEN) upstream.send(text); else queue.push(text);
				onHumanMessage(text);
			});
			client.on('close', () => {
				upstream.close();
				for (const set of roomClients.values()) set.delete(client);
			});
			upstream.on('close', () => client.close());
			upstream.on('error', () => client.close());
		});
	});
	proxy.listen(opts.listenPort, '127.0.0.1');

	// --- companion UI --------------------------------------------------------
	const ui = http.createServer((req, res) => {
		if (req.url === '/events') {
			res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache', connection: 'keep-alive' });
			for (const a of advice.values()) res.write(`data: ${JSON.stringify(a)}\n\n`);
			sseClients.add(res);
			req.on('close', () => sseClients.delete(res));
			return;
		}
		if (req.url === '/budget') {
			res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify(opts.budgetInfo?.() ?? null));
			return;
		}
		res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' }).end(UI_HTML);
	});
	ui.listen(opts.uiPort, '127.0.0.1');
	return { close: () => { proxy.close(); ui.close(); wss.close(); }, log };
}

const UI_HTML = `<!doctype html><html lang="ja"><meta charset="utf-8"><title>JEV Copilot</title>
<meta name="viewport" content="width=device-width,initial-scale=1">
<style>
:root{--bg:#f6f7f9;--card:#fff;--fg:#1c1f24;--muted:#667;--line:#dde1e6;--bar:#3b6fd8;--best:#e8f0ff;--human:#fff4d6;--ok:#1d8a4a;--ng:#b3261e}
@media (prefers-color-scheme:dark){:root{--bg:#15171b;--card:#1e2126;--fg:#e6e8eb;--muted:#99a;--line:#333840;--bar:#6f98ff;--best:#1f2c48;--human:#3a3218}}
body{margin:0;background:var(--bg);color:var(--fg);font:14px/1.45 system-ui,sans-serif}
main{max-width:980px;margin:0 auto;padding:16px}
h1{font-size:18px;margin:0 0 4px}.muted{color:var(--muted)}
.card{background:var(--card);border:1px solid var(--line);border-radius:10px;padding:12px 14px;margin:12px 0}
table{width:100%;border-collapse:collapse}th,td{padding:6px 8px;border-bottom:1px solid var(--line);text-align:left;vertical-align:top}
th{font-size:12px;color:var(--muted);font-weight:600}
tr.best td{background:var(--best)} tr.human td:first-child{box-shadow:inset 4px 0 0 #e0a800}
.bar{height:8px;background:var(--bar);border-radius:4px;min-width:1px}
.tag{display:inline-block;padding:1px 6px;border-radius:6px;border:1px solid var(--line);font-size:12px;margin-right:4px}
.ok{color:var(--ok)}.ng{color:var(--ng)} .grid{display:grid;grid-template-columns:1fr 1fr;gap:12px}
@media (max-width:640px){.grid{grid-template-columns:1fr}}
</style>
<main>
<h1>JEV Copilot</h1>
<div class="muted">JEV は助言のみ。行動は必ずあなたが Showdown 画面で選んでください（自動送信しません）。<span id="budget"></span></div>
<div id="rooms"><div class="card muted">対戦を開始すると、ここにあなたの手番ごとの助言が表示されます。</div></div>
</main>
<script>
const rooms = {};
const esc = s => String(s ?? '').replace(/[&<>"]/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'}[c]));
function mon(p, own){ if(!p) return '-'; const hp = own ? p.hp+'/'+p.maxhp : p.hpPercent+'%';
  const boosts = Object.entries(p.boosts||{}).filter(([,v])=>v).map(([k,v])=>k+(v>0?'+':'')+v).join(' ');
  return '<b>'+esc(p.species)+'</b> L'+p.level+' <span class="tag">'+esc((p.types||[]).join('/'))+'</span> HP '+hp+(p.status?' <span class="tag">'+esc(p.status)+'</span>':'')+(boosts?' '+esc(boosts):'')
   + (own ? '' : '<div class="muted">判明済み: 技 '+esc((p.revealedMoves||[]).join(', ')||'なし')+' / 持ち物 '+esc(p.revealedItem||'不明')+' / 特性 '+esc(p.revealedAbility||'不明')+'</div>'); }
function render(){
  const el = document.getElementById('rooms'); const list = Object.values(rooms).sort((a,b)=>b.roomid.localeCompare(a.roomid));
  if(!list.length) return;
  el.innerHTML = list.map(a => {
    const me = a.state.self.pokemon.find(p=>p.active), foe = a.state.opponent.pokemon.find(p=>p.active);
    const probs = a.jev?.probabilities || {};
    const rows = a.choices.map(c => {
      const p = probs[c.id]; const m = c.move;
      const facts = m ? [m.type, m.category, m.basePower ? m.basePower+'BP' : '', m.accuracy===true?'必中':m.accuracy+'%', m.priority?('優先度'+(m.priority>0?'+':'')+m.priority):'', m.pp!==undefined?'PP '+m.pp+'/'+m.maxpp:'', c.typeChart?('相性 x'+c.typeChart.multiplier):'', c.terastallize?'テラスタル→'+c.terastallize:''].filter(Boolean).join(' · ')
        : c.switchTo ? 'HP '+c.switchTo.hp+(c.switchTo.status?' '+c.switchTo.status:'') : '';
      const cls = [a.jev?.best===c.id?'best':'', a.human?.choiceId===c.id?'human':''].join(' ');
      return '<tr class="'+cls+'"><td>'+esc(c.label)+(a.jev?.best===c.id?' <span class="tag">JEV推奨</span>':'')+(a.mercy?.choiceId===c.id&&a.mercy.choiceId!==a.jev?.best?' <span class="tag">Mercy</span>':'')+(a.human?.choiceId===c.id?' <span class="tag">あなた</span>':'')+'</td><td class="muted">'+esc(facts)+'</td><td style="width:180px">'+(p!==undefined?'<div class="bar" style="width:'+Math.round(p*160)+'px"></div>'+(p*100).toFixed(0)+'%':'')+'</td></tr>';
    }).join('');
    const status = a.error ? '<span class="ng">JEV エラー: '+esc(a.error)+'</span>' : a.jev ? 'confidence '+(a.jev.confidence!==undefined?a.jev.confidence.toFixed(2):'-')+' · cost $'+(a.jev.costUsd??0).toFixed(6)+' · '+esc(a.jev.provider) : 'JEV 問い合わせ中…';
    const human = a.human ? (a.human.matchesJev===null?'':a.human.matchesJev?' · <span class="ok">あなたの選択は JEV と一致</span>':' · <span class="ng">あなたの選択は JEV と不一致</span>') : '';
    return '<div class="card"><div><b>'+esc(a.roomid)+'</b> · Turn '+a.turn+' · '+status+human+'</div>'
      + '<div class="grid" style="margin-top:8px"><div><div class="muted">自分（確定情報）</div>'+mon(me,true)+'</div><div><div class="muted">相手（公開情報のみ）</div>'+mon(foe,false)+'</div></div>'
      + '<div class="muted" style="margin-top:6px">天候 '+esc(a.state.field.weather||'なし')+' · フィールド '+esc(a.state.field.terrain||'なし')+' · 自陣 '+esc(a.state.self.sideConditions.join(', ')||'-')+' · 相手陣 '+esc(a.state.opponent.sideConditions.join(', ')||'-')+'</div>'
      + '<table style="margin-top:8px"><tr><th>候補</th><th>確定情報（ゲームデータ）</th><th>JEV の評価（確率）</th></tr>'+rows+'</table></div>';
  }).join('');
}
new EventSource('/events').onmessage = e => { const a = JSON.parse(e.data); rooms[a.roomid] = a; render(); };
setInterval(async () => { try { const b = await (await fetch('/budget')).json(); if (b) document.getElementById('budget').textContent = ' 予算: 累計 $'+b.spentTotalUsd+' / 停止 $'+b.stopThresholdUsd+' (上限 $'+b.budgetUsd+')'; } catch {} }, 5000);
</script></html>`;
