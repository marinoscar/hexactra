// How consistent a task's runs are (E52.7, #1022): the spread of steps, model calls, working time and cost across its last finished
// runs, and a label a person reads at a glance. Pure: the service hands it the run rows.

export interface Spread {
  min: number;
  median: number;
  p90: number;
  max: number;
  /** max / median; 1 when the median is 0. */
  ratio: number;
}

export type ConsistencyLabel = 'not_enough_runs' | 'steady' | 'varies' | 'erratic';

export interface ConsistencyRun {
  runId: string;
  status: string;
  createdAt: Date;
  stepCount: number;
  modelCalls: number;
  activeMs: number;
  costUsd: number;
  costKnown: boolean;
}

export interface TaskConsistency {
  taskId: string;
  runs: number;
  succeeded: number;
  /** 0..1. */
  successRate: number;
  steps: Spread | null;
  modelCalls: Spread | null;
  activeMs: Spread | null;
  /** Null when any counted run's cost is unknown. */
  costUsd: Spread | null;
  label: ConsistencyLabel;
  since: string | null;
  perRun: { runId: string; status: string; createdAt: string; stepCount: number; costUsd: number | null; activeMs: number; findings: { code: string; severity: string }[] }[];
}

/** The label's boundaries, each proved by a unit test. */
export const CONSISTENCY = {
  minRuns: 3,
  steadyRatio: 1.5,
  steadySuccess: 0.9,
  erraticRatio: 3,
  erraticSuccess: 0.6,
} as const;

/** The value at a fraction of the sorted list, by the nearest rank. */
function rank(sorted: readonly number[], q: number): number {
  if (sorted.length === 0) return 0;
  const i = Math.min(sorted.length - 1, Math.max(0, Math.ceil(q * sorted.length) - 1));
  return sorted[i]!;
}

/** The spread of a list of numbers; null for an empty list. The median of an even list is the mean of its two middle values. */
export function spreadOf(values: readonly number[]): Spread | null {
  if (values.length === 0) return null;
  const s = [...values].sort((a, b) => a - b);
  const mid = s.length >> 1;
  const median = s.length % 2 ? s[mid]! : (s[mid - 1]! + s[mid]!) / 2;
  const max = s[s.length - 1]!;
  const round = (n: number) => Math.round(n * 1000) / 1000;
  return { min: s[0]!, median: round(median), p90: rank(s, 0.9), max, ratio: median === 0 ? 1 : round(max / median) };
}

export function labelOf(runs: number, steps: Spread | null, successRate: number): ConsistencyLabel {
  if (runs < CONSISTENCY.minRuns || !steps) return 'not_enough_runs';
  if (steps.ratio > CONSISTENCY.erraticRatio || successRate < CONSISTENCY.erraticSuccess) return 'erratic';
  if (steps.ratio <= CONSISTENCY.steadyRatio && successRate >= CONSISTENCY.steadySuccess) return 'steady';
  return 'varies';
}

/** The consistency of a task from its finished runs, newest first. `findings` gives a run's findings when they were read. */
export function consistencyOf(taskId: string, runs: readonly ConsistencyRun[], since: Date | null, findings: ReadonlyMap<string, { code: string; severity: string }[]> = new Map()): TaskConsistency {
  const succeeded = runs.filter((r) => r.status === 'succeeded').length;
  const successRate = runs.length ? Math.round((succeeded / runs.length) * 1000) / 1000 : 0;
  const steps = spreadOf(runs.map((r) => r.stepCount));
  return {
    taskId,
    runs: runs.length,
    succeeded,
    successRate,
    steps,
    modelCalls: spreadOf(runs.map((r) => r.modelCalls)),
    activeMs: spreadOf(runs.map((r) => r.activeMs)),
    costUsd: runs.every((r) => r.costKnown) ? spreadOf(runs.map((r) => r.costUsd)) : null,
    label: labelOf(runs.length, steps, successRate),
    since: since ? since.toISOString() : null,
    perRun: runs.map((r) => ({ runId: r.runId, status: r.status, createdAt: r.createdAt.toISOString(), stepCount: r.stepCount, costUsd: r.costKnown ? r.costUsd : null, activeMs: r.activeMs, findings: findings.get(r.runId) ?? [] })),
  };
}
