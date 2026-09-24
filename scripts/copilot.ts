// Copilot Mode. Run the real server on 8001, this proxy on 8000, then play normally at
// https://localhost.psim.us/ (it always connects to localhost:8000) and open the advice page.
//   mise run server -- (with PSPORT=8001)   |   node scripts/copilot.ts [--provider mock-jev [--mock-profile flaky]]
import { parseArgs } from 'node:util';
import { baseKind, isLocalHost, makeProvider, openBudget, openMockBudget } from '../src/config.ts';
import { startCopilot } from '../src/copilot/proxy.ts';

const { values: a } = parseArgs({ options: {
	provider: { type: 'string', default: 'jev' },
	listen: { type: 'string', default: '8000' },
	upstream: { type: 'string', default: 'http://127.0.0.1:8001' },
	ui: { type: 'string', default: '8010' },
	'show-mercy': { type: 'string' },
	/** Fault injection for --provider mock-jev: clean | flaky. */
	'mock-profile': { type: 'string' },
} });
const host = new URL(a.upstream!).hostname;
if (!isLocalHost(host)) { console.error('Copilot only proxies a local server'); process.exit(1); }

const runId = `copilot-${new Date().toISOString().replace(/[:.]/g, '-')}`;
const live = baseKind(a.provider!) === 'jev';
const budget = live ? openBudget(runId) : openMockBudget(`runs/${runId}`, runId);
const provider = makeProvider(a.provider!, { liveBudget: live ? budget : null, mockBudget: live ? null : budget, mockProfile: a['mock-profile'] });
startCopilot({
	listenPort: Number(a.listen), upstream: a.upstream!, uiPort: Number(a.ui), provider, logDir: `runs/${runId}`,
	showMercy: a['show-mercy'] ? Number(a['show-mercy']) : undefined, budgetInfo: () => budget.snapshot,
});
console.log(`[copilot] proxy ws://127.0.0.1:${a.listen} -> ${a.upstream} | advice UI http://127.0.0.1:${a.ui}/ | provider ${provider.name} | logs runs/${runId}`);
console.log('[copilot] play at https://localhost.psim.us/ (allow local network access if the browser asks). JEV never sends moves for you.');
process.on('SIGINT', () => { budget.release(); process.exit(0); });
