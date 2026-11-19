import { JobsService, registerJobReason } from '@marinoscar/platform-api/jobs';

import { DELIVERY_SEND_JOB, DELIVERY_SEND_REASONS, type DeliverySendReason } from './deliveries.constants';

// The delivery job's enqueue helper, apart from the handler so the pipeline and the routes can queue a send without importing the
// handler. The job type is permanent once jobs of it exist.
for (const r of Object.values(DELIVERY_SEND_REASONS)) registerJobReason(r);

export interface DeliverySendPayload {
  runDeliveryId: string;
  userId: string;
  orgId: string | null;
}

/**
 * Queue one send of one run delivery. The first send of a row is deduplicated by the queue (the same row is never queued twice while a
 * job for it is active); a retry is queued from inside the running job (whose own row is still active) or by the owner, so it opts out
 * of dedup. The row is the guard: `RunDelivery.status` decides what a job does, so a job that runs twice sends once.
 */
export async function enqueueDeliverySend(jobs: JobsService, payload: DeliverySendPayload, reason: DeliverySendReason, opts: { delayMs?: number; skipDedup?: boolean } = {}): Promise<void> {
  await jobs.enqueue({
    type: DELIVERY_SEND_JOB,
    reason,
    subjectType: 'run_delivery',
    subjectId: payload.runDeliveryId,
    orgId: payload.orgId,
    payload: { ...payload },
    ...(opts.skipDedup ? { skipDedup: true } : {}),
    ...(opts.delayMs && opts.delayMs > 0 ? { scheduledFor: new Date(Date.now() + opts.delayMs) } : {}),
  });
}
