// Sends exactly ONE live JEV request through the budget guard. Usage: mise run jev-smoke
import { jevFromEnv, openBudget } from '../src/config.ts';
import { buildEvaluateBody } from '../src/decision/jev.ts';
import { sampleContext } from '../src/sim/sample-context.ts';

if (!process.env.AI_GATEWAY_API_KEY) { console.error('AI_GATEWAY_API_KEY is not set'); process.exit(1); }
const budget = openBudget('smoke-' + new Date().toISOString());
const ctx = await sampleContext();
console.log('payload bytes', Buffer.byteLength(JSON.stringify(buildEvaluateBody('typesafe-ai/jev', ctx, 40))));
const d = await jevFromEnv(budget, { label: 'jev' }).decide(ctx);
console.log(JSON.stringify({ choiceId: d.choiceId, scores: d.scores, confidence: d.confidence, usage: d.usage, raw: d.raw }, null, 2));
console.log('[budget] after:', budget.snapshot);
budget.release();
