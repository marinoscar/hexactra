// A task and its schedules, as the API returns them (`taskResponseSchema` and
// the schedule response in apps/api/src/openapi/console.responses.ts).

import type { TaskOutput } from '@app/shared/task-fields';
import type { TaskParameter } from '@app/shared/task-params';

import type { TaskSpend } from '../components/runBudget';
import type { ConnectionSelectionView, ConnectionsMode, NeedsBrowser } from '../taskConnections/model';

/** A task, as `GET /api/tasks` returns it. */
export interface Task {
  id: string;
  name: string;
  goal: string;
  profile: string;
  hostId: string | null;
  hostFallback: boolean;
  allowedDomains: string[];
  confirmRiskyActions: boolean;
  /** Let the agent sign in from the owner's saved logins (E37.3); absent from an older console: off. */
  useSavedLogins?: boolean;
  /** Let the agent fill identity details from the owner's saved details (E37.6); absent from an older console: off. */
  useSavedIdentity?: boolean;
  /** Let the agent pay with a saved card under the owner's per-merchant approval and amount limit (E37.7); absent from an older console: off. */
  useSavedCards?: boolean;
  /** What an unattended run that used a saved login does at a payment (E37.3): `ask` or `allow`; absent: `ask`. */
  unattendedPayments?: 'ask' | 'allow';
  /** What the task's runs spent in the last 30 days (#400, #408). */
  spend30d?: TaskSpend;
  /** The task's agent policy (an own policy's UUID or `builtin:<key>`); null follows the user's default. */
  policyId: string | null;
  /** The goal's `{{Name}}` parameters, in order of appearance (#552); empty or null when it has none. */
  parameters?: TaskParameter[] | null;
  /** The values a run must return when it finishes (E39.5, #600); empty or null when the task has none. */
  outputs?: TaskOutput[] | null;
  /** Deprecated (E50.17): always `all`; every run uses what the owner switched on. */
  connectionsMode?: ConnectionsMode;
  /** Deprecated (E50.17): always empty; a task has no account list. */
  connections?: ConnectionSelectionView[] | null;
  /** Whether the task's runs open a browser (E39.7); absent: `auto`. */
  needsBrowser?: NeedsBrowser;
  /** Record a video of each run's browser tab (epic #755); absent from an older console: off. The video is not masked. */
  recordVideo?: boolean;
  createdAt?: string;
  /** When the task was last edited. */
  updatedAt?: string;
}

/** `GET /api/schedules?taskId=`. */
export interface TaskSchedule {
  id: string;
  taskId: string;
  cron: string;
  timezone: string;
  enabled: boolean;
  concurrency: 'skip' | 'queue';
  nextRunAt: string | null;
  lastRunAt: string | null;
  /** The run its last firing started; null before the first one, or once that run was deleted. */
  lastRunId?: string | null;
  consecutiveFailures: number;
  /** The expression in words ("Monday to Friday at 09:00"), from the API (#424). */
  description?: string;
  /** Overrides the task's agent policy for scheduled runs; null follows the task. */
  policyId?: string | null;
  /** Preset values for the task's parameters (#552), by key; null for none. */
  inputs?: Record<string, string> | null;
}

/** One schedule of a task's `summary` (`taskSummaryScheduleSchema`, #424). */
export interface TaskSummarySchedule {
  id: string;
  cron: string;
  timezone: string;
  enabled: boolean;
  concurrency: 'skip' | 'queue';
  nextRunAt: string | null;
  lastRunAt: string | null;
  /** Failed scheduled runs in a row; 3 or more is "failing". */
  consecutiveFailures: number;
  description: string;
  policyId: string | null;
  /** Preset values for the task's parameters (#552), by key; null for none. */
  inputs?: Record<string, string> | null;
}

/** `none`: no schedule. `active`: all enabled. `paused`: none enabled. `partial`: some of each. */
export type TaskScheduleState = 'none' | 'active' | 'paused' | 'partial';

/** A task's schedule and run facts (`?include=summary`, #424). */
export interface TaskSummary {
  /** Oldest first. */
  schedules: TaskSummarySchedule[];
  scheduleState: TaskScheduleState;
  /** The earliest next firing among the enabled schedules. */
  nextRunAt: string | null;
  /** The newest run of the task. */
  lastRun: { id: string; status: string; trigger: string; createdAt: string; finishedAt: string | null } | null;
  /** The newest run that is queued, running or waiting for a person. */
  liveRunId: string | null;
  runCounts: { total: number; last7d: { succeeded: number; failed: number; cancelled: number } };
  /** The policy a run started now would use. */
  policy: { id: string; name: string; builtin: boolean; isDefault: boolean } | null;
  /** Email triggers that are switched on (E39.8). */
  mailTriggers?: number;
  /** Deliveries that are switched on (E39.6, E39.10). */
  deliveries?: number;
}

/** A task with its summary: a row of `GET /api/tasks?envelope=1&include=summary`. */
export interface TaskWithSummary extends Task {
  summary: TaskSummary;
}

/** `GET /api/tasks?envelope=1`. */
export interface TaskPage {
  items: TaskWithSummary[];
  /** Pass as `cursor` for the next page; null on the last one. */
  nextCursor: string | null;
  /** Tasks that match the search and filters, on every page. */
  total: number;
}

/** The `filter` values of `GET /api/tasks`. */
export type TaskListFilter = 'scheduled' | 'paused' | 'unscheduled' | 'failing' | 'never_run';

/** The `sort` values of `GET /api/tasks`. */
export type TaskListSort = 'created_desc' | 'name_asc' | 'last_run_desc' | 'next_run_asc' | 'spend_desc';

/** `POST /api/tasks/:id/schedules/pause|resume`: the task, plus the schedules a resume left paused. */
export interface TaskSchedulesChanged extends TaskWithSummary {
  skipped: string[];
}

/** `GET /api/tasks/:id/stats?days=` (`taskStatsSchema`, #424): the task's runs over a period. */
export interface TaskStats {
  days: number;
  /** The zone the days are cut in. */
  timezone: string;
  totals: {
    /** Runs created in the period, live ones included. */
    runs: number;
    succeeded: number;
    failed: number;
    cancelled: number;
    /** succeeded / (succeeded + failed), 0 to 1; null when no run succeeded or failed. */
    successRate: number | null;
    /** USD spent by the period's runs; null when none has a cost. */
    costUsd: number | null;
    /** False when a call could not be priced: `costUsd` is then "at least". */
    costKnown: boolean;
  };
  avgDurationSeconds: number | null;
  p95DurationSeconds: number | null;
  avgSteps: number | null;
  avgCostPerSuccessUsd: number | null;
  /** One entry per calendar day, oldest first, zeros included. */
  series: Array<{ date: string; succeeded: number; failed: number; cancelled: number; costUsd: number | null }>;
  stopReasons: Array<{ reason: string; count: number }>;
}
