/**
 * The one source of a task's step and time budget defaults. The API schema,
 * the goal runner's fallback and the Prisma column defaults all use these
 * numbers; `task-defaults.spec.ts` fails when the schema drifts from them.
 */
export const TASK_DEFAULTS = { maxSteps: 100, maxMinutes: 30 } as const;
