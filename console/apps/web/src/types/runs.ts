// A run and its steps, as the API returns them (`runResponseSchema` and
// `runStepResponseSchema` in apps/api/src/openapi/console.responses.ts).
import type { RunActivity } from '../components/RunActivity';
import { STOP_REASONS, type BudgetKey, type RunBudget, type RunPolicy, type RunTier, type StopReason, type Tier } from '../components/runBudget';

export type RunStatus = 'queued' | 'running' | 'waiting_human' | 'succeeded' | 'failed' | 'cancelled';

/** Every run status, in the order a run moves through them. */
export const RUN_STATUSES: readonly RunStatus[] = ['queued', 'running', 'waiting_human', 'succeeded', 'failed', 'cancelled'];

/** Why a run stopped (`runs.stop_reason`): the values #408 declared (`RUN_STOP_REASONS` in apps/api/src/runner/budget.ts). */
export const RUN_STOP_REASONS: readonly StopReason[] = STOP_REASONS;
export type RunStopReason = StopReason;

/** The run's budget, policy and model tier, as #408 declared them. */
export type { RunBudget, RunPolicy, RunTier, Tier };
/** The keys of a run budget. */
export type RunBudgetKey = BudgetKey;

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
  /** The run's model tier, from its policy snapshot (#408): start, max, current, escalations and model. */
  tier?: RunTier | null;
  /** The tier the run is on now (also `tier.current`); null before it starts. */
  currentTier?: Tier | null;
  /** The run budget; null on a run that has not started. */
  budget?: RunBudget | null;
  /** The machine the run asked for; null: any available one (#384). */
  hostId?: string | null;
  /** Use another available machine when the chosen one cannot take the run. */
  hostFallback?: boolean;
  createdAt: string;
  /** When the run's first step began; null while it is queued. */
  startedAt?: string | null;
  finishedAt: string | null;
  steps?: RunStep[];
}

/** What started a run (`RUN_TRIGGERS` in apps/api/src/tasks/runs.schemas.ts). */
export const RUN_TRIGGERS = ['manual', 'schedule', 'api', 'mcp', 'external'] as const;
export type RunTrigger = (typeof RUN_TRIGGERS)[number];

/** A run in a list (`GET /api/runs?envelope=1`): the run with its task's name; `budget` only while it is live. */
export interface RunListItem extends Run {
  /** The run's task name; null for a run without a task, or whose task was deleted. */
  taskName?: string | null;
}

/** One page of `GET /api/runs?envelope=1`. */
export interface RunPage {
  items: RunListItem[];
  /** Pass it as `cursor` to read the next page; null on the last page. */
  nextCursor: string | null;
}

/** `GET /api/runs/counts`: the runs that match a filter, per status. */
export interface RunCounts {
  total: number;
  live: number;
  byStatus: Record<RunStatus, number>;
  /** The recorded model spend of the matching runs; null when none made a model call. */
  costUsd: number | null;
  costKnown: boolean;
}

/** 200 of `POST /api/runs/delete`. */
export interface RunsDeleted {
  deleted: number;
  costUsd: number | null;
  skippedLive: string[];
  notFound: string[];
}

/** 202 of `POST /api/runs/delete`: a queue job deletes the runs. */
export interface RunsDeleteQueued {
  jobId: string;
  matched: number;
  costUsd: number | null;
}
