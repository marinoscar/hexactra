// A run and its steps, as the API returns them (`runResponseSchema` and
// `runStepResponseSchema` in apps/api/src/openapi/console.responses.ts).
import type { RunActivity } from '../components/RunActivity';

export type RunStatus = 'queued' | 'running' | 'waiting_human' | 'succeeded' | 'failed' | 'cancelled';

/** Every run status, in the order a run moves through them. */
export const RUN_STATUSES: readonly RunStatus[] = ['queued', 'running', 'waiting_human', 'succeeded', 'failed', 'cancelled'];

/** Why a run stopped (`runs.stop_reason`), as the API spells it (`RUN_STOP_REASONS` in apps/api/src/runner/budget.ts). */
export const RUN_STOP_REASONS = [
  'finished',
  'budget_actions',
  'budget_model_calls',
  'budget_active_time',
  'budget_input_tokens',
  'budget_output_tokens',
  'budget_cost',
  'stalled',
  'cancelled',
  'error',
  'no_model',
] as const;
export type RunStopReason = (typeof RUN_STOP_REASONS)[number];

/** The model tier a run is on. */
export type RunTier = 'fast' | 'standard' | 'frontier';

/** The keys of a run budget (`BUDGET_KEYS` in apps/api/src/runner/budget.ts). */
export type RunBudgetKey = 'actions' | 'modelCalls' | 'activeMinutes' | 'inputTokens' | 'outputTokens' | 'cost';

/** The agent policy a run runs under. */
export interface RunPolicy {
  id: string;
  name: string;
  version: number;
  source: string;
  builtin: boolean;
}

/** What a run may spend and has spent (#404). Active time is in minutes, cost in USD; `null` is unlimited. */
export interface RunBudget {
  effective: Record<RunBudgetKey, number | null> & { warnAtPercent: number };
  used: Record<RunBudgetKey, number>;
  percent: Record<RunBudgetKey, number | null>;
  /** Where each limit came from: the policy, or the deployment ceiling that clamped it. */
  source: Record<RunBudgetKey, 'policy' | 'ceiling' | null>;
  /** False when a call could not be priced: `used.cost` is then "at least". */
  costKnown: boolean;
}

export interface RunStep {
  id: string;
  seq: number;
  kind: string;
  action: string | null;
  args: Record<string, unknown> | null;
  ok: boolean;
  summary: string;
  reasoning: string | null;
  durationMs?: number | null;
  createdAt: string;
}

export interface Run {
  id: string;
  taskId: string | null;
  status: RunStatus;
  trigger: string;
  actor?: string | null;
  goal: string;
  profile: string;
  result: string | null;
  error: string | null;
  cancelRequested: boolean;
  stepCount: number;
  /** What a running run is doing right now (#379). */
  activity?: RunActivity | null;
  /** The agent policy the run runs under; null until its first step snapshots it (#401). */
  policy?: RunPolicy | null;
  /** USD spent on model calls; a lower bound while `costKnown` is false. */
  costUsd?: number | null;
  /** False once a call could not be priced: show `costUsd` as "at least". */
  costKnown?: boolean;
  /** Model calls (provider round trips) made so far. */
  modelCalls?: number;
  /** Why the run stopped; null while it runs and on runs from before the field. */
  stopReason?: RunStopReason | null;
  /** The model tier the run is on now; null before it starts. */
  currentTier?: RunTier | null;
  /** The run budget; null on a run that has not started. */
  budget?: RunBudget | null;
  createdAt: string;
  finishedAt: string | null;
  steps?: RunStep[];
}
