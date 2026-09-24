// Why: pokemon-showdown ships CommonJS whose exports Node's cjs-lexer cannot
// detect as named ESM exports, so we destructure the default export once here.
import PS from 'pokemon-showdown';
import { createRequire } from 'node:module';

export const { Dex, BattleStream, getPlayerStreams, PRNG, Teams } = PS;

const require = createRequire(import.meta.url);
export const SHOWDOWN_VERSION: string = require('pokemon-showdown/package.json').version;
