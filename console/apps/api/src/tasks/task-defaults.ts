/**
 * The defaults of a new task's limits (#399): 100 browser actions and 30 minutes.
 * One source for the API schemas, the runner and the legacy-field data
 * migration (#401).
 */
export const TASK_DEFAULTS = { maxSteps: 100, maxMinutes: 30 } as const;
