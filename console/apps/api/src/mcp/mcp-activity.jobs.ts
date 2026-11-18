// Retention of the MCP audit trail (#465): it follows the run retention rule
// of each user (#422): a row is deleted once it is older than the user's age
// limit for runs, under the deployment ceiling. A user who keeps runs forever
// keeps the trail for at most `MCP_ACTIVITY_MAX_DAYS` days (an audit row
// without its run is still useful, but not forever). The nightly `@Cron` only
// enqueues; the job does the work.
import { Injectable, Logger, type OnModuleInit } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';
import { JobHandlerRegistry, JobsService, enqueueHousekeepingJob, type Job, type JobHandler } from '@marinoscar/platform-api/jobs';

import { PrismaService } from '../prisma/prisma.service';
import { RunRetentionService } from '../tasks/run-retention.service';
import { McpActivityService } from './mcp-activity.service';

/** Permanent job type. */
export const MCP_ACTIVITY_PURGE_JOB = 'mcp.activity.purge';
/** The longest the trail is kept for a user whose runs are kept forever. */
export const MCP_ACTIVITY_MAX_DAYS = 365;
/** A row is never deleted before it is this old, whatever the rule. */
export const MCP_ACTIVITY_FLOOR_DAYS = 1;
const DAY_MS = 86_400_000;

/** The age limit of one user's trail, in days: the longest of their run age limits, else the cap. Pure. */
export function activityKeepDays(rule: { keepDays: number | null; keepFailedDays: number | null }): number {
  const limits = [rule.keepDays, rule.keepFailedDays].filter((d): d is number => d !== null);
  const days = limits.length ? Math.max(...limits) : MCP_ACTIVITY_MAX_DAYS;
  return Math.max(MCP_ACTIVITY_FLOOR_DAYS, Math.min(days, MCP_ACTIVITY_MAX_DAYS));
}

/** `mcp.activity.purge`: per user with old rows, delete what is past their rule. Server-only (writes as it goes). */
@Injectable()
export class McpActivityPurgeHandler implements JobHandler, OnModuleInit {
  readonly type = MCP_ACTIVITY_PURGE_JOB;
  readonly label = 'Delete AI app activity past its retention';
  readonly profile = { maxRuntimeMs: 10 * 60_000, maxAttempts: 2 };
  private readonly log = new Logger(McpActivityPurgeHandler.name);

  constructor(
    private readonly registry: JobHandlerRegistry,
    private readonly activity: McpActivityService,
    private readonly retention: RunRetentionService,
  ) {}

  onModuleInit(): void {
    this.registry.register(this);
  }

  async process(job: Job): Promise<void> {
    const done = await this.purge();
    this.log.log(`job ${job.id}: mcp.activity.purge users=${done.users} deleted=${done.deleted}`);
  }

  /** The pass; `now` for tests. */
  async purge(now: Date = new Date()): Promise<{ users: number; deleted: number }> {
    const floor = new Date(now.getTime() - MCP_ACTIVITY_FLOOR_DAYS * DAY_MS);
    let users = 0;
    let deleted = 0;
    let after: string | undefined;
    for (;;) {
      const page = await this.activity.usersWithRowsBefore(floor, 500, after);
      if (page.length === 0) break;
      for (const userId of page) {
        users++;
        try {
          const { limits } = await this.retention.userRetention(userId);
          const rule = await this.retention.effectiveRule(limits);
          deleted += await this.activity.purgeUser(userId, new Date(now.getTime() - activityKeepDays(rule) * DAY_MS));
        } catch (e) {
          this.log.warn(`mcp.activity.purge: user ${userId} failed: ${e instanceof Error ? e.message : String(e)}`);
        }
      }
      after = page.at(-1);
    }
    return { users, deleted };
  }
}

/** Nightly at 03:40 server time: enqueue the purge (no work here). */
@Injectable()
export class McpActivityPurgeTask {
  private readonly logger = new Logger(McpActivityPurgeTask.name);

  constructor(
    private readonly jobs: JobsService,
    private readonly prisma: PrismaService,
  ) {}

  @Cron('40 3 * * *')
  async handleCron(): Promise<void> {
    await enqueueHousekeepingJob({ jobs: this.jobs, prisma: this.prisma, logger: this.logger, type: MCP_ACTIVITY_PURGE_JOB, what: 'AI app activity purge' });
  }
}
