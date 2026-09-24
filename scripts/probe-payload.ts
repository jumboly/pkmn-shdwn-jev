// Measures the real request-size limit of POST /v1/evaluate (docs are silent; 32KB vs 64KB
// was suspected). Every request goes through the budget guard. Usage:
//   node scripts/probe-payload.ts padding 16 31 33 63 65 100
//   node scripts/probe-payload.ts content 31 33 63 65
//   node scripts/probe-payload.ts prose 31 33 40 63 65
import { openBudget } from '../src/config.ts';
import { GATEWAY_EVALUATE_URL } from '../src/decision/jev.ts';
import { sampleContext } from './sample-context.ts';
import { buildEvaluateBody } from '../src/decision/jev.ts';
import { JsonlLog } from '../src/logging.ts';

const [mode, ...sizesKb] = process.argv.slice(2);
if (!['padding', 'content', 'prose', 'prose-array'].includes(mode)) throw new Error('mode must be padding|content|prose|prose-array');
const key = process.env.AI_GATEWAY_API_KEY;
if (!key) throw new Error('AI_GATEWAY_API_KEY is not set');
const budget = openBudget(`probe-${mode}-${new Date().toISOString()}`);
const log = new JsonlLog(`runs/probes/payload-${mode}.jsonl`);
const ctx = await sampleContext();
const base = buildEvaluateBody(process.env.JEV_MODEL || 'typesafe-ai/jev', ctx, 40);

function makeBody(targetBytes: number): string {
	if (mode === 'padding') {
		// Why: insignificant JSON whitespace grows the HTTP body without adding model tokens,
		// isolating a byte limit from the token limit.
		const json = JSON.stringify(base);
		const pad = targetBytes - Buffer.byteLength(json);
		if (pad < 0) throw new Error('target smaller than base body');
		return json.slice(0, -1) + ' '.repeat(pad) + '}';
	}
	if (mode === 'prose-array') {
		// Same prose split into 1KB strings: separates a per-string limit from a total limit.
		const body = structuredClone(base) as any;
		const sentence = 'The weather was pleasant and everybody enjoyed watching the championship together. ';
		body.state.notes = [];
		while (Buffer.byteLength(JSON.stringify(body)) < targetBytes - 1100) body.state.notes.push(sentence.repeat(13).slice(0, 1024));
		return JSON.stringify(body);
	}
	if (mode === 'prose') {
		// Why: English prose has far more bytes per token than protocol lines, so comparing the
		// two tells a byte limit apart from a token limit.
		const body = structuredClone(base) as any;
		const sentence = 'The weather was pleasant and everybody enjoyed watching the championship together. ';
		const filler = targetBytes - Buffer.byteLength(JSON.stringify(body)) - 12;
		body.state.notes = sentence.repeat(Math.ceil(filler / sentence.length)).slice(0, filler);
		return JSON.stringify(body);
	}
	// content: repeat real protocol lines until the body reaches the target size.
	const events = ctx.state.recentEvents.length ? ctx.state.recentEvents : ['|move|p1a: X|Tackle|p2a: Y'];
	const body = structuredClone(base) as any;
	body.state.recentEvents = [];
	let i = 0;
	while (Buffer.byteLength(JSON.stringify(body)) < targetBytes) body.state.recentEvents.push(`${events[i++ % events.length]}`);
	body.state.recentEvents.pop();
	return JSON.stringify(body);
}

for (const kb of sizesKb.map(Number)) {
	const text = makeBody(kb * 1024);
	const bytes = Buffer.byteLength(text);
	const reservation = budget.reserve();
	const res = await fetch(GATEWAY_EVALUATE_URL, {
		method: 'POST', headers: { 'Authorization': `Bearer ${key}`, 'Content-Type': 'application/json' }, body: text,
	});
	const resText = await res.text();
	let data: any = null;
	try { data = JSON.parse(resText); } catch {}
	const gw = data?.providerMetadata?.gateway;
	const entry = budget.settle(reservation, {
		status: res.ok ? 'ok' : 'error', sent: true,
		reportedCostUsd: gw?.cost !== undefined ? Number(gw.cost) : (res.ok ? null : 0),
		marketCostUsd: gw?.marketCost !== undefined ? Number(gw.marketCost) : null,
		generationId: gw?.generationId, inputTokens: data?.usage?.inputTokens, note: `payload probe ${mode} ${bytes}B -> HTTP ${res.status}`,
	});
	const summary = { mode, kb, bytes, status: res.status, inputTokens: data?.usage?.inputTokens, costUsd: entry.costUsd, error: res.ok ? undefined : resText.slice(0, 400) };
	log.write('probe', summary);
	console.log(JSON.stringify(summary));
	if (!res.ok) break; // Why: stop at the first failure; larger sizes would fail the same way.
}
console.log('[budget] after:', budget.snapshot);
budget.release();
