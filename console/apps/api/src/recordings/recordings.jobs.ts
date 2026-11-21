import { Injectable, Logger, type OnModuleInit } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';
import { JobHandlerRegistry, JobsService, enqueueHousekeepingJob, type Job, type JobHandler } from '@marinoscar/platform-api/jobs';

import { PrismaService } from '../prisma/prisma.service';
import { RecordingsService } from './recordings.service';

/** The job type. Permanent once jobs of this type exist: never rename it. */
export const RECORDINGS_FINALIZE_JOB = 'browser.recordings.finalize';

/**
 * `browser.recordings.finalize` (E45.4, #759): makes the video of every run recording that is ready to be made (its run ended) from the
 * parts the run stored, and deletes the parts. Server-only; safe to repeat. One recording failing does not stop the others.
 */
@Injectable()
export class RecordingsFinalizeHandler implements JobHandler, OnModuleInit {
  readonly type = RECORDINGS_FINALIZE_JOB;
  readonly label = 'Make the videos of finished run recordings';
  readonly profile = { maxRuntimeMs: 15 * 60_000, maxAttempts: 2 };
  private readonly log = new Logger(RecordingsFinalizeHandler.name);

  constructor(
    private readonly registry: JobHandlerRegistry,
    private readonly recordings: RecordingsService,
  ) {}

  onModuleInit(): void {
    this.registry.register(this);
  }

  async process(job: Job): Promise<void> {
    await this.pass(job.id);
  }

  async pass(jobId: string): Promise<{ ready: number; failed: number; errors: number }> {
    const totals = { ready: 0, failed: 0, errors: 0 };
    for (const id of await this.recordings.due()) {
      try {
        const r = await this.recordings.finalize(id);
        if (r === 'ready') totals.ready++;
        else if (r === 'failed') totals.failed++;
      } catch (e) {
        totals.errors++;
        this.log.warn(`job ${jobId}: a recording could not be finalized (${e instanceof Error ? e.name : 'error'})`);
      }
    }
    if (totals.ready || totals.failed || totals.errors) this.log.log(`job ${jobId}: ${RECORDINGS_FINALIZE_JOB} ready=${totals.ready} failed=${totals.failed} errors=${totals.errors}`);
    return totals;
  }
}

/** Every minute, when a recording is due. A `@Cron` only decides that work is due and ENQUEUES it (queue rule 1). */
@Injectable()
export class RecordingsFinalizeTask {
  private readonly logger = new Logger(RecordingsFinalizeTask.name);

  constructor(
    private readonly jobs: JobsService,
    private readonly prisma: PrismaService,
    private readonly recordings: RecordingsService,
  ) {}

  @Cron('* * * * *')
  async handleCron(): Promise<void> {
    if ((await this.recordings.due(new Date(), 1)).length === 0) return;
    await enqueueHousekeepingJob({ jobs: this.jobs, prisma: this.prisma, logger: this.logger, type: RECORDINGS_FINALIZE_JOB, what: 'run recordings finalize' });
  }
}
