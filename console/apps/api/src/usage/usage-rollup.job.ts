import { Injectable, Logger, type OnModuleInit } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';
import { JobHandlerRegistry, JobsService, enqueueHousekeepingJob, type Job, type JobHandler } from '@marinoscar/platform-api/jobs';

import { PrismaService } from '../prisma/prisma.service';
import { UsageRollupService } from './usage-rollup.service';

/** Rolls the AI usage ledger into hourly sums. Permanent once jobs of this type exist: never rename it. */
export const USAGE_ROLLUP_JOB = 'usage.rollup';

/**
 * `usage.rollup` (#732), not an `ai.*` job: it calls no model and runs while
 * AI is off. It rolls every hour since the watermark (the first
 * run rolls the whole ledger, a week per transaction) and deletes rollup hours
 * older than 25 months. Idempotent: a window is replaced, never added to.
 * Server-only.
 */
@Injectable()
export class UsageRollupHandler implements JobHandler, OnModuleInit {
  readonly type = USAGE_ROLLUP_JOB;
  readonly label = 'Roll up AI usage per hour';
  readonly profile = { maxRuntimeMs: 30 * 60_000, maxAttempts: 3 };
  private readonly log = new Logger(UsageRollupHandler.name);

  constructor(
    private readonly registry: JobHandlerRegistry,
    private readonly rollup: UsageRollupService,
  ) {}

  onModuleInit(): void {
    this.registry.register(this);
  }

  async process(job: Job): Promise<void> {
    const started = Date.now();
    const pass = await this.rollup.roll();
    this.log.log(
      `job ${job.id}: usage.rollup windows=${pass.windows} hours=${pass.hours} rows=${pass.rows} purged=${pass.purged} rolledUntil=${pass.rolledUntil ?? 'none'} ms=${Date.now() - started}`,
    );
  }
}

/**
 * Every 15 minutes: a `@Cron` only ENQUEUES (queue rule 1). The job skips a
 * tick while one of its type is pending or running (`enqueueHousekeepingJob`).
 */
@Injectable()
export class UsageRollupTask {
  private readonly logger = new Logger(UsageRollupTask.name);

  constructor(
    private readonly jobs: JobsService,
    private readonly prisma: PrismaService,
  ) {}

  @Cron('7,22,37,52 * * * *')
  async handleCron(): Promise<void> {
    await enqueueHousekeepingJob({ jobs: this.jobs, prisma: this.prisma, logger: this.logger, type: USAGE_ROLLUP_JOB, what: 'AI usage rollup' });
  }
}
