import { Injectable, Logger, type OnModuleInit } from '@nestjs/common';
import { JobHandlerRegistry, type Job, type JobHandler } from '@marinoscar/platform-api/jobs';
import { z } from 'zod';

import { RUNS_DELETE_JOB, RunDeleteService } from './run-delete.service';
import { runFilterSchema } from './runs.schemas';

const payloadSchema = z.object({
  userId: z.uuid(),
  orgId: z.uuid().nullable().optional(),
  filter: runFilterSchema,
  requestedAt: z.iso.datetime({ offset: true }),
});

/**
 * `browser.runs.delete`: deletes every finished run of one user that matches a
 * filter, when the filter matched more than a request deletes (#421).
 *
 * It resolves the filter again, with `createdAt <= requestedAt`, so a run
 * created after the request is never swept in, and deletes 200 runs per
 * transaction until none is left. A failure leaves the committed batches
 * deleted; the retry finds only what remains. Server-only: it writes as it
 * goes, so it carries neither `nodeResultSchema` nor `persistNodeResult`.
 */
@Injectable()
export class RunsDeleteHandler implements JobHandler, OnModuleInit {
  readonly type = RUNS_DELETE_JOB;
  readonly label = 'Delete runs by filter';
  readonly profile = { maxRuntimeMs: 10 * 60_000, maxAttempts: 3 };
  private readonly log = new Logger(RunsDeleteHandler.name);

  constructor(
    private readonly registry: JobHandlerRegistry,
    private readonly runs: RunDeleteService,
  ) {}

  onModuleInit(): void {
    this.registry.register(this);
  }

  async process(job: Job): Promise<void> {
    const p = payloadSchema.parse(job.payload);
    const done = await this.runs.deleteMatching(p.userId, p.filter, { createdAtOrBefore: new Date(p.requestedAt), mode: 'filter', jobId: job.id, orgId: p.orgId ?? null });
    this.log.log(`job ${job.id}: deleted ${done.deleted} run(s), ${done.skippedLive.length} left alone (live)`);
  }
}
