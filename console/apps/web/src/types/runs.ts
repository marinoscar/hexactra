// A run and its steps, as the API returns them (`runResponseSchema` and
// `runStepResponseSchema` in apps/api/src/openapi/console.responses.ts).
import type { RunInput } from '../taskParams/RunInputs';
import type { RunOutput } from '../taskOutputs/model';
import type { RunClient, RunOrigin } from '../aiApps/types';
import type { RunActivity } from '../components/RunActivity';
import { STOP_REASONS, type BudgetKey, type RunBudget, type RunPolicy, type RunTier, type StopReason, type Tier } from '../components/runBudget';

export type RunStatus = 'queued' | 'running' | 'waiting_human' | 'paused' | 'succeeded' | 'failed' | 'cancelled';

/** Every run status, in the order a run moves through them. */
export const RUN_STATUSES: readonly RunStatus[] = ['queued', 'running', 'waiting_human', 'paused', 'succeeded', 'failed', 'cancelled'];

/** Why a run stopped (`runs.stop_reason`): the values #408 declared (`RUN_STOP_REASONS` in packages/hexactra-agent/src/budget.ts). */
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
  /** The step has a masked trace picture (#541): `GET /runs/{id}/steps/{seq}/screenshot`. */
  hasScreenshot?: boolean;
  /** The key moment the picture records. */
  screenshotMoment?: ScreenshotMoment | null;
  /** How many areas were masked in the picture. */
  screenshotMasked?: number | null;
  /** Why a key moment has no picture. */
  screenshotNote?: 'unavailable' | 'masked_failed' | 'no_storage' | 'capped' | null;
  /** The question the step asked or answered. */
  questionId?: string | null;
  /** That question, masked (#541); null for any other step. */
  question?: StepQuestion | null;
}

/** The key moments a run stores a picture of (#541). */
export const SCREENSHOT_MOMENTS = ['question', 'before_confirmed', 'after_confirmed', 'failure', 'final', 'saved'] as const;
export type ScreenshotMoment = (typeof SCREENSHOT_MOMENTS)[number];

/** How a question was answered (#541): the value is masked, and absent when it is withheld (a secret, a sign-in). */
export interface StepAnswer {
  /** `completed` or `cancelled`. */
  outcome: string;
  value?: string;
  valueWithheld: boolean;
  /** Where the person answered: web, cli, push, mcp…, api, webhook. */
  channel: string | null;
  answeredAt: string | null;
  /** A form's fields (E40.2): label and masked value; no value for a sensitive field. */
  fields?: { key: string; label: string; value?: string; provided: true }[];
}

/** The question a step asked or answered, as the run's trace shows it (#541). */
export interface StepQuestion {
  id: string;
  /** captcha, code, passkey, login, confirmation, other. */
  kind: string;
  /** none, text, secret, choice, multi_choice, number, confirm, takeover, credentials. */
  input: string;
  /** The full prompt, masked. */
  prompt: string;
  options: { id: string; label: string }[] | null;
  risk: string | null;
  /** pending, answered, cancelled, expired. */
  status: string;
  answer: StepAnswer | null;
}

/** What `GET /runs/{id}/export` writes (#542, #543). */
export type RunExportFormat = 'json' | 'pdf';

export interface Run {
  id: string;
  taskId: string | null;
  status: RunStatus;
  trigger: string;
  /** The email trigger that started the run (E39.8, E39.10); null or absent otherwise. */
  mailTriggerId?: string | null;
  /** Where the run was started from (#464): web (the console), android, cli, api, mcp (an AI app), schedule, system. */
  origin?: RunOrigin;
  /** The AI app that started it (#464); null when no app did. */
  client?: RunClient | null;
  actor?: string | null;
  /** The batch the run is a row of (E51.1, #1006); null outside a batch, absent from an older console. */
  batchId?: string | null;
  /** The run's row in its batch, 1..n; null outside a batch. */
  batchSeq?: number | null;
  goal: string;
  profile: string;
  result: string | null;
  error: string | null;
  cancelRequested: boolean;
  /** The owner pressed Pause (E38.2): it stays true while the run is `paused`. Absent from an older console. */
  pauseRequested?: boolean;
  /** When the run was paused; null otherwise. */
  pausedAt?: string | null;
  stepCount: number;
  /** What a running run is doing right now (#379). */
  activity?: RunActivity | null;
  /** The agent policy the run runs under; null until its first step snapshots it (#401). */
  policy?: RunPolicy | null;
  /** The task parameter values the run started with (#552), masked, with their source; null without parameters. */
  inputs?: RunInput[] | null;
  /** What the run returned (E39.5, #600), with the labels and types the task had when the run started; sensitive values read `[hidden]`. On `GET /runs/{id}`; null for a run without outputs. */
  outputs?: RunOutput[] | null;
  /** Whether every output was returned and valid; null without outputs or before the run ends. Also on a list row. */
  outputsComplete?: boolean | null;
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
  /** The OpenTelemetry trace id of the run's latest job (E38.4), to find it in the deployment's trace collector; null with telemetry off. */
  traceId?: string | null;
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
  /**
   * Steps the owner confirmed that the run carried out (#540): the list on `GET /runs/{id}`,
   * the count on a list row. "Run again" asks before repeating such a run.
   */
  confirmedActions?: ConfirmedAction[] | number;
  /** The saved logins the run signed in with (E37.3): the item's name and the site, never a username, password or code. */
  usedSavedLogins?: { provider: string; itemName: string; origin: string; at: string }[];
  /** The identity details the run filled (E37.6): the item's name, the field's label and the site, never a value. */
  usedSavedIdentity?: { provider: string; itemName: string; label: string; origin: string; at: string }[];
  /** The saved cards the run paid with (E37.7): brand, last four, the merchant and the declared and confirmed amounts, never a number, an expiry or a code. */
  usedSavedCards?: UsedSavedCardEntry[];
  /** The owner's memories this run used (#553). */
  memoryIds?: string[];
  /** `GET /runs/:id`: the used memories that still exist, with their labels (#553). */
  memories?: { id: string; label: string; status: 'active' | 'superseded' | 'archived' }[];
  /** `GET /runs/:id` (E41.5): the owner's unlisted accounts that could have done what this finished run did in the browser. */
  suggestedConnections?: { connectionId: string; label: string; provider: string; site: string; scope: 'task' | 'chat'; text: string }[];
}

/** One step the owner confirmed that a run carried out (#540). The prompt is masked. */
export interface ConfirmedAction {
  seq: number;
  prompt: string;
  action: string;
  at: string;
}

/** What started a run (`RUN_TRIGGERS` in apps/api/src/tasks/runs.schemas.ts). */
export const RUN_TRIGGERS = ['manual', 'schedule', 'api', 'mcp', 'external', 'chat', 'email', 'benchmark'] as const;
export type RunTrigger = (typeof RUN_TRIGGERS)[number];
/** Left out of every run list unless the filter names the trigger: a benchmark's trial runs (`HIDDEN_RUN_TRIGGERS` in the API). */
export const HIDDEN_RUN_TRIGGERS: readonly RunTrigger[] = ['benchmark'];

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

/** One card payment of a run (E37.7). */
export interface UsedSavedCardEntry {
  provider: string;
  itemName: string;
  brand: string | null;
  last4: string | null;
  merchant: string;
  origin: string;
  currency: string;
  declaredAmount: string;
  confirmedAmount: string | null;
  mismatch: boolean;
  at: string;
}
