// A task and its schedules, as the API returns them (`taskResponseSchema` and
// the schedule response in apps/api/src/openapi/console.responses.ts).

import type { TaskSpend } from '../components/runBudget';

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
  /** What the task's runs spent in the last 30 days (#400, #408). */
  spend30d?: TaskSpend;
  /** The task's agent policy (an own policy's UUID or `builtin:<key>`); null follows the user's default. */
  policyId: string | null;
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
  consecutiveFailures: number;
  /** The expression in words ("Monday to Friday at 09:00"), from the API (#424). */
  description?: string;
  /** Overrides the task's agent policy for scheduled runs; null follows the task. */
  policyId?: string | null;
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
