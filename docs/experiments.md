# Experiment log

Dated records of live and mock runs. The numbers are what was measured at the time and are not updated afterwards. Current spend is not recorded here: run `mise run budget` (see [implementation-status.md](implementation-status.md#budget)).

The run directories live in `runs/` (local only, gitignored). Re-analyze any of them offline with `mise run analyze runs/<id> [...]`.

## 2026-09-24

### Early live checks (Phase 2 / Adaptive Strength)
- Live smoke: one request.
- `live-jev-vs-random-01`: JEV vs random, 2 battles. `live-jev-vs-jev-01`: JEV vs JEV, 1 battle.
- `live-nomercy-vs-mercy-01`: no-mercy vs mercy, 2 battles. Mercy changed 3 of 42 decisions, all while clearly ahead.

### Payload-limit probes (D10)
- 27 live probes, logged in `runs/probes/`. Result: no byte cap on the HTTP body; failures depend on content shape and come back as HTTP 503.
- The table of thresholds per shape and the resulting `JEV_MAX_PAYLOAD_BYTES` default are in [decisions.md](decisions.md) (D10).

### Gateway pricing and throughput
- The gateway reported `cost: 0` for every request (a free promotion, announced to run until 2026-09-25). The guard books `max(cost, marketCost)`, so this did not change the accounting.
- About $0.003 booked per battle per JEV side.
- Throughput was about 17 req/min because of gateway rate limiting (D16).

### JEV vs random
- JEV won 26/26: 20 in `live-jev-vs-random-20` and 6 in `live-limiter-check-01`.
- `live-jev-vs-random-20`: 95% CI 83.9–100%. Average 23.6 turns. JEV confidence median 0.28.

### JEV vs JEV and Mercy (seed `jev-exp-02` / `jev-experiment`)
- `live-jev-vs-jev-10`: 10/10 finished; p1 5 wins, p2 5 wins.
- `live-nomercy-vs-mercy-10`: 5–5. Mercy changed only 7 of 311 decisions: in JEV vs JEV one side is rarely clearly ahead, so this run cannot measure the handicap.
- `live-mercy-vs-random-20` (strength 1), compared battle for battle with `live-jev-vs-random-20` (same teams, different random opponent):
  - Still 20/20 wins. 87 of 536 decisions changed (41/69 at advantage ≥0.6).
  - Turns +1.65 on average (median +2.5; 12 longer, 7 shorter): at most a small effect.
  - Conclusion: Mercy at strength 1 softens play but does not make JEV lose to random. Making it measurably weaker needs it to act at lower advantage or pick worse options, which depends on calibrating `battleAdvantage`.

### Fault-injecting mock (`mise run dry`)
- First run: 4/4 battles finished. Faults hit: 8 network, 34 × 429, 21 × 503, 6 invalid answers. Took about 4 min. No API calls.

### Hardening (D17, mock only)
- `mise run spectate` / `mise run play`: start and SIGTERM cleanup checked 4×, and the Copilot UI answered.

### Copilot single-screen, live
- The user played in the real client with live JEV advice: 1 battle, 37 advices, 0 errors, $0.0041 booked. The human matched JEV on 36 of 37 choices.

### Japanese commentary idea (not built)
- 41 protocol message kinds were seen in 3 battles.
