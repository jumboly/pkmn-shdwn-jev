// Offline analysis of experiment runs (no API calls).
//   node scripts/analyze.ts runs/<experiment-id> [more dirs...]
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

/** Wilson score interval for a binomial proportion (95%). */
function wilson(k: number, n: number) {
	if (!n) return [0, 0];
	const z = 1.96, p = k / n;
	const d = 1 + z * z / n;
	const c = (p + z * z / (2 * n)) / d;
	const h = z * Math.sqrt(p * (1 - p) / n + z * z / (4 * n * n)) / d;
	return [c - h, c + h];
}
const pct = (x: number) => `${(100 * x).toFixed(1)}%`;

for (const dir of process.argv.slice(2)) {
	const results = readFileSync(join(dir, 'events.jsonl'), 'utf8').trim().split('\n').map(l => JSON.parse(l)).filter(e => e.type === 'battle-result');
	const finished = results.filter(r => r.outcome !== 'aborted');
	const kinds = [...new Set(results.flatMap(r => [r.p1Kind, r.p2Kind]))];
	console.log(`\n== ${dir}: ${results.length} battles (${finished.length} finished, ${results.length - finished.length} aborted)`);
	for (const k of kinds) {
		const games = finished.filter(r => r.p1Kind === k || r.p2Kind === k);
		const wins = games.filter(r => r.winnerKind === k).length;
		const [lo, hi] = wilson(wins, games.length);
		console.log(`  ${k}: ${wins}/${games.length} wins = ${pct(wins / (games.length || 1))} (95% CI ${pct(Math.max(0, lo))}–${pct(Math.min(1, hi))})`);
	}
	const turns = finished.map(r => r.turns);
	const cost = results.reduce((s, r) => s + (r.jevUsage?.costUsd ?? 0), 0);
	const reqs = results.reduce((s, r) => s + (r.jevUsage?.requests ?? 0), 0);
	console.log(`  avg turns ${(turns.reduce((a, b) => a + b, 0) / (turns.length || 1)).toFixed(1)} | JEV requests ${reqs} | booked $${cost.toFixed(5)} ($${(cost / (results.length || 1)).toFixed(5)}/battle)`);

	// Per-decision stats: JEV confidence and mercy behaviour.
	const conf: number[] = [];
	const mercyBins = new Map<string, { n: number, changed: number }>();
	let fallbacks = 0;
	for (const f of readdirSync(join(dir, 'battles')).filter(f => f.endsWith('.jsonl'))) {
		for (const line of readFileSync(join(dir, 'battles', f), 'utf8').trim().split('\n')) {
			const e = JSON.parse(line);
			if (e.type !== 'decision') continue;
			if (e.decision.fallback) fallbacks++;
			if (typeof e.decision.confidence === 'number') conf.push(e.decision.confidence);
			const h = e.decision.handicap;
			if (h?.mode === 'mercy') {
				const bin = h.advantage.value < 0.15 ? '<0.15' : h.advantage.value < 0.4 ? '0.15-0.4' : h.advantage.value < 0.6 ? '0.4-0.6' : '>=0.6';
				const b = mercyBins.get(bin) ?? { n: 0, changed: 0 };
				b.n++; if (h.changed) b.changed++;
				mercyBins.set(bin, b);
			}
		}
	}
	if (conf.length) {
		conf.sort((a, b) => a - b);
		console.log(`  JEV confidence: n=${conf.length} median ${conf[Math.floor(conf.length / 2)].toFixed(2)} p10 ${conf[Math.floor(conf.length * 0.1)].toFixed(2)} p90 ${conf[Math.floor(conf.length * 0.9)].toFixed(2)}`);
	}
	if (fallbacks) console.log(`  fallback decisions: ${fallbacks} (NOT JEV)`);
	for (const [bin, b] of [...mercyBins].sort()) console.log(`  mercy @ advantage ${bin}: changed ${b.changed}/${b.n}`);
}
