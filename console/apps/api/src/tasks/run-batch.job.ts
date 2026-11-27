import { Injectable, Logger, type OnModuleInit } from '@nestjs/common';
import { Cron, CronExpression } from '@nestjs/schedule';
import { JobHandlerRegistry, JobsService, enqueueHousekeepingJob, type JobHandler } from '@marinoscar/platform-api/jobs';

import { PrismaService } from '../prisma/prisma.service';
import { RunBatchService } from './run-batch.service';

/** Permanent job type (never rename once jobs exist). */
export const RUN_BATCH_RECONCILE_JOB = 'browser.runs.batch_reconcile';

/**
 * `browser.runs.batch_reconcile` (E51.1, #1006): after an API restart (or a hook that never ran), a `running` batch with no live run
 * and a `pending` row starts its next row, and a row whose run ended without the hook is recorded. A row is never started twice: a row
 * claimed whose run was never created goes back to `pending` only when no run exists for it. Server-only.
 */
@Injectable()
export class RunBatchReconcileHandler implements JobHandler, OnModuleInit {
  readonly type = RUN_BATCH_RECONCILE_JOB;
  readonly label = 'Carry on batches of runs after a restart';
  readonly profile = { maxRuntimeMs: 5 * 60_000, maxAttempts: 1 };
  private readonly log = new Logger(RunBatchReconcileHandler.name);

  constructor(
    private readonly registry: JobHandlerRegistry,
    private readonly batches: RunBatchService,
  ) {}

  onModuleInit(): void {
    this.registry.register(this);
  }

  async process(): Promise<void> {
    const moved = await this.batches.reconcile();
    if (moved) this.log.log(`batches: ${moved} reconciled`);
  }
}

/** Every 5 minutes: if a batch is running, enqueue the reconcile (no work here). */
@Injectable()
export class RunBatchReconcileTask {
  private readonly logger = new Logger(RunBatchReconcileTask.name);

  constructor(
    private readonly jobs: JobsService,
    private readonly prisma: PrismaService,
    private readonly batches: RunBatchService,
  ) {}

  @Cron(CronExpression.EVERY_5_MINUTES)
  async handleCron(): Promise<void> {
    if (!(await this.batches.anyRunning())) return;
    await enqueueHousekeepingJob({ jobs: this.jobs, prisma: this.prisma, logger: this.logger, type: RUN_BATCH_RECONCILE_JOB, what: 'batch reconcile' });
  }
}
