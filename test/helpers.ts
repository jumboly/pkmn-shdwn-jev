import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { BudgetGuard, type BudgetConfig } from '../src/budget.ts';

export function tempLedger(overrides: Partial<BudgetConfig> = {}, experimentId = 'test') {
	const dir = mkdtempSync(join(tmpdir(), 'jev-budget-'));
	const config: BudgetConfig = {
		ledgerPath: join(dir, 'ledger.jsonl'), budgetUsd: 5, stopThresholdUsd: 4.5, maxCostPerRequestUsd: 0.01, ...overrides,
	};
	return { config, guard: new BudgetGuard(config, experimentId) };
}

export const seed = (n: number) => `sodium,${n.toString(16).padStart(32, '0')}`;
