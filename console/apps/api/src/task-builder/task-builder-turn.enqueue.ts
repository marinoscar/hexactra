import { Injectable } from '@nestjs/common';
import { JobsService, registerJobReason } from '@marinoscar/platform-api/jobs';

// The task builder's turn job (E42.3): its type and enqueue helper, apart from the handler.

/** Permanent job type (never rename once jobs exist). */
export const TASK_BUILDER_TURN_JOB = 'task_builder.turn';

export const TASK_BUILDER_TURN_REASONS = {
  message: { id: 'task_builder_message', label: 'Task builder message' },
  retry: { id: 'task_builder_turn_busy', label: 'Task builder turn waited for the one before it' },
} as const;
export type TaskBuilderTurnReason = (typeof TASK_BUILDER_TURN_REASONS)[keyof typeof TASK_BUILDER_TURN_REASONS]['id'];
for (const r of Object.values(TASK_BUILDER_TURN_REASONS)) registerJobReason(r);

export const TASK_BUILDER_TURN_MAX_RUNTIME_MS = 2 * 60_000;
export const TASK_BUILDER_TURN_RETRY_DELAY_MS = 3_000;
export const TASK_BUILDER_TURN_MAX_WAITS = 80;

export interface TaskBuilderTurnPayload {
  conversationId: string;
  userId: string;
  orgId: string | null;
  waits?: number;
}

/** Queue one builder turn. Never deduplicated, like a chat's: the lease and `answeredSeq` keep two jobs from answering one message. */
export async function enqueueTaskBuilderTurn(jobs: JobsService, payload: TaskBuilderTurnPayload, reason: TaskBuilderTurnReason = 'task_builder_message', delayMs = 0): Promise<void> {
  await jobs.enqueue({
    type: TASK_BUILDER_TURN_JOB,
    reason,
    subjectType: 'task_builder',
    subjectId: payload.conversationId,
    orgId: payload.orgId,
    payload: { ...payload },
    skipDedup: true,
    ...(delayMs > 0 ? { scheduledFor: new Date(Date.now() + delayMs) } : {}),
  });
}

/** Queues a builder's turn: what the builder service calls after it stored the owner's message. Apart from the handler, so the service does not import the turn engine. */
@Injectable()
export class TaskBuilderTurnQueue {
  constructor(private readonly jobs: JobsService) {}

  request(conversationId: string, userId: string, orgId: string | null): Promise<void> {
    return enqueueTaskBuilderTurn(this.jobs, { conversationId, userId, orgId });
  }
}
