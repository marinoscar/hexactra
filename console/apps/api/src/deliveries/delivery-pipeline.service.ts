// The pipeline (E39.6, #603): a run ends, its deliveries are queued, a job sends each once.
//
//   1. `onRunEnd` (a `RunEndHooks` hook): for a run with a task, one `RunDelivery` (`pending`) per enabled delivery whose `when` matches
//      (and that the starting schedule includes), and one `deliveries.send` job per row. Runs without a task have none.
//   2. `attempt` (the job): claims the row (`pending` -> `sending`, one job at a time), builds the run's facts, hands them to the kind's
//      sender and records the outcome. A row that is already `sent` or `skipped` does nothing: a job that runs twice sends once.
//   3. A retryable failure (rate limit, provider error, network) is retried up to 5 times with backoff; any other failure ends at once with
//      its code, and the owner is told once per task per day. A delivery's failure never changes the run's status.
//
// Idempotency: the row's `(runId, deliveryId)` is unique, the claim is compare-and-set, every send carries the stable key
// `run:<runId>:delivery:<deliveryId>`, and each sender checks for its own earlier work before it repeats a write that could duplicate.
import { ConflictException, Injectable, Logger, NotFoundException, type OnModuleDestroy, type OnModuleInit } from '@nestjs/common';
import { JobsService } from '@marinoscar/platform-api/jobs';
import { Prisma, type RunDelivery, type TaskDelivery } from '@prisma/client';

import { PrismaService } from '../prisma/prisma.service';
import { RunEndHooks } from '../tasks/run-end-hooks';
import { TERMINAL_RUN_STATUSES } from '../tasks/run-status';
import {
  DELIVERY_AUDIT,
  DELIVERY_BACKOFF_MS,
  DELIVERY_ERROR_TEXT,
  DELIVERY_MAX_ATTEMPTS,
  STALE_SENDING_MS,
  isDeliveryErrorCode,
  isDeliveryKind,
  type DeliveryErrorCode,
  type DeliveryKind,
  type DeliveryWhen,
} from './deliveries.constants';
import { DeliveryEvents } from './deliveries.events';
import { DeliveryMaterialCache } from './delivery-material.cache';
import { factsOf, whenMatches, type RunFacts, type RunRow } from './delivery-facts';
import { sampleFacts } from './delivery-sample';
import { enqueueDeliverySend } from './delivery-send.enqueue';
import { DeliveryFailure, failureFrom, type DeliverySender, type SendContext, type SendOutcome } from './delivery-sender';
import { CONFIG_SCHEMAS } from './delivery.schemas';
import { readOutputs } from '../tasks/task-outputs.schemas';
import { EmailSender } from './senders/email.sender';
import { FolderSender } from './senders/folder.sender';
import { SheetRowSender } from './senders/sheet-row.sender';
import { WebhookSender } from './senders/webhook.sender';

/** What the owner reads about one delivery of one run. */
export interface RunDeliveryView {
  id: string;
  runId: string;
  deliveryId: string | null;
  kind: DeliveryKind;
  status: string;
  attempts: number;
  errorCode: DeliveryErrorCode | null;
  errorText: string | null;
  detail: Record<string, unknown>;
  sentAt: string | null;
  nextAttemptAt: string | null;
  createdAt: string;
}

export function runDeliveryView(r: RunDelivery): RunDeliveryView {
  const detail = r.detail && typeof r.detail === 'object' && !Array.isArray(r.detail) ? { ...(r.detail as Record<string, unknown>) } : {};
  // Progress markers are the pipeline's own bookkeeping, not facts for the owner.
  delete detail.done;
  delete detail.budgetBase;
  delete detail.appendAmbiguous;
  const code = isDeliveryErrorCode(r.errorCode) ? r.errorCode : null;
  return {
    id: r.id,
    runId: r.runId,
    deliveryId: r.deliveryId,
    kind: r.kind as DeliveryKind,
    status: r.status,
    attempts: r.attempts,
    errorCode: code,
    errorText: code ? DELIVERY_ERROR_TEXT[code] : null,
    detail,
    sentAt: r.sentAt?.toISOString() ?? null,
    nextAttemptAt: r.nextAttemptAt?.toISOString() ?? null,
    createdAt: r.createdAt.toISOString(),
  };
}

/** The wait before attempt `attempt + 1`: the schedule, or the provider's `Retry-After` when that is longer. */
export function backoffMs(attempt: number, retryAfterMs?: number): number {
  const base = DELIVERY_BACKOFF_MS[Math.min(Math.max(attempt, 1), DELIVERY_BACKOFF_MS.length) - 1]!;
  return Math.max(base, Math.min(retryAfterMs ?? 0, 60 * 60_000));
}

const asObject = (v: unknown): Record<string, unknown> => (v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : {});
const DAY_MS = 24 * 60 * 60_000;

@Injectable()
export class DeliveryPipeline implements OnModuleInit, OnModuleDestroy {
  private readonly log = new Logger(DeliveryPipeline.name);
  private unregister?: () => void;
  private readonly senders: Map<DeliveryKind, DeliverySender>;
  clock: () => number = () => Date.now();

  constructor(
    private readonly prisma: PrismaService,
    private readonly jobs: JobsService,
    private readonly hooks: RunEndHooks,
    private readonly events: DeliveryEvents,
    private readonly material: DeliveryMaterialCache,
    email: EmailSender,
    webhook: WebhookSender,
    sheet: SheetRowSender,
    folder: FolderSender,
  ) {
    this.senders = new Map<DeliveryKind, DeliverySender>([
      ['email', email],
      ['webhook', webhook],
      ['sheet_row', sheet],
      ['folder', folder],
    ]);
  }

  onModuleInit(): void {
    this.unregister = this.hooks.register(async (userId, runId) => void (await this.onRunEnd(userId, runId)));
  }

  onModuleDestroy(): void {
    this.unregister?.();
  }

  // ----- 1. a run ended ----------------------------------------------------------------------------------------------

  private async loadRun(userId: string, runId: string): Promise<(RunRow & { taskId: string | null }) | null> {
    return (await this.prisma.forUser({ userId }).run.findFirst({
      where: { id: runId },
      select: {
        id: true, userId: true, taskId: true, goal: true, trigger: true, status: true, result: true, error: true, createdAt: true, finishedAt: true, costUsd: true, costKnown: true,
        stepCount: true, confirmedActions: true, outputs: true, outputsSpec: true, outputsComplete: true, task: { select: { name: true } },
      },
    })) as (RunRow & { taskId: string | null }) | null;
  }

  /** Creates the run's delivery rows and queues a job for each. Idempotent: a second call for the same run adds nothing. */
  async onRunEnd(userId: string, runId: string): Promise<number> {
    const run = await this.loadRun(userId, runId);
    if (!run?.taskId || !(TERMINAL_RUN_STATUSES as readonly string[]).includes(run.status)) return 0;
    const db = this.prisma.forUser({ userId });
    const deliveries = await db.taskDelivery.findMany({ where: { taskId: run.taskId, enabled: true }, orderBy: [{ position: 'asc' }, { createdAt: 'asc' }] });
    if (deliveries.length === 0) return 0;

    // A schedule may choose which of the task's deliveries its runs use (null: all of them).
    const schedule = run.trigger === 'schedule' ? await db.taskSchedule.findFirst({ where: { lastRunId: runId }, select: { id: true, deliveryIds: true } }) : null;
    const only = Array.isArray(schedule?.deliveryIds) ? new Set((schedule!.deliveryIds as unknown[]).filter((x): x is string => typeof x === 'string')) : null;
    const facts = factsOf(run, schedule?.id ?? null);

    let queued = 0;
    for (const d of deliveries) {
      if (only && !only.has(d.id)) continue;
      if (!isDeliveryKind(d.kind) || !whenMatches(d.when as DeliveryWhen, facts)) continue;
      try {
        const row = await this.prisma.runDelivery.create({ data: { userId, runId, deliveryId: d.id, kind: d.kind, status: 'pending' } });
        await enqueueDeliverySend(this.jobs, { runDeliveryId: row.id, userId, orgId: null }, 'delivery_run_ended');
        queued += 1;
      } catch (e) {
        if (!(e instanceof Prisma.PrismaClientKnownRequestError && e.code === 'P2002')) throw e;
        // Already there (the hook fired twice, or an earlier enqueue failed): a row still waiting is queued again; the queue dedups a live job.
        const existing = await this.prisma.runDelivery.findFirst({ where: { runId, deliveryId: d.id } });
        if (existing?.status === 'pending' && existing.attempts === 0) await enqueueDeliverySend(this.jobs, { runDeliveryId: existing.id, userId, orgId: null }, 'delivery_run_ended');
      }
    }
    return queued;
  }

  // ----- 2. the job ---------------------------------------------------------------------------------------------------

  /** One attempt at one run delivery (what a `deliveries.send` job does). Never throws for a delivery's own failure: that is the row's `failed`. */
  async attempt(runDeliveryId: string): Promise<'sent' | 'skipped' | 'failed' | 'retry' | 'noop'> {
    const row = await this.prisma.runDelivery.findUnique({ where: { id: runDeliveryId } });
    if (!row || row.status === 'sent' || row.status === 'skipped' || row.status === 'failed') return 'noop';

    // Claim it: pending (or a `sending` row whose job died), one job at a time. The loser of a race changes nothing.
    const staleBefore = new Date(this.clock() - STALE_SENDING_MS);
    const claimed = await this.prisma.runDelivery.updateMany({
      where: { id: row.id, OR: [{ status: 'pending' }, { status: 'sending', updatedAt: { lt: staleBefore } }] },
      data: { status: 'sending', attempts: { increment: 1 }, errorCode: null, nextAttemptAt: null },
    });
    if (claimed.count === 0) return 'noop';
    const ambiguous = row.status === 'sending';
    const attempt = row.attempts + 1;
    const started = this.clock();
    let detail = asObject(row.detail);

    const kind = row.kind as DeliveryKind;
    try {
      const delivery = row.deliveryId ? await this.prisma.forUser({ userId: row.userId }).taskDelivery.findFirst({ where: { id: row.deliveryId } }) : null;
      if (!delivery) return await this.settle(row, kind, attempt, { status: 'skipped', detail: { ...detail, reason: 'delivery_removed' }, code: 'CONFIG_INVALID' });
      if (!delivery.enabled) return await this.settle(row, kind, attempt, { status: 'skipped', detail: { ...detail, reason: 'disabled' } });
      const sender = this.senders.get(kind);
      const parsed = isDeliveryKind(kind) ? CONFIG_SCHEMAS[kind].safeParse(delivery.config) : null;
      if (!sender || !parsed?.success) throw new DeliveryFailure('CONFIG_INVALID');
      const run = await this.loadRun(row.userId, row.runId);
      if (!run) return 'noop';

      const ctx: SendContext = {
        delivery: { id: delivery.id, userId: row.userId, taskId: delivery.taskId, kind, config: parsed.data },
        facts: factsOf(run),
        material: this.material.forRun(row.userId, row.runId),
        attempt,
        ambiguous,
        prior: detail,
        idempotencyKey: `run:${row.runId}:delivery:${delivery.id}`,
        test: false,
        record: async (patch) => {
          detail = { ...detail, ...patch };
          await this.prisma.runDelivery.update({ where: { id: row.id }, data: { detail: detail as Prisma.InputJsonValue } });
        },
        pin: async ({ fileId }) => this.pinFile(delivery, fileId),
      };
      const out = await sender.send(ctx);
      this.events.duration(kind, this.clock() - started);
      return await this.settle(row, kind, attempt, { status: out.status, detail: { ...detail, ...out.detail }, code: out.code });
    } catch (e) {
      this.events.duration(kind, this.clock() - started);
      return this.fail(row, kind, attempt, failureFrom(e), detail);
    }
  }

  private async settle(row: RunDelivery, kind: DeliveryKind, attempt: number, out: Pick<SendOutcome, 'status' | 'detail' | 'code'>): Promise<'sent' | 'skipped'> {
    await this.prisma.runDelivery.update({
      where: { id: row.id },
      data: { status: out.status, attempts: attempt, detail: out.detail as Prisma.InputJsonValue, errorCode: out.code ?? null, nextAttemptAt: null, sentAt: out.status === 'sent' ? new Date(this.clock()) : null },
    });
    this.events.count(kind, out.status);
    if (out.status === 'sent') await this.events.audit(row.userId, DELIVERY_AUDIT.sent, row.id, { runId: row.runId, deliveryId: row.deliveryId, kind, attempts: attempt });
    return out.status;
  }

  private async fail(row: RunDelivery, kind: DeliveryKind, attempt: number, f: DeliveryFailure, detail: Record<string, unknown>): Promise<'failed' | 'retry'> {
    const budgetBase = typeof detail.budgetBase === 'number' ? detail.budgetBase : 0;
    const merged = { ...detail, ...f.detail };
    if (f.retryable && attempt - budgetBase < DELIVERY_MAX_ATTEMPTS) {
      const wait = backoffMs(attempt - budgetBase, f.retryAfterMs);
      await this.prisma.runDelivery.update({
        where: { id: row.id },
        data: { status: 'pending', attempts: attempt, errorCode: f.code, detail: merged as Prisma.InputJsonValue, nextAttemptAt: new Date(this.clock() + wait) },
      });
      await enqueueDeliverySend(this.jobs, { runDeliveryId: row.id, userId: row.userId, orgId: null }, 'delivery_retry', { delayMs: wait, skipDedup: true });
      this.events.count(kind, 'retry');
      return 'retry';
    }
    await this.prisma.runDelivery.update({ where: { id: row.id }, data: { status: 'failed', attempts: attempt, errorCode: f.code, detail: merged as Prisma.InputJsonValue, nextAttemptAt: null } });
    this.events.count(kind, 'failed');
    await this.events.audit(row.userId, DELIVERY_AUDIT.failed, row.id, { runId: row.runId, deliveryId: row.deliveryId, kind, code: f.code, attempts: attempt });
    await this.tellOwner(row, kind, f.code);
    return 'failed';
  }

  /** Once per task per day (the owner reads the rest in the run's log). After the row's write, outside any transaction. */
  private async tellOwner(row: RunDelivery, kind: DeliveryKind, code: DeliveryErrorCode): Promise<void> {
    try {
      const d = row.deliveryId ? await this.prisma.taskDelivery.findUnique({ where: { id: row.deliveryId }, select: { id: true, taskId: true } }) : null;
      if (!d) return;
      const since = new Date(this.clock() - DAY_MS);
      if ((await this.prisma.taskDelivery.count({ where: { taskId: d.taskId, failureNotifiedAt: { gt: since } } })) > 0) return;
      const won = await this.prisma.taskDelivery.updateMany({ where: { id: d.id, OR: [{ failureNotifiedAt: null }, { failureNotifiedAt: { lte: since } }] }, data: { failureNotifiedAt: new Date(this.clock()) } });
      if (won.count === 1) await this.events.failed(row.userId, { taskId: d.taskId, runId: row.runId, kind, code });
    } catch (e) {
      this.log.warn(`could not tell the owner about a failed delivery (${e instanceof Error ? e.name : 'error'})`);
    }
  }

  /** A spreadsheet the delivery created itself: its id is written into the configuration so the next run appends to it. */
  private async pinFile(delivery: TaskDelivery, fileId: string): Promise<void> {
    const config = { ...asObject(delivery.config), fileId };
    await this.prisma.taskDelivery.update({ where: { id: delivery.id }, data: { config: config as Prisma.InputJsonValue } });
    await this.events.audit(delivery.userId, DELIVERY_AUDIT.updated, delivery.id, { taskId: delivery.taskId, kind: delivery.kind, fileCreated: true });
  }

  // ----- the owner's view and retry ----------------------------------------------------------------------------------

  async listForRun(userId: string, runId: string): Promise<RunDeliveryView[]> {
    const rows = await this.prisma.forUser({ userId }).runDelivery.findMany({ where: { runId }, orderBy: [{ createdAt: 'asc' }, { id: 'asc' }] });
    return rows.map(runDeliveryView);
  }

  /** Counts by status, for each run: `run_status` and the runs list. */
  async summaryFor(userId: string, runIds: readonly string[]): Promise<Map<string, { total: number; pending: number; sending: number; sent: number; failed: number; skipped: number }>> {
    const out = new Map<string, { total: number; pending: number; sending: number; sent: number; failed: number; skipped: number }>();
    if (runIds.length === 0) return out;
    const groups = await this.prisma.forUser({ userId }).runDelivery.groupBy({ by: ['runId', 'status'], where: { runId: { in: [...runIds] } }, _count: { _all: true } });
    for (const g of groups) {
      const s = out.get(g.runId) ?? { total: 0, pending: 0, sending: 0, sent: 0, failed: 0, skipped: 0 };
      s.total += g._count._all;
      if (g.status in s) (s as unknown as Record<string, number>)[g.status] += g._count._all;
      out.set(g.runId, s);
    }
    return out;
  }

  /**
   * The owner retries a delivery: one that failed, or one stuck pending or sending for longer than a job can run. It gets a fresh set of
   * attempts; the retry still checks for its own earlier work first (an append, an upload) because there was an earlier attempt.
   */
  async ownerRetry(userId: string, runId: string, runDeliveryId: string): Promise<RunDeliveryView> {
    const row = await this.prisma.forUser({ userId }).runDelivery.findFirst({ where: { id: runDeliveryId, runId } });
    if (!row) throw new NotFoundException({ code: 'RUN_DELIVERY_NOT_FOUND', message: 'Delivery not found' });
    const stuck = (row.status === 'sending' || row.status === 'pending') && this.clock() - row.updatedAt.getTime() > STALE_SENDING_MS;
    const notRetryable = () => new ConflictException({ code: 'DELIVERY_NOT_RETRYABLE', message: 'Only a delivery that failed, or one stuck sending or pending, can be retried.' });
    if (row.status !== 'failed' && !stuck) throw notRetryable();
    const detail = { ...asObject(row.detail), budgetBase: row.attempts };
    const reset = await this.prisma.runDelivery.updateMany({
      where: { id: row.id, status: row.status },
      data: { status: 'pending', errorCode: null, nextAttemptAt: null, detail: detail as Prisma.InputJsonValue },
    });
    if (reset.count === 0) throw notRetryable();
    await this.events.audit(userId, DELIVERY_AUDIT.retried, row.id, { runId, deliveryId: row.deliveryId, kind: row.kind });
    await enqueueDeliverySend(this.jobs, { runDeliveryId: row.id, userId, orgId: null }, 'delivery_owner_retry', { skipDedup: true });
    return runDeliveryView((await this.prisma.runDelivery.findUnique({ where: { id: row.id } }))!);
  }

  // ----- a test send ----------------------------------------------------------------------------------------------------

  /** Sends a clearly marked test with sample values to the delivery's own destination. Never reads a run; never writes a run's log. */
  async test(userId: string, delivery: TaskDelivery, task: { id: string; name: string; outputs: unknown }): Promise<{ ok: boolean; code: DeliveryErrorCode | null; detail: Record<string, unknown> }> {
    const kind = delivery.kind as DeliveryKind;
    const sender = this.senders.get(kind);
    const parsed = isDeliveryKind(kind) ? CONFIG_SCHEMAS[kind].safeParse(delivery.config) : null;
    if (!sender || !parsed?.success) return { ok: false, code: 'CONFIG_INVALID', detail: {} };
    let detail: Record<string, unknown> = {};
    const started = this.clock();
    const ctx: SendContext = {
      delivery: { id: delivery.id, userId, taskId: delivery.taskId, kind, config: parsed.data },
      facts: sampleFacts(userId, { id: task.id, name: task.name, outputs: readOutputs(task.outputs) }, new Date(this.clock())),
      material: null,
      attempt: 1,
      ambiguous: false,
      prior: {},
      idempotencyKey: `test:${delivery.id}:${started}`,
      test: true,
      record: async (patch) => void (detail = { ...detail, ...patch }),
      pin: async ({ fileId }) => this.pinFile(delivery, fileId),
    };
    try {
      const out = await sender.send(ctx);
      detail = { ...detail, ...out.detail };
      this.events.count(kind, 'test');
      return { ok: out.status === 'sent', code: out.code ?? null, detail };
    } catch (e) {
      const f = failureFrom(e);
      this.events.count(kind, 'test');
      return { ok: false, code: f.code, detail: { ...detail, ...f.detail } };
    } finally {
      this.events.duration(kind, this.clock() - started);
    }
  }
}
