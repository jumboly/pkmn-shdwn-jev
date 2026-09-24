# Implementation status

_Last updated: 2026-09-24_

How each part was verified is recorded in the **Verified** lines of [decisions.md](decisions.md). Measured results (win rates, Mercy change rates, probes) are in [experiments.md](experiments.md).

## Current state
All planned phases work end to end:

- Experiment Mode: headless simulator battles with seeds, per-battle logs, input logs and replay HTML.
- JEV provider with the budget guard (persistent ledger, lock, per-request reservation) and the shared rate limiter (D16).
- Autonomous Mode and Copilot Mode on a local server, including reconnect and timer handling (D17), the single-screen Copilot advice boxes, and the one-command launcher (`mise run spectate` / `mise run play`).
- Adaptive Strength (No Mercy / Mercy) with per-decision logging (D12).
- Fault-injecting mock JEV (`mise run dry`) to rehearse everything except JEV's judgement for free.
- Licensing / IP guard: [licensing.md](licensing.md) plus `test/no-assets.test.ts`.

`mise run check` runs typecheck and the tests. Live tests are skipped unless `RUN_LIVE_JEV_TESTS=1`.

## Budget
Spend is not written down here, because it changes with every live run. The ledger `runs/jev-cost-ledger.jsonl` is the source of truth. Read it with:

```sh
mise run budget                        # requests, booked total, remaining before the stop threshold
mise run budget -- --by-experiment     # the same, broken down by experiment id
```

The task only reads the ledger. It sums `costUsd`, which is already booked at `max(cost, marketCost)`, the same way the budget guard does. Never edit or delete the ledger.

## In progress
- None.

## Next (natural order)
1. Optional: calibrate `battleAdvantage` against logged outcomes, and try a JEV `score` question for advantage (D12).
   - This is also what a measurably weaker Mercy depends on: it would need to act at lower advantage or pick worse options (see [experiments.md](experiments.md)).
2. Idea, on hold (user will decide later): Japanese battle commentary.
   - Map protocol lines to Japanese with templates. No LLM needed. Unknown message kinds show the raw line.
   - Put JEV per-choice probabilities next to each turn.
   - Where it goes: first a side panel in the replay HTML, then a live page on the WS proxy for spectating.
   - Unchanged: the official client stays English; forking it would bring AGPL obligations.
   - Japanese species/move names are Nintendo IP. They would have to be fetched at view time, never stored in the repo.
3. Later: Team Builder Copilot (D15). The user's spec text was truncated.

## Blockers
- None. A user decision is needed only for any use of the official public server (out of scope for now). The project license is MIT (see `docs/licensing.md`).
