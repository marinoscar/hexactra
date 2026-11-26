import { BadRequestException, ConflictException, Injectable, Logger, NotFoundException, Optional, type OnModuleDestroy, type OnModuleInit } from '@nestjs/common';
import { SystemSettingsService } from '@marinoscar/platform-api/settings';
import { Prisma, type RunBatch, type RunOrigin, type RunTrigger, type Task } from '@prisma/client';

import { PrismaService } from '../prisma/prisma.service';
import { TaskRunStarter, type StartActor } from '../questions/task-run-starter';
import { maskSensitive } from './mask';
import { RunEndHooks } from './run-end-hooks';
import { RunMetrics } from './run-metrics';
import { DEFAULT_BATCH_MAX_ROWS } from './run-retention.schemas';
import { TERMINAL_RUN_STATUSES } from './run-status';
import { LIVE_RUN_STATUSES } from './runs.schemas';
import { readParameters } from './task-params.schemas';
import { TasksService } from './tasks.service';
import './runs.settings';
import './runs.errors';

/** A batch's states (E51.1, #1006). `review`: a chat's batch waits for the owner's Start. */
export const BATCH_STATUSES = ['review', 'running', 'done', 'cancelled'] as const;
export type BatchStatus = (typeof BATCH_STATUSES)[number];
/** A batch that is not over: it blocks a second batch of its task, and a chat's other runs. */
export const LIVE_BATCH_STATUSES = ['review', 'running'] as const satisfies readonly BatchStatus[];
export const BATCH_ITEM_STATUSES = ['pending', 'running', 'succeeded', 'failed', 'cancelled', 'skipped'] as const;
export type BatchItemStatus = (typeof BATCH_ITEM_STATUSES)[number];
export type BatchOnFailure = 'continue' | 'stop';
/** Why a batch stopped before its last row. */
export type BatchStopReason = 'owner_stopped' | 'unknown_outcome' | 'row_failed' | 'task_deleted';

/** A claimed row whose run was never created (the API died between the two writes) goes back to `pending` after this long. */
export const BATCH_CLAIM_GRACE_MS = 2 * 60_000;
/** The first characters of each run's result a batch view carries. */
const RESULT_PREVIEW = 300;

/** One row as the caller sends it: values by parameter key or display name. */
export interface BatchRowInput {
  inputs?: Record<string, string | number> | null;
}

export interface CreateBatchOptions {
  /** A chat's batch waits for the owner's Start (`review`); every other caller wrote the rows itself and it starts at once. */
  review?: boolean;
  onFailure?: BatchOnFailure;
  trigger: RunTrigger;
  origin: RunOrigin;
  conversationId?: string | null;
  policyRef?: string | null;
  client?: { clientId?: string | null; clientName?: string | null; grantId?: string | null };
  appLimits?: Prisma.InputJsonValue | null;
  timeZone?: string | null;
}

/** A row problem, named so the caller can fix that row (1-based). */
export interface BatchRowIssue {
  row: number;
  code?: string;
  message?: string;
  missing?: string[];
  issues?: unknown;
  rows?: number[];
}

type Db = ReturnType<PrismaService['forUser']>;
/** Called once when a batch ends. */
export type BatchEndHook = (userId: string, batchId: string) => Promise<void>;

/**
 * Batch runs (E51.1, #1006): a saved task run once per row of values, one run after another. A batch is ordinary runs: each row is
 * started by `TaskRunStarter.start` (the one path that starts a task's run) with its own inputs, steps, budgets, gates and audit
 * trail. The batch only decides WHEN the next row starts: when the previous row's run ended (`RunEndHooks`). Every row is checked
 * before anything is written; a row is claimed with a compare-and-set on its status, so two end hooks never start two runs, and a row
 * is never started twice. The owner's Stop on a batch run (anywhere) stops the batch; so does a run that ended with a commit-class
 * step of unknown outcome, and, with `onFailure: stop`, a failed run. A batch error is logged and counted and never changes a run.
 */
@Injectable()
export class RunBatchService implements OnModuleInit, OnModuleDestroy {
  private readonly log = new Logger(RunBatchService.name);
  private unregister?: () => void;
  private readonly endHooks = new Set<BatchEndHook>();

  constructor(
    private readonly prisma: PrismaService,
    private readonly starter: TaskRunStarter,
    private readonly tasks: TasksService,
    private readonly hooks: RunEndHooks,
    @Optional() private readonly metrics?: RunMetrics,
    @Optional() private readonly systemSettings?: SystemSettingsService,
  ) {}

  onModuleInit(): void {
    this.unregister = this.hooks.register((userId, runId) => this.onRunEnd(userId, runId));
  }

  onModuleDestroy(): void {
    this.unregister?.();
  }

  /** Called once when a batch ends (done or stopped), after the write: the chat writes its one summary message. Returns the remover. */
  onBatchEnd(hook: BatchEndHook): () => void {
    this.endHooks.add(hook);
    return () => void this.endHooks.delete(hook);
  }

  private async fireEnd(userId: string, batchId: string): Promise<void> {
    for (const hook of [...this.endHooks]) {
      try {
        await hook(userId, batchId);
      } catch (e) {
        this.log.warn(`batch ${batchId}: an end hook failed: ${e instanceof Error ? e.message : String(e)}`);
      }
    }
  }

  private db(userId: string): Db {
    return this.prisma.forUser({ userId });
  }

  /** `runs.batchMaxRows` of the system settings (default 25). */
  async maxRows(): Promise<number> {
    try {
      const v = (await this.systemSettings?.getNamespace('runs'))?.batchMaxRows;
      return typeof v === 'number' ? v : DEFAULT_BATCH_MAX_ROWS;
    } catch {
      return DEFAULT_BATCH_MAX_ROWS;
    }
  }

  /**
   * Check every row (nothing is written): the checked values by key, per row. 400 `BATCH_TOO_SMALL`, `BATCH_TOO_LARGE`,
   * `BATCH_SENSITIVE_PARAMETER`, `INVALID_INPUT` / `BATCH_INPUTS_MISSING` / `BATCH_DUPLICATE_ROW` with `details.rows`.
   */
  async checkRows(userId: string, task: Task, rows: readonly BatchRowInput[], timeZone?: string | null): Promise<Record<string, string>[]> {
    const max = await this.maxRows();
    if (rows.length < 2) throw new BadRequestException({ code: 'BATCH_TOO_SMALL', message: 'A batch has at least 2 rows. For one row, start a run of the task.' });
    if (rows.length > max) throw new BadRequestException({ code: 'BATCH_TOO_LARGE', message: `A batch has at most ${max} rows.`, details: { max } });
    const params = readParameters(task.parameters);
    const sensitive = params.filter((p) => p.sensitive);
    if (sensitive.length) {
      throw new BadRequestException({ code: 'BATCH_SENSITIVE_PARAMETER', message: `This task has a value asked for securely (${sensitive.map((p) => p.label).join(', ')}): it cannot run as a batch in this version.` });
    }
    const invalid: BatchRowIssue[] = [];
    const missing: BatchRowIssue[] = [];
    const checked: Record<string, string>[] = [];
    const resolved: string[] = [];
    for (const [i, row] of rows.entries()) {
      try {
        const r = await this.starter.resolveRow(userId, task, row.inputs ?? {}, timeZone);
        checked.push(r.given);
        resolved.push(r.fingerprint);
        if (r.missing.length) missing.push({ row: i + 1, missing: r.missing });
      } catch (e) {
        if (!(e instanceof BadRequestException)) throw e;
        const body = e.getResponse() as { code?: string; message?: string; details?: { issues?: unknown; unknown?: unknown } };
        invalid.push({ row: i + 1, code: body.code ?? 'INVALID_INPUT', message: String(body.message ?? 'Invalid values'), ...(body.details?.issues ? { issues: body.details.issues } : {}) });
        checked.push({});
        resolved.push(`invalid:${i}`);
      }
    }
    if (invalid.length) throw new BadRequestException({ code: 'INVALID_INPUT', message: invalid.map((r) => `Row ${r.row}: ${r.message}`).join('; ').slice(0, 2000), details: { rows: invalid } });
    if (missing.length) {
      throw new BadRequestException({ code: 'BATCH_INPUTS_MISSING', message: missing.map((r) => `Row ${r.row} needs ${r.missing!.join(', ')}`).join('; ').slice(0, 2000), details: { rows: missing } });
    }
    const seen = new Map<string, number>();
    const dups: BatchRowIssue[] = [];
    resolved.forEach((f, i) => {
      const first = seen.get(f);
      if (first !== undefined) dups.push({ row: i + 1, rows: [first, i + 1] });
      else seen.set(f, i + 1);
    });
    if (dups.length) {
      throw new BadRequestException({ code: 'BATCH_DUPLICATE_ROW', message: dups.map((d) => `Rows ${d.rows![0]} and ${d.rows![1]} have the same values`).join('; '), details: { rows: dups } });
    }
    return checked;
  }

  /** 409 `BATCH_LIVE`: a live batch of the task, or (in a chat) a live run or batch of the chat. */
  private async assertNotLive(userId: string, taskId: string, conversationId: string | null | undefined): Promise<void> {
    const db = this.db(userId);
    const sameTask = await db.runBatch.findFirst({ where: { taskId, status: { in: [...LIVE_BATCH_STATUSES] } }, select: { id: true } });
    if (sameTask) throw new ConflictException({ code: 'BATCH_LIVE', message: 'A batch of this task is still live. Wait for it to end or cancel it.', details: { batchId: sameTask.id } });
    if (!conversationId) return;
    const chatBatch = await db.runBatch.findFirst({ where: { conversationId, status: { in: [...LIVE_BATCH_STATUSES] } }, select: { id: true } });
    const chatRun = await db.run.findFirst({ where: { conversationId, status: { in: [...LIVE_RUN_STATUSES] } }, select: { id: true } });
    if (chatBatch || chatRun) throw new ConflictException({ code: 'BATCH_LIVE', message: 'A run of this chat is still live.' });
  }

  /** Create a batch: every row checked first; `review` waits for the owner's Start, otherwise row 1 starts now. */
  async create(actor: StartActor, task: Task, rows: readonly BatchRowInput[], opts: CreateBatchOptions) {
    const userId = actor.id;
    const checked = await this.checkRows(userId, task, rows, opts.timeZone);
    await this.assertNotLive(userId, task.id, opts.conversationId);
    const now = new Date();
    const batch = await this.db(userId).runBatch.create({
      data: {
        userId,
        taskId: task.id,
        conversationId: opts.conversationId ?? null,
        trigger: opts.trigger,
        origin: opts.origin,
        policyRef: opts.policyRef ?? null,
        clientId: opts.client?.clientId ?? null,
        clientName: opts.client?.clientName ?? null,
        grantId: opts.client?.grantId ?? null,
        ...(opts.appLimits ? { appLimits: opts.appLimits } : {}),
        status: opts.review ? 'review' : 'running',
        total: checked.length,
        onFailure: opts.onFailure ?? 'continue',
        ...(opts.review ? {} : { startedAt: now }),
        items: { create: checked.map((inputs, i) => ({ seq: i + 1, inputs: inputs as Prisma.InputJsonValue })) },
      },
    });
    this.log.log(`batch ${batch.id}: ${checked.length} rows of task ${task.id} (${batch.status})`);
    if (!opts.review) await this.startNext(actor, batch.id);
    return this.get(userId, batch.id);
  }

  /** Start a batch in `review` (the owner's Start): `rows` are the rows to keep (1-based seqs, default all); the others are skipped. */
  async start(actor: StartActor, batchId: string, rows?: readonly number[]) {
    const db = this.db(actor.id);
    const batch = await db.runBatch.findFirst({ where: { id: batchId }, include: { items: { select: { seq: true } } } });
    if (!batch) throw new NotFoundException({ code: 'BATCH_NOT_FOUND', message: 'Batch not found' });
    if (batch.status !== 'review') throw new ConflictException({ code: 'BATCH_NOT_IN_REVIEW', message: `The batch is ${batch.status}: only a batch waiting for review can be started.` });
    const all = batch.items.map((i) => i.seq);
    const keep = rows === undefined ? all : [...new Set(rows)];
    if (keep.length === 0) throw new BadRequestException({ code: 'BATCH_NO_ROWS', message: 'Keep at least one row.' });
    const unknown = keep.filter((s) => !all.includes(s));
    if (unknown.length) throw new BadRequestException({ code: 'BATCH_UNKNOWN_ROW', message: `Not a row of this batch: ${unknown.join(', ')}` });
    // Compare-and-set: two presses of Start start it once.
    const { count } = await db.runBatch.updateMany({ where: { id: batchId, status: 'review' }, data: { status: 'running', startedAt: new Date() } });
    if (count === 0) throw new ConflictException({ code: 'BATCH_NOT_IN_REVIEW', message: 'The batch was already started or cancelled.' });
    const skip = all.filter((s) => !keep.includes(s));
    if (skip.length) await this.prisma.runBatchItem.updateMany({ where: { batchId, seq: { in: skip }, status: 'pending' }, data: { status: 'skipped' } });
    await this.startNext(actor, batchId);
    return this.get(actor.id, batchId);
  }

  /** Cancel a batch: a batch in review starts nothing; a running one cancels its live run through the existing cancel path. */
  async cancel(userId: string, batchId: string) {
    const db = this.db(userId);
    const batch = await db.runBatch.findFirst({ where: { id: batchId } });
    if (!batch) throw new NotFoundException({ code: 'BATCH_NOT_FOUND', message: 'Batch not found' });
    if (batch.status === 'review' || batch.status === 'running') {
      await this.stop(batch, 'owner_stopped', null);
      const live = await this.prisma.runBatchItem.findFirst({ where: { batchId, status: 'running', runId: { not: null } }, select: { runId: true } });
      if (live?.runId) await this.tasks.cancel(userId, live.runId).catch((e: unknown) => this.log.warn(`batch ${batchId}: could not cancel run ${live.runId}: ${e instanceof Error ? e.message : String(e)}`));
    }
    return this.get(userId, batchId);
  }

  /** End the batch early: `cancelled` with the reason, every `pending` row `skipped`. Once (compare-and-set). */
  private async stop(batch: Pick<RunBatch, 'id' | 'userId' | 'conversationId'>, reason: BatchStopReason, seq: number | null): Promise<boolean> {
    const { count } = await this.db(batch.userId).runBatch.updateMany({
      where: { id: batch.id, status: { in: [...LIVE_BATCH_STATUSES] } },
      data: { status: 'cancelled', stopReason: reason, stoppedAtSeq: seq, finishedAt: new Date() },
    });
    await this.prisma.runBatchItem.updateMany({ where: { batchId: batch.id, status: 'pending' }, data: { status: 'skipped' } });
    if (count > 0) {
      this.log.log(`batch ${batch.id}: stopped (${reason}${seq ? `, row ${seq}` : ''})`);
      await this.fireEnd(batch.userId, batch.id);
    }
    return count > 0;
  }

  /**
   * Start the lowest `pending` row, unless a row is running or the batch is not `running`. The row is claimed with a compare-and-set
   * on its status (pending → running) before its run is created, so two callers never start two runs and a row is never started twice.
   */
  async startNext(actor: StartActor, batchId: string): Promise<void> {
    const userId = actor.id;
    const db = this.db(userId);
    for (let guard = 0; guard < 200; guard++) {
      const batch = await db.runBatch.findFirst({ where: { id: batchId } });
      if (!batch || batch.status !== 'running') return;
      // The claim, under the batch row's lock: no row running, the lowest pending one becomes running. Two callers queue up here,
      // so the second finds a row running and starts nothing (a row lock, not only a compare-and-set on the item).
      const claim = await this.prisma.$transaction(async (tx) => {
        const locked = await tx.$queryRaw<{ status: string }[]>`SELECT status FROM run_batches WHERE id = ${batchId}::uuid FOR UPDATE`;
        if (locked[0]?.status !== 'running') return 'busy' as const;
        if (await tx.runBatchItem.findFirst({ where: { batchId, status: 'running' }, select: { id: true } })) return 'busy' as const;
        const pending = await tx.runBatchItem.findFirst({ where: { batchId, status: 'pending' }, orderBy: { seq: 'asc' } });
        if (!pending) return 'none' as const;
        await tx.runBatchItem.update({ where: { id: pending.id }, data: { status: 'running', startedAt: new Date() } });
        return pending;
      });
      if (claim === 'busy') return;
      if (claim === 'none') {
        const { count } = await db.runBatch.updateMany({ where: { id: batchId, status: 'running' }, data: { status: 'done', finishedAt: new Date() } });
        if (count > 0) {
          this.log.log(`batch ${batchId}: done`);
          await this.fireEnd(userId, batchId);
        }
        return;
      }
      const next = claim;
      const task = await db.task.findFirst({ where: { id: batch.taskId } });
      if (!task) {
        await this.prisma.runBatchItem.updateMany({ where: { id: next.id }, data: { status: 'skipped' } });
        await this.stop(batch, 'task_deleted', next.seq);
        return;
      }
      try {
        const { run } = await this.starter.start(actor, task, {
          inputs: (next.inputs ?? {}) as Record<string, string>,
          reason: 'run_started',
          data: {
            trigger: batch.trigger,
            origin: batch.origin,
            ...(batch.conversationId ? { conversationId: batch.conversationId } : {}),
            ...(batch.policyRef ? { policyRef: batch.policyRef, policySource: 'run' as const } : {}),
            ...(batch.clientId || batch.clientName ? { clientId: batch.clientId, clientName: batch.clientName, grantId: batch.grantId } : {}),
            ...(batch.appLimits ? { appLimits: batch.appLimits as Prisma.InputJsonValue } : {}),
            batchId,
            batchSeq: next.seq,
          },
        });
        await this.prisma.runBatchItem.updateMany({ where: { id: next.id }, data: { runId: run.id } });
        // Stopped while this row was being started (a Stop that found no run yet): this run is cancelled too, before it acts.
        if ((await db.runBatch.findFirst({ where: { id: batchId }, select: { status: true } }))?.status !== 'running') {
          await this.tasks.cancel(userId, run.id).catch(() => undefined);
          return;
        }
        this.log.log(`batch ${batchId}: row ${next.seq} started as run ${run.id}`);
        return;
      } catch (e) {
        // The task changed since the batch was checked (a value is no longer valid): this row fails, the batch goes on (or stops).
        this.metrics?.batchError('start_next');
        this.log.warn(`batch ${batchId}: row ${next.seq} could not start: ${e instanceof Error ? e.message : String(e)}`);
        await this.prisma.runBatchItem.updateMany({ where: { id: next.id, status: 'running' }, data: { status: 'failed' } });
        if (batch.onFailure === 'stop') {
          await this.stop(batch, 'row_failed', next.seq);
          return;
        }
      }
    }
  }

  /** A run ended (RunEndHooks): record its row's status, then stop the batch, start the next row, or end it. No-op outside a batch. */
  async onRunEnd(userId: string, runId: string): Promise<void> {
    try {
      const run = await this.db(userId).run.findFirst({
        where: { id: runId, batchId: { not: null }, status: { in: [...TERMINAL_RUN_STATUSES] } },
        select: { id: true, status: true, batchId: true, batchSeq: true, cancelRequestedAt: true, userId: true },
      });
      if (!run?.batchId || run.batchSeq === null) return;
      const batch = await this.db(userId).runBatch.findFirst({ where: { id: run.batchId } });
      if (!batch) return;
      const status = run.status as BatchItemStatus;
      await this.prisma.runBatchItem.updateMany({ where: { batchId: batch.id, seq: run.batchSeq, status: { in: ['pending', 'running'] } }, data: { status, runId: run.id } });
      if (batch.status !== 'running') return;
      // The owner's Stop, from anywhere (the chat, the run page, the API, the CLI, a notification): it set `cancel_requested_at`.
      if (run.status === 'cancelled' && run.cancelRequestedAt) {
        await this.stop(batch, 'owner_stopped', run.batchSeq);
        return;
      }
      // A commit-class step of unknown outcome (docs/runs.md, "Crash safety"): it may have happened, so the batch never goes on by itself.
      const unknown = await this.prisma.runStep.count({ where: { runId: run.id, phase: { in: ['unknown', 'intent'] } } });
      if (unknown > 0) {
        await this.stop(batch, 'unknown_outcome', run.batchSeq);
        return;
      }
      if (run.status === 'failed' && batch.onFailure === 'stop') {
        await this.stop(batch, 'row_failed', run.batchSeq);
        return;
      }
      await this.startNext({ id: userId }, batch.id);
    } catch (e) {
      this.metrics?.batchError('run_end');
      this.log.warn(`run ${runId}: the batch could not go on: ${e instanceof Error ? e.message : String(e)}`);
    }
  }

  /**
   * After a restart (the reconcile sweep): a `running` batch with no live row starts its next one; a row whose run ended without the
   * hook is recorded; a row claimed whose run was never created goes back to `pending`. Returns how many batches it moved on.
   */
  async reconcile(now = new Date()): Promise<number> {
    let moved = 0;
    const batches = await this.prisma.runBatch.findMany({ where: { status: 'running' }, select: { id: true, userId: true }, take: 200, orderBy: { createdAt: 'asc' } });
    for (const b of batches) {
      try {
        const running = await this.prisma.runBatchItem.findFirst({ where: { batchId: b.id, status: 'running' } });
        if (running) {
          const run = await this.prisma.run.findFirst({ where: { batchId: b.id, batchSeq: running.seq }, select: { id: true, status: true } });
          if (run && (TERMINAL_RUN_STATUSES as readonly string[]).includes(run.status)) {
            await this.onRunEnd(b.userId, run.id);
            moved += 1;
          } else if (!run && running.startedAt && now.getTime() - running.startedAt.getTime() > BATCH_CLAIM_GRACE_MS) {
            // Claimed, never created: no run exists for this row, so starting it is not a repeat.
            await this.prisma.runBatchItem.updateMany({ where: { id: running.id, status: 'running', runId: null }, data: { status: 'pending', startedAt: null } });
            await this.startNext({ id: b.userId }, b.id);
            moved += 1;
          }
          continue;
        }
        await this.startNext({ id: b.userId }, b.id);
        moved += 1;
      } catch (e) {
        this.metrics?.batchError('reconcile');
        this.log.warn(`batch ${b.id}: reconcile failed: ${e instanceof Error ? e.message : String(e)}`);
      }
    }
    return moved;
  }

  /** Whether any batch is running (the sweep's cron asks before it enqueues the job). */
  async anyRunning(): Promise<boolean> {
    return (await this.prisma.runBatch.count({ where: { status: 'running' } })) > 0;
  }

  /** A batch with its rows: the values masked, each run's status and the first 300 characters of its result. */
  async get(userId: string, batchId: string) {
    const db = this.db(userId);
    const batch = await db.runBatch.findFirst({ where: { id: batchId }, include: { items: { orderBy: { seq: 'asc' } }, task: { select: { id: true, name: true, parameters: true } } } });
    if (!batch) throw new NotFoundException({ code: 'BATCH_NOT_FOUND', message: 'Batch not found' });
    const runIds = batch.items.map((i) => i.runId).filter((x): x is string => !!x);
    const runs = runIds.length ? await db.run.findMany({ where: { id: { in: runIds } }, select: { id: true, status: true, result: true, error: true } }) : [];
    return batchView(batch, runs);
  }

  /** A task's batches, newest first, keyset paging on (createdAt, id). */
  async listForTask(userId: string, taskId: string, opts: { limit?: number; cursor?: string | null } = {}) {
    await this.tasks.getTask(userId, taskId);
    const limit = Math.min(Math.max(opts.limit ?? 20, 1), 100);
    const db = this.db(userId);
    const after = opts.cursor ? await db.runBatch.findFirst({ where: { id: opts.cursor, taskId }, select: { id: true, createdAt: true } }) : null;
    const rows = await db.runBatch.findMany({
      where: { taskId, ...(after ? { OR: [{ createdAt: { lt: after.createdAt } }, { createdAt: after.createdAt, id: { lt: after.id } }] } : {}) },
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      take: limit + 1,
      include: { items: { orderBy: { seq: 'asc' } }, task: { select: { id: true, name: true, parameters: true } } },
    });
    const page = rows.slice(0, limit);
    const runIds = page.flatMap((b) => b.items.map((i) => i.runId)).filter((x): x is string => !!x);
    const runs = runIds.length ? await db.run.findMany({ where: { id: { in: runIds } }, select: { id: true, status: true, result: true, error: true } }) : [];
    return { items: page.map((b) => batchView(b, runs)), nextCursor: rows.length > limit ? page.at(-1)!.id : null };
  }
}

type BatchWithItems = RunBatch & { items: { seq: number; inputs: unknown; status: string; runId: string | null }[]; task: { id: string; name: string; parameters: unknown } | null };

/** The counts of a batch's rows, and the one-line summary ("3 of 3 done", "2 done, 1 failed, 2 not started"). */
export function batchCounts(items: readonly { status: string }[]) {
  const n = (s: string) => items.filter((i) => i.status === s).length;
  const counts = { total: items.length, succeeded: n('succeeded'), failed: n('failed'), cancelled: n('cancelled'), skipped: n('skipped'), pending: n('pending'), running: n('running') };
  const parts: string[] = [];
  if (counts.succeeded === counts.total) return { counts, summary: `${counts.total} of ${counts.total} done` };
  if (counts.succeeded) parts.push(`${counts.succeeded} done`);
  if (counts.failed) parts.push(`${counts.failed} failed`);
  if (counts.cancelled) parts.push(`${counts.cancelled} stopped`);
  if (counts.running) parts.push(`${counts.running} running`);
  if (counts.skipped + counts.pending) parts.push(`${counts.skipped + counts.pending} not started`);
  return { counts, summary: parts.join(', ') || 'Nothing ran' };
}

/** The batch as every client reads it: row values masked with `maskSensitive`, never a sensitive one (a batch has none). */
export function batchView(b: BatchWithItems, runs: readonly { id: string; status: string; result: string | null; error: string | null }[]) {
  const byId = new Map(runs.map((r) => [r.id, r]));
  const params = readParameters(b.task?.parameters ?? null);
  const labels = new Map(params.map((p) => [p.key, p.label]));
  const order = (k: string) => {
    const i = params.findIndex((p) => p.key === k);
    return i < 0 ? params.length : i;
  };
  const { counts, summary } = batchCounts(b.items);
  return {
    id: b.id,
    taskId: b.taskId,
    taskName: b.task?.name ?? null,
    conversationId: b.conversationId,
    trigger: b.trigger,
    origin: b.origin,
    policyRef: b.policyRef,
    status: b.status as BatchStatus,
    total: b.total,
    onFailure: b.onFailure as BatchOnFailure,
    stopReason: b.stopReason as BatchStopReason | null,
    stoppedAtSeq: b.stoppedAtSeq,
    createdAt: b.createdAt,
    startedAt: b.startedAt,
    finishedAt: b.finishedAt,
    counts,
    summary,
    items: b.items.map((i) => {
      const run = i.runId ? byId.get(i.runId) : undefined;
      const values = Object.entries((i.inputs ?? {}) as Record<string, string>)
        .sort(([a], [b2]) => order(a) - order(b2))
        .map(([key, value]) => ({ key, label: labels.get(key) ?? key, value: maskSensitive(String(value)).text }));
      return {
        seq: i.seq,
        status: i.status as BatchItemStatus,
        runId: i.runId,
        values,
        runStatus: run?.status ?? null,
        result: run ? maskSensitive((run.result ?? run.error ?? '').slice(0, RESULT_PREVIEW)).text : null,
      };
    }),
  };
}
export type BatchView = ReturnType<typeof batchView>;
