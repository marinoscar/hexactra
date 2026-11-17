import { JobsService, registerJobReason } from '@marinoscar/platform-api/jobs';

// The goal run's job type and its enqueue helper, apart from the handler so
// the question broker can resume a run without importing the runner.

/** Permanent job types (never rename once jobs exist). */
export const GOAL_RUN_JOB = 'browser.goal.run';
export const HANDOFF_CHECK_JOB = 'browser.handoffs.check';

/** Why a run job was enqueued (permanent ids, shown in the admin job list). */
export const GOAL_RUN_REASONS = {
  started: { id: 'run_started', label: 'Run started' },
  handoffAnswered: { id: 'handoff_answered', label: 'Handoff answered' },
  handoffResolved: { id: 'handoff_resolved', label: 'Handoff resolved' },
  schedule: { id: 'schedule', label: 'Scheduled run' },
  continued: { id: 'run_continued', label: 'Run continued in a new job' },
} as const;
export type GoalRunReason = (typeof GOAL_RUN_REASONS)[keyof typeof GOAL_RUN_REASONS]['id'];
for (const r of Object.values(GOAL_RUN_REASONS)) registerJobReason(r);

/** The job's runtime limit (its `profile.maxRuntimeMs`). */
export const GOAL_RUN_MAX_RUNTIME_MS = 30 * 60_000;
/** A job hands the run to a new job this long before its lease would run out. */
export const GOAL_RUN_HOP_MARGIN_MS = 2 * 60_000;
/** Delay before a continuation job may start, so the job handing over has finished. */
export const GOAL_RUN_HOP_DELAY_MS = 3_000;

export interface GoalRunPayload {
  runId: string;
  userId: string;
  orgId: string | null;
}

/** Queue one advance of a run (start, or resume after a handoff). */
export async function enqueueGoalRun(jobs: JobsService, payload: GoalRunPayload, reason: GoalRunReason): Promise<void> {
  await jobs.enqueue({
    type: GOAL_RUN_JOB,
    reason,
    subjectType: 'browser_run',
    subjectId: payload.runId,
    orgId: payload.orgId,
    payload: { ...payload },
  });
}


/**
 * Continue a run in a new job (the current one is near its runtime limit).
 * Called from inside the running job, whose own row is still active and
 * would swallow a deduplicated enqueue, so this one opts out of dedup
 * (`skipDedup`) and starts a few seconds later. The run itself is the guard:
 * `advance()` is a no-op for a run that is already finished.
 */
export async function enqueueGoalRunContinuation(jobs: JobsService, payload: GoalRunPayload): Promise<void> {
  await jobs.enqueue({
    type: GOAL_RUN_JOB,
    reason: GOAL_RUN_REASONS.continued.id,
    subjectType: 'browser_run',
    subjectId: payload.runId,
    orgId: payload.orgId,
    payload: { ...payload },
    skipDedup: true,
    scheduledFor: new Date(Date.now() + GOAL_RUN_HOP_DELAY_MS),
  });
}
