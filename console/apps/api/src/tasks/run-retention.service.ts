// Run retention (#422): which finished runs of a user fall outside their rule,
// counted (the preview) or deleted (the nightly job, "apply now") by the same
// query.
//
// A run is deleted when it is terminal and either limit says so: it ended
// (finished, else created) before its age limit, or it is beyond the newest
// `keepPerTask` terminal runs of its task (runs without a task are one group).
// Never deleted: a live run, a run younger than the floor (24 h, or the longest
// window of an enabled alert rule that reads runs), a run with a pending question.
import { Injectable, Logger, Optional } from '@nestjs/common';
import { JobsService, registerJobReason } from '@marinoscar/platform-api/jobs';
import { SystemSettingsService } from '@marinoscar/platform-api/settings';
import { Prisma } from '@prisma/client';

import { RUN_READING_ALERT_KINDS } from '../alerts/run-alert-kinds';
import { alertsMounted } from '../platform/alerts/alerts.enabled';
import { PrismaService } from '../prisma/prisma.service';
import { RunDeleteService } from './run-delete.service';
import {
  RETENTION_FLOOR_HOURS,
  RETENTION_USER_NIGHTLY_CAP,
  effectiveRetentionRule,
  keepsEverything,
  salvageRetentionSettings,
  type EffectiveRetentionRule,
  type RunRetentionLimits,
} from './run-retention.schemas';
import './runs.settings';

/** The nightly job: every user. Permanent once jobs of this type exist: never rename it. */
export const RUNS_RETENTION_JOB = 'browser.runs.retention';
/**
 * "Apply now": one user. Its own type (permanent too), because the nightly
 * enqueue skips its tick while a job of ITS type is pending or running: one
 * person pressing the button at 03:19 must not cancel everyone's night.
 */
export const RUNS_RETENTION_APPLY_JOB = 'browser.runs.retention.apply';
/** Why a one-user job was enqueued (a permanent id, shown in the admin job list). */
export const RUNS_RETENTION_APPLY_REASON = { id: 'runs_retention_apply', label: 'Apply run retention now' } as const;
registerJobReason(RUNS_RETENTION_APPLY_REASON);

/** The audit action of one nightly pass: its totals, read by the Doctor check. */
export const RUNS_RETENTION_AUDIT_ACTION = 'runs.retention_completed';

const HOUR_MS = 3_600_000;
const DAY_MS = 24 * HOUR_MS;

export interface RetentionPreview {
  wouldDelete: number;
  finished: number;
  oldestKept: string | null;
  costUsd: number | null;
}

/** A user's stored rule, with whether they ever saved one. */
export interface UserRetention {
  limits: RunRetentionLimits;
  /** When the user saved a rule or was told about the default; null: neither yet. */
  noticeSentAt: string | null;
}

@Injectable()
export class RunRetentionService {
  private readonly log = new Logger(RunRetentionService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly runs: RunDeleteService,
    @Optional() private readonly systemSettings?: SystemSettingsService,
    @Optional() private readonly jobs?: JobsService,
  ) {}

  /** The user's stored `runs` namespace (read without creating a settings row), salvaged field by field. */
  async userRetention(userId: string): Promise<UserRetention> {
    const row = await this.prisma.userSettings.findUnique({ where: { userId }, select: { value: true } });
    const { noticeSentAt, ...limits } = salvageRetentionSettings((row?.value as { runs?: unknown } | null | undefined)?.runs);
    return { limits, noticeSentAt };
  }

  /** The deployment's ceiling in days; null: none (also when the stored value is unreadable). */
  async maxKeepDays(): Promise<number | null> {
    try {
      return (await this.systemSettings?.getNamespace('runs'))?.maxKeepDays ?? null;
    } catch (e) {
      this.log.warn(`runs.retention: the deployment ceiling could not be read (${e instanceof Error ? e.name : 'error'}); no ceiling applied`);
      return null;
    }
  }

  /**
   * How young a run must be to be safe from retention, in hours: 24, or the
   * longest `windowHours` of an enabled alert rule whose kind reads runs, so
   * retention never empties a window an alert is counting.
   */
  async floorHours(): Promise<number> {
    if (!alertsMounted()) return RETENTION_FLOOR_HOURS;
    const rules = await this.prisma.alertRule.findMany({ where: { enabled: true, kind: { in: [...RUN_READING_ALERT_KINDS] } }, select: { config: true } });
    let hours = RETENTION_FLOOR_HOURS;
    for (const rule of rules) {
      const window = (rule.config as { windowHours?: unknown } | null)?.windowHours;
      // A rule stored without one evaluates with the kinds' default, 24 h: the floor already.
      if (typeof window === 'number' && Number.isFinite(window)) hours = Math.max(hours, Math.ceil(window));
    }
    return hours;
  }

  /** The user's limits under the ceiling: what the job applies. */
  async effectiveRule(limits: RunRetentionLimits): Promise<EffectiveRetentionRule & { maxKeepDays: number | null }> {
    const maxKeepDays = await this.maxKeepDays();
    return { ...effectiveRetentionRule(limits, maxKeepDays), maxKeepDays };
  }

  /**
   * The user's terminal runs, each marked `doomed` when the rule deletes it.
   * Every value is a bound parameter and the user is in the WHERE: one user's
   * rule can never reach another user's run.
   */
  private marked(userId: string, rule: EffectiveRetentionRule, now: Date, floorHours: number): Prisma.Sql {
    const before = (days: number | null) => (days === null ? null : new Date(now.getTime() - days * DAY_MS));
    const floor = new Date(now.getTime() - floorHours * HOUR_MS);
    const cutoff = before(rule.keepDays);
    const failedCutoff = before(rule.keepFailedDays);
    return Prisma.sql`
      WITH ranked AS (
        SELECT r.id, r.status, r.cost_usd, r.model_calls,
               COALESCE(r.finished_at, r.created_at) AS ended_at,
               ROW_NUMBER() OVER (PARTITION BY r.task_id ORDER BY r.created_at DESC, r.id DESC) AS rn
        FROM runs r
        WHERE r.user_id = ${userId}::uuid AND r.status IN ('succeeded', 'failed', 'cancelled')
      ), marked AS (
        SELECT k.id, k.ended_at, k.cost_usd, k.model_calls,
               (k.ended_at < ${floor}::timestamptz
                AND NOT EXISTS (SELECT 1 FROM questions q WHERE q.run_id = k.id AND q.status = 'pending')
                AND ((${rule.keepPerTask}::int IS NOT NULL AND k.rn > ${rule.keepPerTask}::int)
                  OR (k.status = 'failed' AND ${failedCutoff}::timestamptz IS NOT NULL AND k.ended_at < ${failedCutoff}::timestamptz)
                  OR (k.status <> 'failed' AND ${cutoff}::timestamptz IS NOT NULL AND k.ended_at < ${cutoff}::timestamptz))) AS doomed
        FROM ranked k
      )`;
  }

  /** What the rule would delete of the user's runs now, without deleting. */
  async preview(userId: string, rule: EffectiveRetentionRule, opts: { now?: Date; floorHours?: number } = {}): Promise<RetentionPreview> {
    const now = opts.now ?? new Date();
    const floorHours = opts.floorHours ?? (await this.floorHours());
    const rows = await this.prisma.$queryRaw<{ would_delete: bigint; finished: bigint; oldest_kept: Date | null; cost_usd: Prisma.Decimal | null; model_calls: bigint | null }[]>(Prisma.sql`
      ${this.marked(userId, rule, now, floorHours)}
      SELECT COUNT(*) FILTER (WHERE doomed) AS would_delete,
             COUNT(*) AS finished,
             MIN(ended_at) FILTER (WHERE NOT doomed) AS oldest_kept,
             SUM(cost_usd) FILTER (WHERE doomed) AS cost_usd,
             SUM(model_calls) FILTER (WHERE doomed) AS model_calls
      FROM marked`);
    const row = rows[0];
    return {
      wouldDelete: Number(row?.would_delete ?? 0),
      finished: Number(row?.finished ?? 0),
      oldestKept: row?.oldest_kept ? row.oldest_kept.toISOString() : null,
      // Null when none of them made a model call (the rule of `GET /runs/counts`).
      costUsd: Number(row?.model_calls ?? 0) > 0 ? Number(row?.cost_usd ?? 0) : null,
    };
  }

  /**
   * Delete what the rule says, oldest first, through the delete service of
   * #421 (steps, questions, schedules' `lastRunId` and stored screenshots go
   * the same way). At most `RETENTION_USER_NIGHTLY_CAP` runs per call.
   */
  async apply(userId: string, rule: EffectiveRetentionRule, opts: { now?: Date; floorHours?: number; jobId?: string; orgId?: string | null } = {}): Promise<{ deleted: number; capped: boolean }> {
    if (keepsEverything(rule)) return { deleted: 0, capped: false };
    const now = opts.now ?? new Date();
    const floorHours = opts.floorHours ?? (await this.floorHours());
    const rows = await this.prisma.$queryRaw<{ id: string }[]>(Prisma.sql`
      ${this.marked(userId, rule, now, floorHours)}
      SELECT id FROM marked WHERE doomed ORDER BY ended_at ASC, id ASC LIMIT ${RETENTION_USER_NIGHTLY_CAP}`);
    if (rows.length === 0) return { deleted: 0, capped: false };
    const done = await this.runs.deleteByIds(
      userId,
      rows.map((r) => r.id),
      { mode: 'retention', jobId: opts.jobId, orgId: opts.orgId },
    );
    return { deleted: done.deleted, capped: rows.length >= RETENTION_USER_NIGHTLY_CAP };
  }

  /** `POST /runs/retention/apply`: one job for the calling user; the same request while it is pending is the same job. */
  async enqueueForUser(userId: string, orgId: string | null): Promise<{ jobId: string }> {
    if (!this.jobs) throw new Error('RunRetentionService: applying retention needs the job queue');
    const job = await this.jobs.enqueue({
      type: RUNS_RETENTION_APPLY_JOB,
      reason: RUNS_RETENTION_APPLY_REASON.id,
      subjectType: 'run_retention',
      subjectId: userId,
      orgId,
      payload: { userId, orgId },
    });
    return { jobId: job.id };
  }
}
