// Cleanup of the shared rate limit store (#517): a row of `rate_limit_windows`
// matters while it is the current or the previous window of its key; after
// `expires_at` it is never read again. The hourly `@Cron` only enqueues, and
// only when this deployment uses the Postgres store; the job deletes.
import { Injectable, Logger, type OnModuleInit } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';
import { JobHandlerRegistry, JobsService, enqueueHousekeepingJob, type Job, type JobHandler } from '@marinoscar/platform-api/jobs';

import { PrismaService } from '../prisma/prisma.service';
import { rateLimitStoreFrom } from './mcp.rate-limit.pg';

/** Permanent job type. */
export const MCP_RATE_LIMIT_PURGE_JOB = 'mcp.rate_limit.purge';

/** `mcp.rate_limit.purge`: delete the windows past their expiry. Server-only (one delete in the database). */
@Injectable()
export class McpRateLimitPurgeHandler implements JobHandler, OnModuleInit {
  readonly type = MCP_RATE_LIMIT_PURGE_JOB;
  readonly label = 'Delete expired rate limit windows';
  readonly profile = { maxRuntimeMs: 5 * 60_000, maxAttempts: 2 };
  private readonly log = new Logger(McpRateLimitPurgeHandler.name);

  constructor(
    private readonly registry: JobHandlerRegistry,
    private readonly prisma: PrismaService,
  ) {}

  onModuleInit(): void {
    this.registry.register(this);
  }

  async process(job: Job): Promise<void> {
    const deleted = await this.purge();
    this.log.log(`job ${job.id}: mcp.rate_limit.purge deleted=${deleted}`);
  }

  /** The pass; `now` for tests. */
  async purge(now: Date = new Date()): Promise<number> {
    const { count } = await this.prisma.rateLimitWindow.deleteMany({ where: { expiresAt: { lt: now } } });
    return count;
  }
}

/** Hourly at :23: enqueue the purge when the Postgres store is in use (no work here). */
@Injectable()
export class McpRateLimitPurgeTask {
  private readonly logger = new Logger(McpRateLimitPurgeTask.name);

  constructor(
    private readonly jobs: JobsService,
    private readonly prisma: PrismaService,
  ) {}

  @Cron('23 * * * *')
  async handleCron(): Promise<void> {
    if (rateLimitStoreFrom() !== 'postgres') return;
    await enqueueHousekeepingJob({ jobs: this.jobs, prisma: this.prisma, logger: this.logger, type: MCP_RATE_LIMIT_PURGE_JOB, what: 'rate limit window purge' });
  }
}
