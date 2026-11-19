// Constants of the mail trigger (E39.8, #605). Names of outcomes and statuses are permanent once rows carry them.
export const MAIL_TRIGGER_OUTCOMES = ['started', 'skipped_limit', 'skipped_unverified', 'skipped_loop', 'failed'] as const;
export type MailTriggerOutcome = (typeof MAIL_TRIGGER_OUTCOMES)[number];

export const MAIL_TRIGGER_STATUSES = ['ok', 'needs_reconnect', 'failing', 'rate_limited', 'connection_paused', 'connection_removed'] as const;
export type MailTriggerStatus = (typeof MAIL_TRIGGER_STATUSES)[number];

/** Stable reason codes of a skip or a failure (never a message: nothing from the mail is recorded). */
export const MAIL_TRIGGER_REASONS = ['SENDER_NOT_VERIFIED', 'SENDER_NOT_CHECKED', 'TRIGGER_DAILY_LIMIT', 'USER_DAILY_LIMIT', 'OWN_MESSAGE', 'START_FAILED', 'NOT_FOUND'] as const;
export type MailTriggerReason = (typeof MAIL_TRIGGER_REASONS)[number];

export const DEFAULT_POLL_SECONDS = 300;
export const DEFAULT_MAX_RUNS_PER_DAY = 10;
/** The most `maxRunsPerDay` a trigger may ask for; the per-user daily cap still applies. */
export const MAX_RUNS_PER_DAY_CEILING = 100;

/** The deployment-wide limits (`mailTriggers` system settings; these are the defaults). */
export interface MailTriggerLimits {
  /** No trigger polls more often than this (the owner may choose slower). */
  minPollSeconds: number;
  /** Triggers one user may have. */
  maxTriggersPerUser: number;
  /** Runs all of one user's triggers may start in a UTC day. */
  maxRunsPerUserPerDay: number;
}
export const DEFAULT_MAIL_TRIGGER_LIMITS: Readonly<MailTriggerLimits> = Object.freeze({ minPollSeconds: 60, maxTriggersPerUser: 20, maxRunsPerUserPerDay: 50 });

/** At most this many pages of 50 are read in one poll; beyond it a flood is cut (the oldest are skipped) and the cursor still moves on. */
export const MAX_POLL_PAGES = 5;
/** The poller reads this far back from the cursor, so a message that arrived while the last poll ran is not missed (the event table dedupes). */
export const POLL_OVERLAP_MS = 120_000;
/** Triggers polled by one job run. */
export const POLL_BATCH = 100;
/** Failed polls in a row after which a trigger is `failing`. */
export const FAILING_AFTER_ERRORS = 3;
/** Mail that arrived while the console or the account was unreachable still counts, up to this old. */
export const MAX_CATCHUP_MS = 24 * 60 * 60_000;
/** The back-off after a RATE_LIMITED answer without a Retry-After. */
export const RATE_LIMIT_BACKOFF_MS = 10 * 60_000;

/** The text body a capture pattern runs on is cut here; a subject is at most the provider's own length. */
export const CAPTURE_TEXT_CHARS = 20_000;
export const TEST_PREVIEW_COUNT = 5;
export const TEST_SUBJECT_CHARS = 60;

/** The cursor format: `t1:<ISO instant>`. Opaque to everything but the poller. */
export const CURSOR_PREFIX = 't1:';
