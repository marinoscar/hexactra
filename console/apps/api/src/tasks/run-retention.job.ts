import { Injectable, Logger, Optional, type OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Cron } from '@nestjs/schedule';
import { JobHandlerRegistry, JobsService, enqueueHousekeepingJob, type Job, type JobHandler } from '@marinoscar/platform-api/jobs';
import { NotificationsService } from '@marinoscar/platform-api/notifications';
import { UserSettingsService } from '@marinoscar/platform-api/settings';
import { z } from 'zod';

import { RUN_RETENTION_NOTICE_EVENT } from '../platform/notifications/hexactra.notifications';
import { PrismaService } from '../prisma/prisma.service';
import { TERMINAL_RUN_STATUSES } from './run-status';
import { RETENTION_USER_NIGHTLY_CAP, RETENTION_USER_PAGE, effectiveRetentionRule, keepsEverything } from './run-retention.schemas';
import { RUNS_RETENTION_APPLY_JOB, RUNS_RETENTION_AUDIT_ACTION, RUNS_RETENTION_JOB, RunRetentionService } from './run-retention.service';

/** What one nightly pass did. */
export interface RetentionPassTotals {
  /** Users with at least one finished run. */
  users: number;
  deleted: number;
  /** Users whose rule keeps everything, or who had nothing to delete. */
  skipped: number;
  /** Users told that the default rule starts deleting tomorrow (nothing deleted for them tonight). */
  noticed: number;
  failed: number;
}

/**
 * `browser.runs.retention`: the nightly pass over every user with finished
 * runs. Per user it reads their `runs` settings, applies the deployment
 * ceiling and deletes what the rule says through the delete service of #421.
 *
 * A user who never saved a rule is on the default (90 days). Nobody asked for
 * that delete, so the first night there is something to remove the job only
 * records it (`noticeSentAt` in the user's namespace), tells the user, after
 * that write committed, and deletes from the next night on.
 *
 * One user's failure is logged and the pass goes on; the job fails only when
 * more than half the users failed. Safe to repeat: a second pass the same
 * night finds nothing. Server-only: it writes as it goes, so it carries
 * neither `nodeResultSchema` nor `persistNodeResult`.
 */
@Injectable()
export class RunRetentionHandler implements JobHandler, OnModuleInit {
  readonly type = RUNS_RETENTION_JOB;
  readonly label = 'Delete runs past their retention';
  readonly profile = { maxRuntimeMs: 15 * 60_000, maxAttempts: 2 };
  private readonly log = new Logger(RunRetentionHandler.name);

  constructor(
    private readonly registry: JobHandlerRegistry,
    private readonly retention: RunRetentionService,
    private readonly prisma: PrismaService,
    private readonly userSettings: UserSettingsService,
    private readonly config: ConfigService,
    @Optional() private readonly notifications?: NotificationsService,
  ) {}

  onModuleInit(): void {
    this.registry.register(this);
  }

  async process(job: Job): Promise<void> {
    const totals = await this.pass(job.id);
    if (totals.failed > totals.users / 2) throw new Error(`run retention failed for ${totals.failed} of ${totals.users} user(s)`);
  }

  /** One pass over every user with a finished run. `now` is for tests. */
  async pass(jobId: string, now = new Date()): Promise<RetentionPassTotals> {
    const started = Date.now();
    const totals: RetentionPassTotals = { users: 0, deleted: 0, skipped: 0, noticed: 0, failed: 0 };
    // Once per pass: the alert windows and the ceiling are the same for every user.
    const floorHours = await this.retention.floorHours();
    const maxKeepDays = await this.retention.maxKeepDays();
    let after: string | undefined;
    for (;;) {
      const page = await this.prisma.run.groupBy({
        by: ['userId'],
        where: { status: { in: [...TERMINAL_RUN_STATUSES] }, ...(after ? { userId: { gt: after } } : {}) },
        orderBy: { userId: 'asc' },
        take: RETENTION_USER_PAGE,
      });
      if (page.length === 0) break;
      after = page.at(-1)!.userId;
      for (const { userId } of page) {
        totals.users += 1;
        try {
          const outcome = await this.user(userId, { jobId, now, floorHours, maxKeepDays });
          if (outcome === 'noticed') totals.noticed += 1;
          else if (outcome === 0) totals.skipped += 1;
          else totals.deleted += outcome;
        } catch (e) {
          totals.failed += 1;
          // Never the message: a query error can quote a value.
          this.log.warn(`job ${jobId}: retention failed for user ${userId} (${e instanceof Error ? e.name : 'error'}); moving on`);
        }
      }
    }
    const ms = Date.now() - started;
    this.log.log(`job ${jobId}: runs.retention users=${totals.users} deleted=${totals.deleted} skipped=${totals.skipped} noticed=${totals.noticed} failed=${totals.failed} ms=${ms}`);
    try {
      await this.prisma.auditEvent.create({ data: { action: RUNS_RETENTION_AUDIT_ACTION, targetType: 'job', targetId: jobId, meta: { ...totals, ms } } });
    } catch (e) {
      this.log.warn(`job ${jobId}: the retention totals could not be recorded: ${e instanceof Error ? e.name : 'error'}`);
    }
    return totals;
  }

  /** One user: runs deleted, or `noticed` when they were only told. */
  private async user(userId: string, ctx: { jobId: string; now: Date; floorHours: number; maxKeepDays: number | null }): Promise<number | 'noticed'> {
    const { limits, noticeSentAt } = await this.retention.userRetention(userId);
    const rule = effectiveRetentionRule(limits, ctx.maxKeepDays);
    if (keepsEverything(rule)) return 0;
    if (noticeSentAt === null) {
      // The default rule, never chosen by this user: tell them first, delete from tomorrow.
      const { wouldDelete } = await this.retention.preview(userId, rule, { now: ctx.now, floorHours: ctx.floorHours });
      if (wouldDelete === 0) return 0;
      await this.userSettings.patchSettings(userId, { runs: { noticeSentAt: ctx.now.toISOString() } } as never);
      // After the commit, outside any transaction; `notifyNow` records a delivery failure and never rejects.
      const settingsUrl = `${(this.config.get<string>('appUrl') ?? '').replace(/\/+$/, '')}/settings/run-history`;
      await this.notifications?.notifyNow(RUN_RETENTION_NOTICE_EVENT, userId, { days: rule.keepDays, count: wouldDelete, settingsUrl });
      this.log.log(`job ${ctx.jobId}: user ${userId} told that ${wouldDelete} run(s) fall outside the default rule; deleting from the next pass`);
      return 'noticed';
    }
    const done = await this.retention.apply(userId, rule, { now: ctx.now, floorHours: ctx.floorHours, jobId: ctx.jobId });
    if (done.capped) this.log.warn(`job ${ctx.jobId}: user ${userId} reached the nightly cap of ${RETENTION_USER_NIGHTLY_CAP} runs; the rest goes in the next pass`);
    return done.deleted;
  }
}

const applyPayloadSchema = z.object({ userId: z.uuid(), orgId: z.uuid().nullable().optional() });

/**
 * `browser.runs.retention.apply`: "Apply now" for one user
 * (`POST /api/runs/retention/apply`). The user asked, so there is no notice
 * night: their saved rule, under the ceiling, is applied at once.
 */
@Injectable()
export class RunRetentionApplyHandler implements JobHandler, OnModuleInit {
  readonly type = RUNS_RETENTION_APPLY_JOB;
  readonly label = 'Apply run retention for one user';
  readonly profile = { maxRuntimeMs: 15 * 60_000, maxAttempts: 2 };
  private readonly log = new Logger(RunRetentionApplyHandler.name);

  constructor(
    private readonly registry: JobHandlerRegistry,
    private readonly retention: RunRetentionService,
  ) {}

  onModuleInit(): void {
    this.registry.register(this);
  }

  async process(job: Job): Promise<void> {
    const p = applyPayloadSchema.parse(job.payload);
    const { limits } = await this.retention.userRetention(p.userId);
    const rule = await this.retention.effectiveRule(limits);
    const done = await this.retention.apply(p.userId, rule, { jobId: job.id, orgId: p.orgId ?? null });
    this.log.log(`job ${job.id}: runs.retention (apply now) deleted=${done.deleted}${done.capped ? ` (the cap of ${RETENTION_USER_NIGHTLY_CAP}; apply again for the rest)` : ''}`);
  }
}

/**
 * The nightly trigger, 03:20 server time. A `@Cron` only decides that work is
 * due and ENQUEUES it (queue rule 1; the `cron-enqueue-only` conformance suite
 * checks the body).
 */
@Injectable()
export class RunRetentionTask {
  private readonly logger = new Logger(RunRetentionTask.name);

  constructor(
    private readonly jobs: JobsService,
    private readonly prisma: PrismaService,
  ) {}

  @Cron('20 3 * * *')
  async handleCron(): Promise<void> {
    await enqueueHousekeepingJob({ jobs: this.jobs, prisma: this.prisma, logger: this.logger, type: RUNS_RETENTION_JOB, what: 'run retention' });
  }
}
