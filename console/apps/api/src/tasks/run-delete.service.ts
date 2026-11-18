// Deleting runs (#421): one run, a list of ids, or every finished run that
// matches a filter. A delete is permanent and never touches a live run
// (queued, running, waiting_human): the status is checked again inside the
// transaction that deletes.
//
// What goes with a run: its steps and its questions (foreign keys with ON
// DELETE CASCADE), the `lastRunId` of a schedule that pointed at it (a plain
// column, cleared here; so are the run and session ids of AI app activity rows, #465, and the run ids of saved approvals and their uses, #554) and the stored screenshots of its steps (removed after
// the commit). Its cost and stop reason go too, so task spend and the alert
// counts, which are computed from `runs`, drop accordingly.
import { createHash } from 'node:crypto';
import { ConflictException, Inject, Injectable, Logger, NotFoundException, Optional } from '@nestjs/common';
import { JobsService, registerJobReason } from '@marinoscar/platform-api/jobs';
import { Prisma } from '@prisma/client';

import { PrismaService } from '../prisma/prisma.service';
import { RunMetrics, type RunDeleteMode } from './run-metrics';
import { TERMINAL_RUN_STATUSES } from './run-status';
import { RUNS_DELETE_BATCH, RUNS_DELETE_SYNC_MAX, countChanged } from './run-delete.schemas';
import './runs.errors';
import { runWhere } from './runs.query';
import type { RunFilter } from './runs.schemas';

/** The job type of a large delete by filter. Permanent once jobs of this type exist: never rename it. */
export const RUNS_DELETE_JOB = 'browser.runs.delete';
/** Why the job was enqueued (a permanent id, shown in the admin job list). */
export const RUNS_DELETE_REASON = { id: 'runs_delete', label: 'Delete runs by filter' } as const;
registerJobReason(RUNS_DELETE_REASON);

/** The payload of `browser.runs.delete`. */
export interface RunsDeletePayload {
  userId: string;
  orgId: string | null;
  /** A parsed `RunFilter`; the job always adds the finished statuses and `createdAt <= requestedAt`. */
  filter: RunFilter;
  /** ISO 8601: runs created after this are never deleted by the job. */
  requestedAt: string;
}

/**
 * Where the screenshots of run steps live (`run_steps.screenshot_key`). Bound
 * to the storage slice's provider when that slice is enabled (tasks.module.ts);
 * absent otherwise, and then no object is touched.
 */
export const RUN_ARTIFACT_STORE = Symbol('RUN_ARTIFACT_STORE');
export interface RunArtifactStore {
  /** Store one object (a masked trace screenshot, #541). */
  put(key: string, bytes: Buffer, contentType: string): Promise<void>;
  /** Read one object back; null when it is not there. */
  get(key: string): Promise<{ bytes: Buffer; contentType: string } | null>;
  delete(key: string): Promise<void>;
}

/** What a delete did. */
export interface RunsDeleted {
  deleted: number;
  /** USD of the deleted runs; null when none of them made a model call. */
  costUsd: number | null;
  /** Runs left alone because they are live. */
  skippedLive: string[];
  /** Ids that are not the user's runs (by ids only). */
  notFound: string[];
}

/** A delete handed to the queue: more than `RUNS_DELETE_SYNC_MAX` runs matched. */
export interface RunsDeleteQueued {
  jobId: string;
  matched: number;
  costUsd: number | null;
}

export interface DeleteMatchingOptions {
  /** Only runs created at or before this: a job passes the time of the request, so later runs survive. */
  createdAtOrBefore?: Date;
  /** The metric and log label; `retention` for the nightly rule (#422). Default `filter`. */
  mode?: RunDeleteMode;
  /** The queue job doing the delete, for the log line and the audit record. */
  jobId?: string;
  orgId?: string | null;
}

const TERMINAL = [...TERMINAL_RUN_STATUSES];

/** Money summed over runs, and whether any of them made a model call. */
class Spend {
  private usd = new Prisma.Decimal(0);
  private calls = 0;

  add(costUsd: Prisma.Decimal | null | undefined, modelCalls: number | null | undefined): void {
    this.usd = this.usd.plus(costUsd ?? 0);
    this.calls += modelCalls ?? 0;
  }

  /** Null when no counted run made a model call (the same rule as `GET /runs/counts`). */
  get costUsd(): number | null {
    return this.calls > 0 ? Number(this.usd) : null;
  }
}

/** The filter keys a delete used (names only: a goal search is the user's text). */
function filterKeys(filter: RunFilter): string[] {
  return Object.entries(filter)
    .filter(([, v]) => v !== undefined)
    .map(([k]) => k)
    .sort();
}

/**
 * Deletes a user's runs. Every method is confined to `userId` through
 * `prisma.forUser()`: another user's run is "not found", never touched.
 *
 * For other features: `deleteMatching` (a filter, no size limit, runs to the
 * end: call it from a queue job) and `deleteByIds` (any number of ids).
 */
@Injectable()
export class RunDeleteService {
  private readonly log = new Logger(RunDeleteService.name);

  constructor(
    private readonly prisma: PrismaService,
    @Optional() private readonly metrics: RunMetrics = new RunMetrics(),
    @Optional() private readonly jobs?: JobsService,
    @Optional() @Inject(RUN_ARTIFACT_STORE) private readonly store?: RunArtifactStore,
  ) {}

  /** The WHERE of a delete by filter: the filter, narrowed to finished runs (and to `createdAtOrBefore`). */
  finishedWhere(filter: RunFilter, createdAtOrBefore?: Date): Prisma.RunWhereInput {
    return { AND: [runWhere(filter), { status: { in: TERMINAL } }, ...(createdAtOrBefore ? [{ createdAt: { lte: createdAtOrBefore } }] : [])] };
  }

  /** How many finished runs of the user match, and what they cost. */
  async countMatching(userId: string, filter: RunFilter, createdAtOrBefore?: Date): Promise<{ matched: number; costUsd: number | null }> {
    const sum = await this.prisma.forUser({ userId }).run.aggregate({ where: this.finishedWhere(filter, createdAtOrBefore), _count: { _all: true }, _sum: { costUsd: true, modelCalls: true } });
    const spend = new Spend();
    spend.add(sum._sum.costUsd, sum._sum.modelCalls);
    return { matched: sum._count._all, costUsd: spend.costUsd };
  }

  /** Delete one run. 404 `RUN_NOT_FOUND` when it is not the user's; 409 `RUN_LIVE` while it is live. */
  async deleteOne(userId: string, id: string, opts: { orgId?: string | null } = {}): Promise<void> {
    const started = Date.now();
    const db = this.prisma.forUser({ userId });
    const notFound = () => new NotFoundException({ code: 'RUN_NOT_FOUND', message: 'Run not found' });
    const live = () => new ConflictException({ code: 'RUN_LIVE', message: 'This run is still live. Cancel the run first' });
    const run = await db.run.findFirst({ where: { id }, select: { status: true } });
    if (!run) throw notFound();
    if (!TERMINAL.includes(run.status)) throw live();
    const batch = await this.deleteBatch(userId, [id]);
    if (batch.ids.length === 0) {
      // It changed between the check and the delete: gone, or live again.
      throw (await db.run.findFirst({ where: { id }, select: { id: true } })) ? live() : notFound();
    }
    await this.record({ userId, orgId: opts.orgId, mode: 'single', matched: 1, deleted: 1, skippedLive: 0, started });
  }

  /**
   * Delete the given runs (any number; 200 per transaction). Live runs are
   * skipped and reported, ids that are not the user's runs are reported as
   * not found: neither fails the call.
   */
  async deleteByIds(userId: string, ids: readonly string[], opts: { mode?: RunDeleteMode; orgId?: string | null; jobId?: string } = {}): Promise<RunsDeleted> {
    const started = Date.now();
    const wanted = [...new Set(ids.map((id) => id.toLowerCase()))];
    const spend = new Spend();
    const gone = new Set<string>();
    for (let at = 0; at < wanted.length; at += RUNS_DELETE_BATCH) {
      const batch = await this.deleteBatch(userId, wanted.slice(at, at + RUNS_DELETE_BATCH));
      for (const id of batch.ids) gone.add(id);
      spend.add(batch.costUsd, batch.modelCalls);
    }
    const rest = wanted.filter((id) => !gone.has(id));
    // What is left and still exists (for this user) is live; the others are not theirs, or not there.
    const still = new Set<string>();
    for (let at = 0; at < rest.length; at += RUNS_DELETE_BATCH) {
      const rows = await this.prisma.forUser({ userId }).run.findMany({ where: { id: { in: rest.slice(at, at + RUNS_DELETE_BATCH) } }, select: { id: true } });
      for (const r of rows) still.add(r.id);
    }
    const skippedLive = rest.filter((id) => still.has(id));
    const notFound = rest.filter((id) => !still.has(id));
    await this.record({ userId, orgId: opts.orgId, mode: opts.mode ?? 'ids', matched: wanted.length, deleted: gone.size, skippedLive: skippedLive.length, jobId: opts.jobId, started });
    return { deleted: gone.size, costUsd: spend.costUsd, skippedLive, notFound };
  }

  /**
   * `POST /runs/delete` with a filter. Deletes every finished run that matches,
   * in the request when at most `RUNS_DELETE_SYNC_MAX` match, else through the
   * `browser.runs.delete` job. With `expectedCount`, a count more than 5 % away
   * from it deletes nothing: 409 `COUNT_CHANGED` with the real count.
   */
  async deleteByFilter(userId: string, filter: RunFilter, opts: { expectedCount?: number; orgId?: string | null } = {}): Promise<RunsDeleted | RunsDeleteQueued> {
    const started = Date.now();
    const requestedAt = new Date();
    const { matched, costUsd } = await this.countMatching(userId, filter, requestedAt);
    if (opts.expectedCount !== undefined && countChanged(opts.expectedCount, matched)) {
      throw new ConflictException({
        code: 'COUNT_CHANGED',
        message: `${matched} finished runs match now, not ${opts.expectedCount}. Review the list and try again`,
        details: { matched, expectedCount: opts.expectedCount },
      });
    }
    if (matched <= RUNS_DELETE_SYNC_MAX) return this.deleteMatching(userId, filter, { createdAtOrBefore: requestedAt, mode: 'filter', orgId: opts.orgId });

    if (!this.jobs) throw new Error('RunDeleteService: a delete of this size needs the job queue');
    const orgId = opts.orgId ?? null;
    const payload: RunsDeletePayload = { userId, orgId, filter, requestedAt: requestedAt.toISOString() };
    // One job per user and filter: the same request sent twice is one job, a different filter is its own.
    const subject = `${userId}:${createHash('sha256').update(JSON.stringify(filterKeys(filter).map((k) => [k, filter[k as keyof RunFilter]]))).digest('hex').slice(0, 16)}`;
    const job = await this.jobs.enqueue({ type: RUNS_DELETE_JOB, reason: RUNS_DELETE_REASON.id, subjectType: 'runs_delete', subjectId: subject, orgId, payload: { ...payload } as unknown as Prisma.InputJsonObject });
    await this.record({ userId, orgId, mode: 'filter', matched, deleted: 0, skippedLive: 0, jobId: job.id, filter, queued: true, started });
    return { jobId: job.id, matched, costUsd };
  }

  /**
   * Delete every finished run of the user that matches the filter, 200 per
   * transaction, until none is left. No size limit: call it from a queue job
   * for anything that may be large (`browser.runs.delete`, retention). Safe to
   * repeat: a second pass finds only what the first did not delete.
   */
  async deleteMatching(userId: string, filter: RunFilter, opts: DeleteMatchingOptions = {}): Promise<RunsDeleted> {
    const started = Date.now();
    const where = this.finishedWhere(filter, opts.createdAtOrBefore);
    const db = this.prisma.forUser({ userId });
    const spend = new Spend();
    const skippedLive: string[] = [];
    let matched = 0;
    let deleted = 0;
    let after: string | undefined;
    for (;;) {
      // By id, past the last batch: a row that could not be deleted is never read twice.
      const rows = await db.run.findMany({ where: after ? { AND: [where, { id: { gt: after } }] } : where, orderBy: { id: 'asc' }, take: RUNS_DELETE_BATCH, select: { id: true } });
      if (rows.length === 0) break;
      const ids = rows.map((r) => r.id);
      after = ids.at(-1);
      matched += ids.length;
      const batch = await this.deleteBatch(userId, ids);
      deleted += batch.ids.length;
      spend.add(batch.costUsd, batch.modelCalls);
      if (batch.ids.length < ids.length) {
        const done = new Set(batch.ids);
        const left = await db.run.findMany({ where: { id: { in: ids.filter((id) => !done.has(id)) } }, select: { id: true } });
        skippedLive.push(...left.map((r) => r.id));
      }
    }
    await this.record({ userId, orgId: opts.orgId, mode: opts.mode ?? 'filter', matched, deleted, skippedLive: skippedLive.length, jobId: opts.jobId, filter, started });
    return { deleted, costUsd: spend.costUsd, skippedLive, notFound: [] };
  }

  /**
   * One transaction: the finished runs among `ids` are deleted, the schedules
   * that pointed at them forget them. Then, after the commit, the stored
   * screenshots of their steps are removed (a storage failure is logged and
   * does not undo the delete).
   */
  private async deleteBatch(userId: string, ids: string[]): Promise<{ ids: string[]; costUsd: Prisma.Decimal; modelCalls: number }> {
    const none = { ids: [] as string[], costUsd: new Prisma.Decimal(0), modelCalls: 0 };
    if (ids.length === 0) return none;
    // On the unscoped client, with the user in every WHERE: a scoped client refuses
    // `run_steps`, which has no owner column of its own (a step is reached through its run).
    const result = await this.prisma.$transaction(async (tx) => {
      const rows = await tx.run.findMany({ where: { id: { in: ids }, userId, status: { in: TERMINAL } }, select: { id: true, costUsd: true, modelCalls: true } });
      if (rows.length === 0) return { ...none, keys: [] as string[] };
      const found = rows.map((r) => r.id);
      const steps = await tx.runStep.findMany({ where: { runId: { in: found }, run: { userId }, screenshotKey: { not: null } }, select: { runId: true, screenshotKey: true } });
      // The status again: a run that is live by now survives.
      const { count } = await tx.run.deleteMany({ where: { id: { in: found }, userId, status: { in: TERMINAL } } });
      let gone = rows;
      if (count !== rows.length) {
        const left = new Set((await tx.run.findMany({ where: { id: { in: found }, userId }, select: { id: true } })).map((r) => r.id));
        gone = rows.filter((r) => !left.has(r.id));
      }
      const goneIds = gone.map((r) => r.id);
      const goneSet = new Set(goneIds);
      // `last_run_id` is a plain column, not a foreign key: forget the deleted runs.
      if (goneIds.length > 0) await tx.taskSchedule.updateMany({ where: { userId, lastRunId: { in: goneIds } }, data: { lastRunId: null } });
      // The AI app activity (#465) outlives the run (it is the audit trail): its pointers to the run are forgotten.
      if (goneIds.length > 0) {
        await tx.mcpActivity.updateMany({ where: { userId, runId: { in: goneIds } }, data: { runId: null } });
        await tx.mcpActivity.updateMany({ where: { userId, sessionId: { in: goneIds } }, data: { sessionId: null } });
        // Saved approvals (#554) outlive the run: the last use and the use history forget it.
        await tx.approvalRule.updateMany({ where: { userId, lastUsedRunId: { in: goneIds } }, data: { lastUsedRunId: null } });
        await tx.approvalRuleUse.updateMany({ where: { runId: { in: goneIds }, rule: { userId } }, data: { runId: null } });
      }
      return {
        ids: goneIds,
        costUsd: gone.reduce((sum, r) => sum.plus(r.costUsd), new Prisma.Decimal(0)),
        modelCalls: gone.reduce((n, r) => n + r.modelCalls, 0),
        keys: steps.flatMap((s) => (s.screenshotKey && goneSet.has(s.runId) ? [s.screenshotKey] : [])),
      };
    });
    await this.removeObjects(result.keys);
    return { ids: result.ids, costUsd: result.costUsd, modelCalls: result.modelCalls };
  }

  private async removeObjects(keys: string[]): Promise<void> {
    if (!this.store || keys.length === 0) return;
    let failed = 0;
    for (const key of new Set(keys)) {
      try {
        await this.store.delete(key);
      } catch {
        failed += 1;
      }
    }
    // Never the keys or the storage error text: a count is enough to look for orphans.
    if (failed > 0) this.log.warn(`runs.delete: ${failed} of ${keys.length} screenshot object(s) could not be removed from storage; the runs are deleted`);
  }

  /** The log line, the metric and the audit record of one call: counts and filter keys, never goal text or step content. */
  private async record(e: {
    userId: string;
    orgId?: string | null;
    mode: RunDeleteMode;
    matched: number;
    deleted: number;
    skippedLive: number;
    jobId?: string;
    filter?: RunFilter;
    /** The delete was handed to the queue: nothing is deleted yet. */
    queued?: boolean;
    started: number;
  }): Promise<void> {
    const ms = Date.now() - e.started;
    this.log.log(`runs.delete user=${e.userId} mode=${e.mode} matched=${e.matched} deleted=${e.deleted} skippedLive=${e.skippedLive} job=${e.jobId ?? 'none'} ms=${ms}`);
    this.metrics.deleted(e.mode, e.deleted);
    try {
      await this.prisma.auditEvent.create({
        data: {
          actorUserId: e.userId,
          action: e.queued ? 'runs.delete_queued' : 'runs.deleted',
          targetType: 'user',
          targetId: e.userId,
          orgId: e.orgId ?? null,
          meta: {
            mode: e.mode,
            matched: e.matched,
            deleted: e.deleted,
            skippedLive: e.skippedLive,
            jobId: e.jobId ?? null,
            filterKeys: e.filter ? filterKeys(e.filter).join(',') : null,
          },
        },
      });
    } catch (err) {
      this.log.warn(`runs.delete: the audit record could not be written: ${err instanceof Error ? err.name : 'error'}`);
    }
  }
}

