# pkmn-shdwn-jev

JEV (`typesafe-ai/jev`, reached through the Vercel AI Gateway) makes Pokémon battle decisions on top of Pokémon Showdown.

- **Showdown** owns the rules, the battle state, the legal moves and the RNG.
- **This controller** builds the player-visible state and the legal choices, asks JEV, validates the answer, sends the command, logs everything and enforces the budget.
- **JEV** only picks one of the legal choices it is given.

Not affiliated with Nintendo, The Pokémon Company, GAME FREAK, Creatures, Smogon or Pokémon Showdown. See [docs/licensing.md](docs/licensing.md).

Repository: <https://github.com/jumboly/pkmn-shdwn-jev>

Design decisions and their rationale: [docs/decisions.md](docs/decisions.md). Progress: [docs/implementation-status.md](docs/implementation-status.md). Measured results: [docs/experiments.md](docs/experiments.md).

## Setup

```sh
mise install                 # Node 24.21.0
npm ci
cp .env.example .env         # then put AI_GATEWAY_API_KEY in .env (never commit it)
mise run check               # typecheck + tests (never call live JEV)
mise run server-setup        # optional: clone/build the Showdown server into vendor/ (Autonomous/Copilot)
```

Run everything through `mise run …` or `mise exec -- …` so that `.env` is loaded. mise masks only `AI_GATEWAY_API_KEY` in its output.

### Dedicated gateway key with a hard, non-resetting budget (recommended)

The app-side guard is primary, but also cap the key on Vercel's side. Verified against the Vercel CLI docs on 2026-09-24; CLI ≥ 59.13 uses `--limit`, older versions use the deprecated `--budget`:

```sh
vercel ai-gateway api-keys create --name pkmn-shdwn-jev --limit 5 --refresh-period none
# existing key: vercel ai-gateway budgets set api-key <name|id> --limit 5 --refresh-period none
#   (note: `budgets set` defaults to monthly, so pass --refresh-period none explicitly)
```

Or in the dashboard: AI Gateway → API Keys → Create key → enable budget → $5, refresh "none".

Vercel's budget is a soft cap: the request that crosses the limit still completes. New limits can take up to about 5 minutes to apply.

## Budget safety (5 USD must never be exceeded)

| env | default | meaning |
|---|---|---|
| `EXPERIMENT_BUDGET_USD` | 5.00 | hard cap for the whole project |
| `EXPERIMENT_STOP_THRESHOLD_USD` | 4.50 | the app refuses to send any request that could cross this |
| `JEV_MAX_COST_PER_REQUEST_USD` | 0.01 | worst-case reservation per request (the real worst case is about $0.0027) |
| `EXPERIMENT_MAX_REQUESTS` / `EXPERIMENT_MAX_COST_USD` | – | optional per-experiment caps |
| `JEV_MAX_PAYLOAD_BYTES` | 24000 | local payload cap (see D10: the gateway fails with 503 above content-dependent sizes) |

- All live spend is appended to `runs/jev-cost-ledger.jsonl`. It is cumulative across runs. **Do not delete it.**
- `mise run budget` reads the ledger (read-only) and prints the booked total and the remaining headroom.
- Each request is booked at `max(cost, marketCost)`, so a promotion that reports `cost: 0` does not weaken the guard.
- Experiments stop starting battles when the remaining headroom is too small, and they log why.

## Modes

### Experiment Mode (headless simulator)

```sh
node scripts/experiment.ts --p1 jev --p2 random --battles 5          # live, budget-guarded
node scripts/experiment.ts --p1 jev --p2 jev-mercy --mercy-strength 1 --battles 4
node scripts/experiment.ts --p1 mock-jev --p2 random --battles 20    # free: mock gateway
```

- Players: `random`, `mock-jev`, `jev`. Add `-mercy` to any JEV player for Adaptive Strength.
- Sides alternate every battle.
- Output goes to `runs/<id>/`: `config.json`, `events.jsonl`, `summary.json`, and per battle:
  - `battles/*.jsonl`: every decision with its request, visible state, choices, JEV probabilities, confidence, command, cost and handicap
  - `*.spectator.log`
  - `*.inputlog` (replay it exactly with the simulator)
  - `*.replay.html`: open it in a browser to watch the battle in the official replay viewer (needs internet access for the viewer JS and sprites)

Dry run before spending: `mise run dry` plays mock-jev vs mock-jev-mercy. The mock injects latency, 429, 503, network errors and invalid answers, so it exercises everything except JEV's judgement for free. `--mock-profile flaky` does the same for any `mock-jev` player.

Analyze runs offline (no API calls): `mise run analyze runs/<id> [...]`. It reports win rate with a 95% Wilson interval, cost per battle, JEV confidence, and the Mercy change rate by advantage.

### One-command launcher

```sh
mise run spectate -- --p1 mock-jev --p2 mock-jev-mercy --battles 3   # two bots battle; watch at https://localhost.psim.us/
mise run play                                                        # server + Copilot + an opponent bot
mise run play -- --provider jev --opponent random                    # live JEV advice (budget-guarded)
```

- Players are the same kinds as in Experiment Mode. The default is mock JEV (no cost).
- Everything runs in one process, so live players share the budget lock and the rate limiter.
- A live launch cannot start while another live process, such as an experiment, holds the ledger lock.
- The launcher prints a direct link to each battle room. `--timer` turns the battle timer on.
- In `play`, the opponent bot queues on the local ladder. Press **Battle!** in the client, or challenge `JEV-Bot` by name.

### Autonomous Mode (JEV as a player on a local server)

```sh
mise run server                                   # 127.0.0.1:8000, dev login without passwords
node scripts/jev-bot.ts --name JEV-Bot            # add --mercy 0.6 for Mercy mode
```

1. Open `https://localhost.psim.us/`. It is the official client and connects to `localhost:8000`. If Chrome asks for local network access, allow it.
2. Pick any name, then challenge **JEV-Bot** to **[Gen 9] Random Battle**.

The bot reconnects after a dropped connection and resumes its battles.
- With the battle timer on, a decision that would come too late is replaced by an explicitly flagged random fallback, so the bot does not lose on time.
- Use `--timer-fallback none` to wait instead.

The bot refuses non-local servers. Connecting to the official public server is intentionally unsupported.

### Copilot Mode (you play; JEV only advises)

```sh
mise run play                                     # mock JEV advice (no cost)
mise run play -- --provider jev --opponent random # live JEV advice (budget-guarded)
```

`mise run play` starts the server, the Copilot proxy (`:8000`, in front of the server on `:8001`), the advice page `http://127.0.0.1:8010/` and an opponent bot (see [One-command launcher](#one-command-launcher)).

Play at `https://localhost.psim.us/`. Advice appears inside the battle log of the same window. The separate page `http://127.0.0.1:8010/` shows more detail, such as both active Pokémon and field conditions.

- For each of your turns the advice page shows the legal choices with deterministic game data (type, power, accuracy, priority, PP, type chart vs the visible foe), plus JEV's probabilities and confidence.
- JEV **never** sends a move for you.
- Your actual choice and whether it matched JEV are logged in `runs/copilot-*/copilot.jsonl`.
- Manual start, only if you need to run the pieces separately: `PSPORT=8001 mise run server`, then `mise run copilot`, then an opponent such as `node scripts/jev-bot.ts --url ws://localhost:8001/showdown/websocket --provider random`.

## Adaptive Strength

| mode | behaviour |
|---|---|
| No Mercy | Plays JEV's top choice (pass-through). This is the baseline. |
| Mercy (`strength` 0..1) | Holds back only when clearly ahead. The details are below. |

How Mercy decides:

1. `battleAdvantage` (from the player-visible state only) combines remaining Pokémon, HP, status and boosts.
2. It sets `mercyLevel = strength × ramp(advantage 0.15 → 0.6)`, so the level is 0 when even or behind.
3. With probability `0.8 × mercyLevel` it plays one of JEV's other top-3 choices, and only choices JEV itself rated plausibly.
4. When the opponent catches up, the level drops back to 0 automatically.

Every decision logs the mode, strength, advantage breakdown, JEV's original top choice, the full distribution, the final choice and `changed`. Copilot always advises with No Mercy.

## Tests

- `mise run test`: unit tests, simulator battles, the information-boundary check, mock-JEV pipeline, budget guard and handicap.
- If `vendor/` has been built, it also runs server integration tests (autonomous clients, and the copilot proxy with a scripted human).
- No test calls the paid API.
- The live check is explicit: `mise run jev-smoke` sends one request through the budget guard.
