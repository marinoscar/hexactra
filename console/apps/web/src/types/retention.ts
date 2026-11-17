// Run retention (#422), as the API returns it (`run-retention.schemas.ts` in
// apps/api/src/tasks/): the user's rule, the preview of what it would delete,
// and the deployment ceiling.

/** The three limits of a rule; `null` means no limit (`keepFailedDays`: the same as `keepDays`). */
export interface RetentionLimits {
  keepDays: number | null;
  keepPerTask: number | null;
  keepFailedDays: number | null;
}

/** `GET /runs/retention`. */
export interface RetentionSettings extends RetentionLimits {
  /** False while the user never saved a rule: the defaults apply. */
  saved: boolean;
  /** The deployment ceiling in days; null: none. */
  maxKeepDays: number | null;
  /** Runs that finished less than this many hours ago are never deleted by retention. */
  floorHours: number;
}

/** `GET /runs/retention/preview`. */
export interface RetentionPreview {
  wouldDelete: number;
  finished: number;
  oldestKept: string | null;
  costUsd: number | null;
  maxKeepDays: number | null;
  capped: boolean;
  floorHours: number;
}

/** The range of a number of days, and of a number of runs per task. */
export const RETENTION_MAX_DAYS = 3650;
export const RETENTION_MAX_PER_TASK = 10_000;
/** Task spend covers this many days: fewer days kept shrinks it. */
export const SPEND_WINDOW_DAYS = 30;
