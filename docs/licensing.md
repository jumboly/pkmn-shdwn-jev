# Licensing and IP boundaries

Checked 2026-09-24 against the actual files. This is not legal advice. It records what we verified and the rules this repo follows.

## Three separate things. Do not conflate them

| What | Owner / license | How this repo touches it |
|---|---|---|
| **Pokémon Showdown server + simulator** (`smogon/pokemon-showdown`) | **MIT**. Verified in `vendor/pokemon-showdown/LICENSE` ("Copyright (c) 2011-2026 Guangcong Luo and other contributors") and `"license": "MIT"` in the npm `pokemon-showdown@0.11.11` package.json | npm dependency, used at runtime and not copied into our sources. The server is cloned into `vendor/`, which is gitignored and not redistributed. |
| **Pokémon Showdown client** (`smogon/pokemon-showdown-client`) | **AGPLv3** overall, per its `LICENSE`. README: "This is NOT the same license as Pokémon Showdown's server." Some files carry `@license MIT` headers, e.g. `src/battle-log.ts` and `src/replay-embed.ts`. | Not vendored, not modified, not redistributed. Humans use the unmodified client that play.pokemonshowdown.com serves. Our replay HTML follows the file *format* of `BattleLog.createReplayFile` (an MIT file) and loads `replay-embed.js` (an MIT file) from play.pokemonshowdown.com at view time. |
| **Pokémon IP**: names, sprites, artwork, sounds, music, trademarks | © Nintendo / Creatures Inc. / GAME FREAK inc. / The Pokémon Company. **Neither Showdown license grants any rights to it.** The MIT and AGPL licenses cover Showdown's own code only. | Never copied into this repo. See the rules below. |

Other dependencies: `ws` (MIT), `typescript` (Apache-2.0), `@types/*` (MIT).

## Rules for this repository
1. **No Pokémon media in the repo.** No sprites, icons, artwork, sounds or music, and no copies of the client's `sprites/`, `fx/` or `audio/`. `test/no-assets.test.ts` fails if any image, audio or video file appears under the tracked source directories.
2. **Game data stays in the dependency.** Move, species and type data is read at runtime through `Dex` from the `pokemon-showdown` npm package. We do not dump or copy Showdown's `data/` files into this repo.
3. **Visuals are loaded, not shipped.** The generated replay pages and the official client fetch sprites from play.pokemonshowdown.com in the viewer's browser. Generated files live in `runs/`, which is gitignored, and are for local review. Do not publish them as part of this project.
4. **Text references are minimal.** Species and move names appear in tests and logs only as short identifiers needed to exercise the code, such as `Mew` or `Thunderbolt`.
5. **Client code: use it, do not fork it by default.** Copilot uses a proxy plus a separate companion page, so no AGPL client code is modified or redistributed. A future client fork or copied client code would bring AGPL obligations (source disclosure for network use). That needs a separate decision.
6. **No affiliation.** This project is not affiliated with or endorsed by Nintendo, The Pokémon Company, GAME FREAK, Creatures, Smogon or Pokémon Showdown. Any public README or UI must say so.

## This project's license
- **MIT** (`LICENSE`), chosen by the user on 2026-09-24 when the repository went public.
- Why: it matches the Showdown server and all runtime dependencies are MIT/Apache-2.0, so nothing forces a copyleft license.
- It covers this repository's own code only. It grants nothing for Pokémon IP (see above).
- If AGPL client code is ever incorporated (rule 5), the affected parts would need AGPL, so that needs a separate decision.

## Open questions
- **non-blocking**: if Copilot or replays are ever hosted publicly, review Pokémon Showdown's terms for embedding `replay-embed.js` and sprites from their servers, and the Pokémon trademark guidelines.
