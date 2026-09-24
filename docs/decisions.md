# Decision log

All dates are 2026-09-24 unless noted. "Reversible" = how cheap it is to change later.

## Decisions

### D1. Runtime: Node 24 LTS via mise, TypeScript executed directly
- **Decision**: `mise.toml` pins `node = 24.21.0`. `.ts` files run on Node's native type stripping (no build step). `tsc --noEmit` does type checking only. Tests use `node --test`.
- **Why**: pokemon-showdown requires Node >= 22.18. This setup needs the fewest dependencies: `pokemon-showdown`, `typescript` and `@types/node`. The user asked for mise.
- **Constraint**: only erasable TS syntax is allowed (no `enum`, no parameter properties). `tsconfig.json` enforces this.
- **Reversible**: yes.

### D2. Showdown as an npm dependency (sim) + vendored clone (server)
- **Decision**: the simulator comes from `pokemon-showdown@0.11.11` (exact pin). The full server repo is cloned to `vendor/pokemon-showdown` (gitignored). It was at commit `a5df8274e85b0889bf2a9b3422a08b39732374fc` on 2026-09-22. The vendored server is used only for Phase 4.
- **Why**: the npm package is the documented simulator API (`sim/SIMULATOR.md`). The server is not published to npm.
- **Recorded in logs**: `showdownVersion` in every battle. `vendoredServerCommit` in each experiment's `config.json`.
- **Reversible**: yes.

### D3. Format: `gen9randombattle`
- **Decision**: `gen9randombattle`, i.e. `[Gen 9] Random Battle`, confirmed in `config/formats.ts`. Singles only; `legalChoices` throws on multi-active requests.
- **Why**: keeps team building out of the evaluation.
- **Reversible**: yes.

### D4. Reproducibility: battle seed + derived team seeds
- **Decision**: the battle seed is a `sodium,<32 hex>` string. Each player's team seed is `sha256(battleSeed|team|pN)`.
- **Why**: random-team formats draw each team from a **per-player** seed, and that seed defaults to a fresh random value (`sim/battle.ts` `setPlayer`). The battle seed alone does not reproduce a battle. We found this with a failing reproducibility test.
- **Doc discrepancy**: `sim/SIMULATOR.md` says `seed` is "an array of four numbers". The code (`sim/prng.ts`) expects a `sodium,...`/`gen5,...` string and accepts arrays only for compatibility.
- **Reversible**: yes.

### D5. Information boundary
- **Decision**: each side is driven only from its own `getPlayerStreams(stream).pN`. That stream already resolves `|split|` into the secret half for that player and the public half for everyone else (`extractChannelMessages`). It also carries that player's own `|request|`. `VisibleStateTracker` consumes only this stream.
  - The omniscient stream and the `end` log (which contains both full teams) are used only for logging, never for providers.
  - Opponent data given to JEV: species, level, HP%, status, types (dex types or the revealed tera type), revealed moves, revealed item and ability, boosts, and volatiles.
  - It also includes public dex facts: possible abilities and base stats.
  - Not given: the opponent's stats, set, tera type before tera, or unrevealed Pokémon.
- **Verified by**: `test/sim.test.ts` "information boundary". For every decision it checks that every opponent move and item in the state appeared in the spectator log. It checks that no opponent stats or tera type are present. It checks that only opponent Pokémon that switched in are listed.
- **Not used**: Random Battle set data (`data/random-battles/*`). It is public knowledge, but we keep the state strictly "what happened in this battle".
- **Reversible**: moderate.

### D6. JEV access: direct `POST https://ai-gateway.vercel.sh/v1/evaluate` (not AI SDK)
- **Decision**: plain `fetch` to the documented HTTP API, with an injectable `fetch` for mocks.
- **Why**:
  - The HTTP API is documented (https://vercel.com/docs/ai-gateway/modalities/evaluation).
  - Its response body carries `providerMetadata.gateway.cost`, `marketCost` and `generationId`.
  - It needs no extra dependency, and retry and 402 handling are ours to control.
  - The AI SDK `experimental_evaluate` (ai@7.0.113) is still experimental. Internally it posts to a different endpoint (`/v4/ai/evaluation-model` with `ai-model-id` headers). That is a doc/SDK path discrepancy.
- **Model id**: `typesafe-ai/jev`, confirmed in the public catalog `GET /v1/models` (`type: "evaluation"`).
- **Question design**: a single `choice` question named `action`. The criteria keys are our legal-choice ids (`move-1`, `move-1-tera`, `switch-3`, ...). The values are descriptions with deterministic facts: type, category, base power, accuracy, priority, PP, and the type-chart multiplier against the visible active foe types. JEV never authors commands.
  - Answers outside the set are rejected (`INVALID_ANSWER`) and never coerced.
- **Verified live**: the response has `answers.action.choice` and `probabilities`. Confidence **is** returned through the gateway at `providerMetadata.typesafe.confidence.action`. That was unverified in the docs.
- **Reversible**: yes. The provider is one file.

### D7. Cost accounting: `max(cost, marketCost)`; unreported cost books the worst case
- **Decision**: the ledger books `max(gateway.cost, gateway.marketCost)`.
- **Why**: Jev is free until 2026-09-25 (changelog), so live responses return `cost: "0"`. They also return `marketCost` (e.g. `0.000091644` for 2182 input tokens = $0.042/M). Budgeting on list price means the guard is not built on a temporary free price.
- **Edge cases**:
  - A successful response without a cost field books the full reservation (`costEstimated: true`).
  - Network errors book the full reservation, because the request may have been processed.
  - Gateway rejections without cost book 0.
- **Pricing (catalog)**: input $0.042 / 1M tokens, output $0, no per-request fee. Max 64k tokens per request, i.e. about $0.0027.
- **Reversible**: yes.

### D8. Budget guard
- **Decision**: `BudgetGuard` keeps a persistent append-only ledger at `runs/jev-cost-ledger.jsonl`, shared by all experiments, plus a pid lock file.
  - Before every request, `reserve()` refuses to send if `spent + inFlight + JEV_MAX_COST_PER_REQUEST_USD (0.01) > EXPERIMENT_STOP_THRESHOLD_USD (4.50)`.
  - A new battle starts only if the expected battle cost also fits.
  - That expected cost is observed avg/request × 2 × `requests-per-side` (80) × live sides, and the worst case until 20 requests have been observed.
  - Optional caps: `EXPERIMENT_MAX_REQUESTS` and `EXPERIMENT_MAX_COST_USD`.
  - HTTP 402 is surfaced as `BudgetExceededError` and is never retried or hidden by a fallback.
- **Why this margin**: the worst-case request is about $0.0027 plus possible surcharges, and we reserve $0.01 (3.7× that). The $0.50 gap between stop and cap covers gateway reporting lag and the soft-cap overshoot described in the budget docs.
- **Reversible**: yes.

### D9. Failure policy
- **Decision**: JEV failures abort the battle (`outcome: aborted`, excluded from win/loss).
  - Retries: 3 attempts for 408/409/425/429/5xx/529 and network errors, with backoff that honours `retry-after`. Each attempt is budgeted separately.
  - Fallback to random is opt-in only (`--fallback random`). It is flagged in the decision as `fallback: {from, reason}` and reported as `provider: "random"`.
- **Reversible**: yes.

### D10. Payload limit (user asked: 32KB or 64KB?). Measured, not a byte cap
- **Method**: `scripts/probe-payload.ts`, 27 live requests, $0.0052 booked in total. The probes are logged in `runs/probes/`.
  The script was removed after the investigation; see git history.

| mode | what grows | largest OK | smallest failing |
|---|---|---|---|
| padding | insignificant JSON whitespace | 4,608,000 B (4.5 MB) | none found |
| content | real protocol lines, many short strings | 32,734 B (20,103 tokens) | 33,241 B |
| prose | one long English string | 24,575 B (5,219 tokens) | 28,671 B |
| prose-array | the same prose split into 1 KB strings | 33,412 B (6,596 tokens) | 40,601 B |

- **Findings**:
  - **There is no 32KB/64KB limit on the HTTP body.** A 4.5 MB whitespace-padded body passes.
  - Failure thresholds depend on the **content shape**, not on bytes or on reported tokens. They are reproducible, not transient.
  - Failures come back as **HTTP 503 `service_unavailable_error`** with cost 0, not as 413/400. That is misleading for retry logic.
  - The docs mention no KB limit. TypeSafe documents 64k tokens per request and 32k for state + longest question. Our failures happen well below those token counts.
- **Decision**:
  - `JEV_MAX_PAYLOAD_BYTES` defaults to **24,000**. Every measured shape succeeded at or below this size.
  - If a payload is larger, `recentEvents` is halved until it fits; otherwise the provider throws locally.
  - Normal decisions are about 3.6 KB (40 recent events).
- **Reversible**: yes (an env var).

### D11. Replay path
- **Decision**: each battle writes `*.spectator.log` (spectator channel), `*.inputlog` and `*.replay.html`.
  - The HTML uses the same template as the client's "Download replay" (`BattleLog.createReplayFile`) and loads `https://play.pokemonshowdown.com/js/replay-embed.js`.
- **Verified**: headless Chromium rendered one of our files with 0 JS errors and 0 "Unrecognized" lines, and `seekTurn(5)` worked.
- **Not assumed**: raw `battle.log` does **not** work, because the client has no `|split|` handler and plays both halves (duplicated events). `replayHtml()` rejects logs containing `|split|`.
- **Caveat**: viewing needs internet access to play.pokemonshowdown.com.
- **Reversible**: yes.

### D12. Adaptive strength (Mercy): heuristic advantage + post-hoc handicap policy
- **Decision**: `HandicapProvider` wraps JEV:
  - state → JEV distribution → `applyHandicap` → final choice.
  - `no-mercy` is a pass-through.
  - `mercy` computes `battleAdvantage(state)` in [-1, 1]. The inputs are 0.5 × remaining-count diff, 0.5 × status-weighted HP share diff, and ±0.1 from active boosts. Unrevealed opponent Pokémon are counted as healthy.
  - `mercyLevel = strength × clamp((adv − 0.15) / (0.6 − 0.15))`, so it is 0 when even or behind and grows with the lead.
  - With probability `0.8 × mercyLevel`, it picks a lower-ranked choice. The pick is sampled ∝ JEV probability, among choices with `p ≥ max(0.08, top × floor)`. `floor` falls from 1 to 0.35 as mercy grows.
  - When the opponent catches up, the advantage drops and mercy returns to 0 automatically.
- **Why heuristic, not a JEV score question**: it costs nothing extra, is deterministic and explainable (the log records every term), and is enough for "clearly ahead vs not".
  - A JEV `score` question in the same request is a possible later experiment. It adds tokens and noise, and it would make the handicap depend on the model it is handicapping.
- **Logged per decision** (`decision.handicap`): mode, strength, advantage breakdown, mercyLevel, deviateProbability, originalChoiceId (JEV top), finalChoiceId, changed, candidates. `decision.scores` holds JEV's full distribution.
- **Boundary**: `battleAdvantage` reads only `VisibleState`.
- **Copilot**: shows the no-mercy JEV choice (see Phase 5).
- **Reversible**: yes.

### D13. Server integration (Autonomous Mode)
- **Decision**: `AutonomousClient` connects over a raw WebSocket to `ws://HOST:PORT/showdown/websocket`.
  - Login: `/trn NAME` on `--no-security` dev servers.
  - It sends `/utm null`, accepts `|pm| X| ME|/challenge FORMAT` with `/accept`, and optionally uses `/search`.
  - Choices go out as `ROOM|/choose CMD|RQID`.
  - The same `VisibleStateTracker`, `legalChoices` and `DecisionProvider` are used as in the simulator.
  - `BattleRoomObserver` waits 150 ms (debounce) after a `|request|`, because the protocol does not guarantee the request/log order. We observed log-then-request, but that is not a contract.
  - `update: true` requests are re-answered even though they reuse the rqid.
  - When a decision fails, the bot forfeits rather than playing a random move.
- **Local only**: `scripts/jev-bot.ts` refuses non-loopback hosts unless `--allow-remote` is given, and always refuses `*.pokemonshowdown.com` / `psim.us`.
- **Server bind**: the dev server binds to `127.0.0.1` through `config/config.js` `exports.bindaddress`.
  - Upstream discrepancy: the `PSBINDADDR` env var is overwritten. The parent process sets the worker env from `Config.bindaddress` (`server/sockets.ts` L90).
- **Human UI**: `https://localhost.psim.us/` (the official client, which always connects to `localhost:8000`).
  - Chromium's Local Network Access check blocks this until the user allows it. In headless tests we disable the check with `--disable-features=LocalNetworkAccessChecks`.
  - Verified with Playwright: a scripted human logged in, challenged JEV-Bot, and played 40+ turns by clicking the move and switch buttons.
- **Reversible**: yes.

### D14. Copilot UI: WebSocket proxy + companion page (not a client fork or extension)
- **Options compared**:

| Option | What it can see | Main drawback |
|---|---|---|
| Client fork | Everything the player sees | AGPL obligations; heavy to maintain |
| Userscript / extension | Everything the player sees | Tied to client internals (`app.rooms` / `PS.rooms`); per-browser install |
| Spectator bot | Public info only | Cannot see the player's own team or `|request|` |
| **WS proxy (chosen)** | The human's own connection = player channel | None significant |

- **Why the proxy**:
  - The unmodified official client already connects to `localhost:8000`, so we put the proxy there and run the real server on 8001.
  - The proxy sees exactly what that human sees, plus the `/choose` the human sends, which gives us the "human vs JEV" match log.
  - No client code is copied, so there is no AGPL entanglement.
- **Guarantees**:
  - Client→server frames are forwarded unchanged. The proxy has no code path that originates frames.
  - Advice uses the no-mercy JEV choice. The optional `--show-mercy` only labels what Mercy would pick.
  - The companion page (`:8010`) separates deterministic game data (type, BP, accuracy, priority, PP, type chart) from JEV's probabilities and confidence.
- **Logged** in `copilot.jsonl`:
  - `copilot-advice`: request, state, choices, decision, cost.
  - `copilot-human-choice`: `humanChoiceId`, `jevBestChoiceId`, `matchesJev`, `jevCostUsd`.
- **Verified**:
  - Automated: `test/server.test.ts`, where a scripted human plays through the proxy.
  - Manual: the official client plus the companion page (screenshots were taken during development).
- **Reversible**: yes. A userscript could reuse the same advice server.

### D15. Team Builder Copilot: deferred
- **Decision**: not started. The core (sim, JEV, experiments, server, human vs JEV, battle copilot) comes first, per the user's instruction. The request text was truncated after "set も提案し、".
- **Design already compatible**:
  - `Dex` access through `src/showdown/sim.ts`.
  - `JevProvider` / evaluate-question building. `choice` and `score` questions would fit candidate ranking.
  - `BudgetGuard` for its costs.
- **Reversible**: n/a.

### D16. Rate limiting: shared adaptive limiter (AIMD); gateway limit is the ceiling
- **Observation**: in the 20-battle run (concurrency 2), 13 of every 100 successful requests hit a 429. The gateway returns `retry-after` of about 60 s, and about 90% of wall time was spent in those waits. A normal request takes about 0.35 s.
- **Decision**: `src/decision/rate-limiter.ts` holds one limiter per process, shared by all `JevProvider`s.
  - A 429 sets a shared cooldown, honouring `retry-after`, and doubles the gap between requests (minimum 500 ms, maximum 10 s).
  - Each success multiplies the gap by 0.9.
  - Other 5xx errors keep the per-request exponential backoff.
- **Result**: over 6 battles, time per successful request went from 3.91 s to 3.52 s and 429s from 13.0 to 9.0 per 100 ok requests. Throughput is capped at about 17 req/min by the gateway's (unpublished) limit.
- **Status**: the user accepted this level on 2026-09-24. No further tuning is planned.
- **Reversible**: yes.

### D17. Server hardening: reconnect, timer deadline, one-process launcher (2026-09-24)
- **Reconnect**: after an unexpected close, `AutonomousClient` reconnects with backoff (10 attempts, 1s..15s) and logs in again under the same name.
  - The server then re-sends every battle (`|init|` + full log + request).
  - We rebuild the observer from that log. Feeding the old tracker again would double every event.
  - A decision computed for the old observer is dropped (`decision-stale`). A `/choose` that cannot be sent is logged (`send-dropped`) and re-decided once the request arrives again.
  - `|sentchoice|` means our choice already reached the server, so we do not answer again.
  - `[Invalid choice]` retries are capped at 3 per request, so an error that repeats cannot burn JEV requests forever.
- **Battle timer**: the observer reads `|inactive|Time left: N sec this turn | M sec total`. If the provider has not answered by `min(N, M) - margin` (default 8s), an explicit fallback (Random) is used.
  - Such a decision carries `fallback.reason = "battle timer ..."`, so it is never mistaken for JEV output.
  - JEV's late answer is still logged as `late-decision`.
  - Why: losing on time is worse than a flagged fallback. The "never silently substitute" rule still holds.
- **Launcher** (`scripts/launch.ts`, `mise run spectate` / `mise run play`): the server runs as a child process; both bots or the Copilot proxy run in ONE process.
  - Why: the ledger lock allows one process per ledger, and a shared rate limiter avoids two processes fighting over the gateway limit.
  - Mock JEV is the default, so launching is free.
  - A live launch cannot run while another live process (e.g. an experiment) holds the ledger lock.
- **Server readiness**: "now listening" is printed before the socket workers accept connections. `waitForServer()` probes a real WebSocket first.
  - This was the cause of intermittent `websocket error` failures in tests and in the launcher.

### D18. Copilot advice inside the battle log (2026-09-24)
- The user found two windows (client + advice page) awkward.
- The proxy now injects `|uhtml|jevcopilot-<rqid>|…` into the human's battle room, then `|uhtmlchange|` for updates. The official client renders it in the log, so no client fork is needed (no AGPL impact).
- The injection is only on the server→client path. The proxy still never sends anything upstream on the human's behalf. The existing test ("never sends choices itself") still holds.
- HTML is escaped and kept to a single line (the protocol is line-based).

## Assumptions
- The Jev free promotion ends on 2026-09-25 (timezone unknown). We never rely on it; see D7.
- Vercel's per-key budget is a soft cap (per the docs), so the app-side guard is the primary control.
- A local or self-hosted Showdown server is the only server target. The official server is out of scope unless the user decides otherwise. Its rules treat real-time assistance in rated play as cheating risk.

## Open questions
- **non-blocking**: the exact rule behind the 503 failures (D10). Is it a TypeSafe-side limit on its internal state representation? It is irrelevant at our payload sizes. Worth reporting to Vercel/TypeSafe.
- **non-blocking**: calibration of `battleAdvantage` weights. Should they be validated against win-rate from logged battles?
- **non-blocking**: one run of the full suite once failed "two autonomous clients..." in about 0.5 s. It did not reproduce in 3 reruns. The suspected cause is a random-port clash or server start timing while running in parallel. Watch for it.
- **non-blocking**: the rest of the Team Builder Copilot requirement (the message was cut off).
- **non-blocking**: would adding the Random Battle set pool (public data) as opponent priors improve JEV? It is an information-policy choice; see D5.
