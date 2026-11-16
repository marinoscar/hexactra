import { Injectable, Logger, type OnModuleInit } from '@nestjs/common';
import { Cron, CronExpression } from '@nestjs/schedule';
import { JobHandlerRegistry, JobsService, enqueueHousekeepingJob, type Job, type JobHandler } from '@marinoscar/platform-api/jobs';

import { PrismaService } from '../prisma/prisma.service';
import { DesktopViewerService } from './desktop-viewer.service';

/** The job type. Permanent once jobs of this type exist: never rename it. */
export const VIEWER_SESSIONS_SWEEP_JOB = 'fleet.viewer-sessions.sweep';
const KEEP_MS = 24 * 3600_000;

/**
 * `fleet.viewer-sessions.sweep`: deletes desktop viewer sessions a day after
 * they expired or were revoked. Housekeeping (a system job); server-only.
 */
@Injectable()
export class ViewerSessionsSweepHandler implements JobHandler, OnModuleInit {
  readonly type = VIEWER_SESSIONS_SWEEP_JOB;
  readonly label = 'Delete old remote desktop sessions';
  readonly profile = { maxRuntimeMs: 60_000, maxAttempts: 2 };
  private readonly logger = new Logger(ViewerSessionsSweepHandler.name);

  constructor(
    private readonly registry: JobHandlerRegistry,
    private readonly viewer: DesktopViewerService,
  ) {}

  onModuleInit(): void {
    this.registry.register(this);
  }

  async process(job: Job): Promise<void> {
    const n = await this.viewer.purge(new Date(Date.now() - KEEP_MS));
    if (n > 0) this.logger.log(`job ${job.id}: deleted ${n} desktop session(s)`);
  }
}

/** Hourly: enqueue the sweep when there is something to delete (the cron does no work itself). */
@Injectable()
export class ViewerSessionsSweepTask {
  private readonly logger = new Logger(ViewerSessionsSweepTask.name);

  constructor(
    private readonly jobs: JobsService,
    private readonly prisma: PrismaService,
  ) {}

  @Cron(CronExpression.EVERY_HOUR)
  async handleCron(): Promise<void> {
    const before = new Date(Date.now() - KEEP_MS);
    const due = await this.prisma.viewerSession.count({ where: { OR: [{ expiresAt: { lt: before } }, { revokedAt: { lt: before } }] } });
    if (due === 0) return;
    await enqueueHousekeepingJob({ jobs: this.jobs, prisma: this.prisma, logger: this.logger, type: VIEWER_SESSIONS_SWEEP_JOB, what: 'desktop session sweep' });
  }
}
