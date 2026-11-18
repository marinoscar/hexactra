import { JobsService, registerJobReason } from '@marinoscar/platform-api/jobs';

// The chat turn's job type and its enqueue helper, apart from the handler so
// the controller can queue a turn without importing the AI module.

/** Permanent job type (never rename once jobs exist). */
export const CHAT_TURN_JOB = 'chat.turn';

/** Why a turn job was enqueued (permanent ids, shown in the admin job list). */
export const CHAT_TURN_REASONS = {
  message: { id: 'chat_message', label: 'Chat message' },
  retry: { id: 'chat_turn_busy', label: 'Chat turn waited for the one before it' },
} as const;
export type ChatTurnReason = (typeof CHAT_TURN_REASONS)[keyof typeof CHAT_TURN_REASONS]['id'];
for (const r of Object.values(CHAT_TURN_REASONS)) registerJobReason(r);

/** The job's runtime limit (its `profile.maxRuntimeMs`). */
export const CHAT_TURN_MAX_RUNTIME_MS = 2 * 60_000;
/** How long a job that found the chat busy waits before it looks again. */
export const CHAT_TURN_RETRY_DELAY_MS = 3_000;
/** How often a job re-queues itself behind a busy chat before it gives up (the lease outlives a crashed turn by less than this). */
export const CHAT_TURN_MAX_WAITS = 80;

export interface ChatTurnPayload {
  conversationId: string;
  userId: string;
  orgId: string | null;
  /** How many times this turn has already waited for a busy chat. */
  waits?: number;
}

/**
 * Queue one turn of a chat. Never deduplicated: a message that arrives while
 * a turn is working needs a turn of its own, and a deduplicated enqueue would
 * collapse onto the job that is about to finish. The conversation's lease and
 * its `answeredSeq` keep two jobs from answering the same message
 * (chat-turn.service.ts).
 */
export async function enqueueChatTurn(jobs: JobsService, payload: ChatTurnPayload, reason: ChatTurnReason = 'chat_message', delayMs = 0): Promise<void> {
  await jobs.enqueue({
    type: CHAT_TURN_JOB,
    reason,
    subjectType: 'chat',
    subjectId: payload.conversationId,
    orgId: payload.orgId,
    payload: { ...payload },
    skipDedup: true,
    ...(delayMs > 0 ? { scheduledFor: new Date(Date.now() + delayMs) } : {}),
  });
}
