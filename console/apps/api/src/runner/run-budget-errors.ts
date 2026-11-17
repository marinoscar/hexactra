/**
 * The error text a run carries when a budget stopped it. The alerts match
 * these strings until the typed stop reason replaces them (E31.6).
 */
export const RUN_BUDGET_ERRORS = {
  steps: 'Step budget exhausted',
  time: 'Time budget exhausted',
} as const;

/** Every budget-stop error text. */
export const RUN_BUDGET_ERROR_LIST: readonly string[] = Object.values(RUN_BUDGET_ERRORS);
