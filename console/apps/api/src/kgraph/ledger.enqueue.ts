import { JobsService, registerJobReason } from '@marinoscar/platform-api/jobs';

// The ledger job's type and enqueue helper, apart from the handler so the run-end hook can queue it without importing the handler.

/** The job type. Permanent once jobs of this type exist: never rename it. */
export const KGRAPH_LEDGER_JOB = 'kgraph.ledger.write';
export const KGRAPH_LEDGER_REASON = { id: 'kgraph_run_ended', label: 'A Knowledge Graph run ended' } as const;
registerJobReason(KGRAPH_LEDGER_REASON);

export interface LedgerJobPayload {
  runId: string;
  userId: string;
}

/** Queue the ledger row of one ended run. The queue dedups a live job for the same run; the row is an upsert, so a repeat writes it once. */
export async function enqueueLedgerWrite(jobs: Pick<JobsService, 'enqueue'>, payload: LedgerJobPayload): Promise<void> {
  await jobs.enqueue({ type: KGRAPH_LEDGER_JOB, reason: KGRAPH_LEDGER_REASON.id, subjectType: 'kgraph_ledger', subjectId: payload.runId, orgId: null, payload: { ...payload } });
}
