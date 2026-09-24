/**
 * Offline replay file in the same shape as the client's "Download replay" output
 * (pokemon-showdown-client `src/battle-log.ts` BattleLog.createReplayFile), played back by
 * https://play.pokemonshowdown.com/js/replay-embed.js.
 *
 * Input must be a *spectator* (or omniscient) channel log: the client has no handler for
 * `|split|`, so a raw `battle.log` would replay every split event twice.
 */
export function replayHtml(opts: { log: string, title: string, replayId: string }) {
	if (/^\|split\|/m.test(opts.log)) throw new Error('replay log must be channel-filtered (contains |split|)');
	const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/"/g, '&quot;');
	// Why: the embed script un-escapes `\/`; escaping `/` keeps `</script>` inside the log inert.
	const log = opts.log.replace(/\//g, '\\/');
	return `<!DOCTYPE html>
<meta charset="utf-8" />
<!-- version 1 -->
<title>${esc(opts.title)}</title>
<div class="wrapper replay-wrapper" style="max-width:1180px;margin:0 auto">
<input type="hidden" name="replayid" value="${esc(opts.replayId)}" />
<div class="battle"></div><div class="battle-log"></div><div class="replay-controls"></div><div class="replay-controls-2"></div>
<h1 style="font-weight:normal;text-align:center"><strong>${esc(opts.title)}</strong></h1>
<script type="text/plain" class="battle-log-data">${log}</script>
</div>
<script>
let daily = Math.floor(Date.now()/1000/60/60/24);document.write('<script src="https://play.pokemonshowdown.com/js/replay-embed.js?version'+daily+'"></'+'script>');
</script>
`;
}
