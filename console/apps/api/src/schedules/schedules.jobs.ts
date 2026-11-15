import { Injectable, Logger, type OnModuleInit } from '@nestjs/common';
import { Cron, CronExpression } from '@nestjs/schedule';
import { JobHandlerRegistry, JobsService, enqueueHousekeepingJob, type JobHandler } from '@marinoscar/platform-api/jobs';

import { PrismaService } from '../prisma/prisma.service';
import { SchedulesService } from './schedules.service';

export const SCHEDULES_TICK_JOB = 'browser.schedules.tick';

/** Listener for schedules that keep failing (notifications, E22.2, bind it). */
export const SCHEDULE_FAILING_LISTENERS: ((e: { userId: string; scheduleId: string; taskName: string; failures: number }) => Promise<void>)[] = [];

/** `browser.schedules.tick`: start the runs of every due schedule. */
@Injectable()
export class SchedulesTickHandler implements JobHandler, OnModuleInit {
  readonly type = SCHEDULES_TICK_JOB;
  readonly label = 'Start scheduled browser runs';
  readonly profile = { maxRuntimeMs: 2 * 60_000, maxAttempts: 1 };

  constructor(
    private readonly registry: JobHandlerRegistry,
    private readonly schedules: SchedulesService,
  ) {}

  onModuleInit(): void {
    this.registry.register(this);
  }

  async process(): Promise<void> {
    const { failing } = await this.schedules.tick();
    for (const f of failing) for (const l of SCHEDULE_FAILING_LISTENERS) await l(f);
  }
}

/** Every minute: if a schedule is due, enqueue the tick (no work here). */
@Injectable()
export class SchedulesTickTask {
  private readonly logger = new Logger(SchedulesTickTask.name);

  constructor(
    private readonly jobs: JobsService,
    private readonly prisma: PrismaService,
  ) {}

  @Cron(CronExpression.EVERY_MINUTE)
  async handleCron(): Promise<void> {
    const due = await this.prisma.taskSchedule.count({ where: { enabled: true, nextRunAt: { lte: new Date() } } });
    if (due === 0) return;
    await enqueueHousekeepingJob({ jobs: this.jobs, prisma: this.prisma, logger: this.logger, type: SCHEDULES_TICK_JOB, what: 'schedules tick' });
  }
}
