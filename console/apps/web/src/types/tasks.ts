// A task and its schedules, as the API returns them (`taskResponseSchema` and
// the schedule response in apps/api/src/openapi/console.responses.ts).

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
  /** Overrides the task's agent policy for scheduled runs; null follows the task. */
  policyId?: string | null;
}
