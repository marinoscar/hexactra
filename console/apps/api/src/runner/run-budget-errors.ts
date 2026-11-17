import type { BudgetKey } from './budget';

/**
 * The error text a run carries when a budget stopped it: the human-readable
 * twin of the typed `runs.stop_reason` (#404). The alerts count budget stops
 * from `stop_reason`; they match these strings only for rows written before
 * that column existed.
 */
export const RUN_BUDGET_ERRORS = {
  steps: 'Step budget exhausted',
  time: 'Time budget exhausted',
  modelCalls: 'Model call budget exhausted',
  inputTokens: 'Input token budget exhausted',
  outputTokens: 'Output token budget exhausted',
  cost: 'Cost budget exhausted',
} as const;

/** The error text for an exhausted budget. */
export const BUDGET_ERROR: Record<BudgetKey, string> = {
  actions: RUN_BUDGET_ERRORS.steps,
  modelCalls: RUN_BUDGET_ERRORS.modelCalls,
  activeMinutes: RUN_BUDGET_ERRORS.time,
  inputTokens: RUN_BUDGET_ERRORS.inputTokens,
  outputTokens: RUN_BUDGET_ERRORS.outputTokens,
  cost: RUN_BUDGET_ERRORS.cost,
};

/** Every budget-stop error text. */
export const RUN_BUDGET_ERROR_LIST: readonly string[] = Object.values(RUN_BUDGET_ERRORS);
