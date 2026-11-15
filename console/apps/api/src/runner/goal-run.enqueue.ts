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
} as const;
export type GoalRunReason = (typeof GOAL_RUN_REASONS)[keyof typeof GOAL_RUN_REASONS]['id'];
for (const r of Object.values(GOAL_RUN_REASONS)) registerJobReason(r);

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

