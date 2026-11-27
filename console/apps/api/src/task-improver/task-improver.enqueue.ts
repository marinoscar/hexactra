import { JobsService, registerJobReason } from '@marinoscar/platform-api/jobs';

// The proposal job of "Improve this task" (E52.8): its type and enqueue helper, apart from the handler.

/** Permanent job type (never rename once jobs exist). */
export const TASK_IMPROVER_JOB = 'task_improver.propose';
export const TASK_IMPROVER_REASON = { id: 'task_improver_request', label: 'An owner asked to improve a task' } as const;
registerJobReason(TASK_IMPROVER_REASON);

export const TASK_IMPROVER_MAX_RUNTIME_MS = 4 * 60_000;

export interface TaskImproverPayload {
  improvementId: string;
  userId: string;
  orgId: string | null;
}

export async function enqueueTaskImprovement(jobs: JobsService, payload: TaskImproverPayload): Promise<void> {
  await jobs.enqueue({
    type: TASK_IMPROVER_JOB,
    reason: TASK_IMPROVER_REASON.id,
    subjectType: 'task_improvement',
    subjectId: payload.improvementId,
    orgId: payload.orgId,
    payload: { ...payload },
  });
}
