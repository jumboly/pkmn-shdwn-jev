# Implementation status

_Last updated: 2026-09-24_

## JEV live usage (from `runs/jev-cost-ledger.jsonl`)
- **1,030 requests** in total. **Booked $0.1008** at `max(cost, marketCost)`. The gateway-reported cost is $0 (free promotion until 2026-09-25).
- **Remaining before the stop threshold ($4.50): about $4.40.** The hard cap is $5.00.
- About $0.003 per battle per JEV side. Throughput is about 17 req/min because of gateway rate limiting (D16).

## Done (verified)
- **Phase 0**: mise/Node 24 scaffold, `.env.example`, `.gitignore`, decision log, licensing notes.
- **Phase 1**: simulator vertical slice.
  - Random Battle runs start to finish with legal choices only.
  - Seeds are reproducible (per-player team seeds are derived from the battle seed).
  - The information-boundary test passes.
- **Phase 2**: JEV integration.
  - `/v1/evaluate` provider with retries, 402 → budget stop, invalid-answer rejection and explicit fallback.
  - Mock gateway.
  - Live smoke: one request.
  - JEV vs random: 2 battles. JEV vs JEV: 1 battle.
  - Payload-limit investigation: 27 probes. Result: no byte cap; failures depend on content shape (D10).
- **Phase 3**: experiment runner.
  - Seeds, per-battle JSONL, spectator log, input log and replay HTML.
  - Budget guard with persistent ledger, lock, pre-request reservation and new-battle headroom.
  - Replay HTML verified in headless Chromium (0 errors).
- **Phase 4**: Server transport.
  - `AutonomousClient` with local-only guard.
  - Integration test: two bots on a real local server.
  - Human vs bot through the official client at `localhost.psim.us`, verified with Playwright.
- **Phase 5**: Copilot.
  - WS proxy plus advice page (deterministic facts and JEV probabilities kept separate).
  - Logs human choice, JEV top choice, match, and cost.
  - Automated integration test plus a manual screenshot check.
- **Adaptive Strength**: `HandicapProvider` (No Mercy / Mercy, strength 0..1), heuristic advantage, per-decision logging.
  - Live: no-mercy vs mercy, 2 battles. Mercy changed 3 of 42 decisions, all while clearly ahead.
- **Experiment results**: JEV vs random 26/26 wins (20 in `live-jev-vs-random-20` + 6 in `live-limiter-check-01`).
  - 95% CI for the 20-battle run: 83.9–100%. Average 23.6 turns. JEV confidence median 0.28.
- **Experiments on 2026-09-24** (seed `jev-exp-02` / `jev-experiment`):
  - `live-jev-vs-jev-10`: 10/10 finished; p1 5 wins, p2 5 wins.
  - `live-nomercy-vs-mercy-10`: 5–5. Mercy changed only 7 of 311 decisions: in JEV vs JEV one side is rarely clearly ahead. So this run cannot measure the handicap.
  - `live-mercy-vs-random-20` (strength 1), compared battle for battle with `live-jev-vs-random-20` (same teams, different random opponent): still 20/20 wins, 87 of 536 decisions changed (41/69 at advantage ≥0.6).
    - Turns +1.65 on average (median +2.5; 12 longer, 7 shorter): at most a small effect.
    - Mercy at strength 1 softens play but does not make JEV lose to random.
  - Ledger total $0.2941.
- **Rate-limit handling**: shared adaptive limiter (D16). The user accepted it as sufficient.
- **Licensing / IP**: `docs/licensing.md` plus the `test/no-assets.test.ts` guard.
- **Fault-injecting mock** (2026-09-24): `--mock-profile flaky` on `experiment.ts` / `jev-bot.ts` / `copilot.ts`, or env `MOCK_JEV_PROFILE`. Injects latency, 429, 503, network errors and invalid answers.
  - `mise run dry` runs mock-jev vs mock-jev-mercy end to end, then analyze. No API calls, and the project ledger is untouched.
  - First run: 4/4 battles finished. Faults hit: 8 network, 34 × 429, 21 × 503, 6 invalid answers. Took about 4 min.
  - Use it before any live run to check everything except JEV's judgement.
- **Hardening** (D17, verified with mock only, no live spend):
  - Reconnect: integration test drops the socket twice mid-battle. The battle finishes with no forfeit and no decision errors.
  - Timer-aware deadline with an explicit, flagged fallback.
  - Invalid-choice retry cap.
  - Own challenge echo is no longer accepted.
  - `mise run spectate` / `mise run play`: start and SIGTERM cleanup checked 4×, and the Copilot UI answers.
- **Copilot single-screen** (2026-09-24): the proxy adds `|uhtml|` / `|uhtmlchange|` advice boxes into the human's own battle log, only on the server→client path. Nothing extra is sent upstream.
  - Each box shows: thinking → JEV's pick and probabilities → the human's choice and whether it matched.
  - The separate advice page stays available.
  - Play-mode bots queue on the ladder and join the lobby, so they show in the user list.
  - Tests cover rendering and delivery. The user checked it in the real client with live JEV on 2026-09-24: 1 battle, 37 advices, 0 errors, $0.0041; the human matched JEV on 36 of 37 choices.
- **Checks**: `mise run check` = typecheck + 53 tests (1 live test skipped unless `RUN_LIVE_JEV_TESTS=1`).

## In progress
- None.

## Next (natural order)
1. ~~Experiments~~ done (see above). Open follow-up: to make Mercy measurably weaker, it would need to act at lower advantage or pick worse options. This depends on calibrating `battleAdvantage` (item 3).
2. ~~Hardening~~ done (D17). The live launcher and a human browser test are both done.
3. Optional: `battleAdvantage` calibration against logged outcomes, and a JEV `score` question for advantage (D12).
4. Idea, on hold (user will decide later): Japanese battle commentary.
   - Map protocol lines to Japanese with templates. No LLM needed. 41 message kinds were seen in 3 battles; unknown kinds show the raw line.
   - Put JEV per-choice probabilities next to each turn.
   - Where it goes: first a side panel in the replay HTML, then a live page on the WS proxy for spectating.
   - Unchanged: the official client stays English; forking it would bring AGPL obligations.
   - Japanese species/move names are Nintendo IP. They would have to be fetched at view time, never stored in the repo.
5. Later: Team Builder Copilot (D15). The user's spec text was truncated.

## Blockers
- None. A user decision is needed only for: this project's own license, and any use of the official public server (both out of scope for now).
