import { Injectable, Logger, type OnModuleInit } from '@nestjs/common';
import { Cron, CronExpression } from '@nestjs/schedule';
import { JobHandlerRegistry, JobsService, enqueueHousekeepingJob, type JobHandler } from '@marinoscar/platform-api/jobs';

import { PrismaService } from '../prisma/prisma.service';
import { RunPauseService } from './run-pause.service';

/** Permanent job type (never rename once jobs exist). */
export const RUNS_PAUSED_SWEEP_JOB = 'browser.runs.paused_sweep';

/**
 * `browser.runs.paused_sweep` (E38.2, #583): tells the owner of a run paused for an hour ("Still paused: <goal>", once) and cancels
 * a run paused longer than `runs.maxPausedHours` (default 72) with the reason "Paused too long". A paused run is never resumed here.
 * Server-only: it writes as it goes.
 */
@Injectable()
export class RunPausedSweepHandler implements JobHandler, OnModuleInit {
  readonly type = RUNS_PAUSED_SWEEP_JOB;
  readonly label = 'Notify and cancel runs paused too long';
  readonly profile = { maxRuntimeMs: 5 * 60_000, maxAttempts: 1 };
  private readonly log = new Logger(RunPausedSweepHandler.name);

  constructor(
    private readonly registry: JobHandlerRegistry,
    private readonly pauses: RunPauseService,
  ) {}

  onModuleInit(): void {
    this.registry.register(this);
  }

  async process(): Promise<void> {
    const { notified, cancelled } = await this.pauses.sweep();
    if (notified || cancelled) this.log.log(`paused runs: ${notified} notified, ${cancelled} cancelled`);
  }
}

/** Every 5 minutes: if a paused run is due for its notice or its limit, enqueue the sweep (no work here). */
@Injectable()
export class RunPausedSweepTask {
  private readonly logger = new Logger(RunPausedSweepTask.name);

  constructor(
    private readonly jobs: JobsService,
    private readonly prisma: PrismaService,
    private readonly pauses: RunPauseService,
  ) {}

  @Cron(CronExpression.EVERY_5_MINUTES)
  async handleCron(): Promise<void> {
    if (!(await this.pauses.anyDue())) return;
    await enqueueHousekeepingJob({ jobs: this.jobs, prisma: this.prisma, logger: this.logger, type: RUNS_PAUSED_SWEEP_JOB, what: 'paused-run sweep' });
  }
}
