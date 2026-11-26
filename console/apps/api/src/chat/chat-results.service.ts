import { suggestedConnections } from '../tasks/run-suggestions';
import { Injectable, Optional, type OnModuleDestroy, type OnModuleInit } from '@nestjs/common';
import type { Prisma } from '@prisma/client';

import { ApprovalRulesService } from '../approvals/approval-rules.service';
import { RunBatchService } from '../tasks/run-batch.service';
import { savedApprovalsLine } from '../approvals/approval-runner';
import { PrismaService } from '../prisma/prisma.service';
import { readConfirmedActions } from '../runner/confirmed-actions';
import { RunEndHooks } from '../tasks/run-end-hooks';
import { outputsView } from '../tasks/task-outputs';
import { TERMINAL_RUN_STATUSES } from '../tasks/run-status';
import { ChatService } from './chat.service';

const RESULT_TEXT_MAX = 8000;

/** What the thread says when a run ended without words of its own. */
function resultText(run: { status: string; result: string | null; error: string | null; confirmedActions?: unknown }): string {
  if (run.status === 'succeeded') return run.result?.trim() || 'Done.';
  // A confirmed step was carried out (#540): the result leads with it, so it is what the thread shows.
  if (readConfirmedActions(run.confirmedActions).length && run.result?.trim()) return [run.result.trim(), run.error?.trim()].filter(Boolean).join('\n\n');
  if (run.status === 'cancelled') return run.error?.trim() || 'Stopped.';
  return run.error?.trim() || run.result?.trim() || 'The run failed.';
}

/**
 * Writes how a chat's run ended into its thread (#484): one `result` message
 * per run, however many times it is asked. It hears the end of every run
 * through `RunEndHooks`; `sync` is the backstop a turn calls, for a run that
 * ended on a path that fired no hook.
 */
@Injectable()
export class ChatResults implements OnModuleInit, OnModuleDestroy {
  private unregister?: () => void;
  private unregisterBatch?: () => void;

  constructor(
    private readonly prisma: PrismaService,
    private readonly chats: ChatService,
    private readonly hooks: RunEndHooks,
    @Optional() private readonly approvals?: ApprovalRulesService,
    @Optional() private readonly batches?: RunBatchService,
  ) {}

  onModuleInit(): void {
    this.unregister = this.hooks.register((userId, runId) => this.recordRunEnd(userId, runId));
    this.unregisterBatch = this.batches?.onBatchEnd((userId, batchId) => this.recordBatchEnd(userId, batchId));
  }

  onModuleDestroy(): void {
    this.unregister?.();
    this.unregisterBatch?.();
  }

  /**
   * A chat's batch ended (E51.1): ONE summary message for the whole batch ("3 of 3 done", "2 done, 1 failed, 2 not started"), with
   * the rows whose steps went ahead on saved approvals and, when a row ended with a step of unknown outcome, which row. Called once
   * per batch (the batch's end is a compare-and-set).
   */
  async recordBatchEnd(userId: string, batchId: string): Promise<void> {
    const view = await this.batches?.get(userId, batchId).catch(() => null);
    if (!view?.conversationId) return;
    const saved: string[] = [];
    for (const item of view.items) {
      if (!item.runId || !this.approvals) continue;
      const line = savedApprovalsLine((await this.approvals.gateUsesOfRun(userId, item.runId).catch(() => [])) ?? []);
      if (line) saved.push(`Row ${item.seq}: ${line}`);
    }
    const why =
      view.stopReason === 'unknown_outcome' && view.stoppedAtSeq
        ? `Row ${view.stoppedAtSeq} ended with a step that may or may not have happened, so the batch stopped. Check it before you run the rest.`
        : view.stopReason === 'owner_stopped'
          ? 'Stopped by you.'
          : view.stopReason === 'row_failed' && view.stoppedAtSeq
            ? `Row ${view.stoppedAtSeq} failed, so the batch stopped.`
            : null;
    const text = [view.summary, ...(why ? [why] : []), ...saved].join('\n');
    const meta: Prisma.InputJsonObject = {
      batchId,
      batchSummary: true,
      status: view.status,
      counts: view.counts as unknown as Prisma.InputJsonObject,
      ...(view.stopReason ? { stopReason: view.stopReason, stoppedAtSeq: view.stoppedAtSeq } : {}),
      ...(saved.length ? { savedApprovals: saved.join('\n') } : {}),
    };
    await this.chats.append(view.conversationId, { role: 'assistant', kind: 'result', text: text.slice(0, RESULT_TEXT_MAX), meta });
  }

  /** The run ended: if a chat started it, say so in the chat. No-op for any other run and for a live one. */
  async recordRunEnd(userId: string, runId: string): Promise<void> {
    const run = await this.prisma.forUser({ userId }).run.findFirst({
      // A batch's run writes no result of its own (E51.1): the batch writes one summary when it ends.
      where: { id: runId, conversationId: { not: null }, batchId: null, status: { in: [...TERMINAL_RUN_STATUSES] } },
      select: { id: true, taskId: true, conversationId: true, policySnapshot: true, status: true, result: true, error: true, stopReason: true, costUsd: true, costKnown: true, stepCount: true, confirmedActions: true, outputs: true, outputsSpec: true, outputsComplete: true },
    });
    if (!run?.conversationId) return;
    // Steps that went ahead on saved approvals (#555): the same line as the end-of-run notification.
    const savedApprovals = savedApprovalsLine((await this.approvals?.gateUsesOfRun(userId, run.id).catch(() => [])) ?? []);
    // What the run returned (E39.5): the definitions it started with and the values, masked (a sensitive one is `[hidden]`).
    const outputs = outputsView(run.outputsSpec, run.outputs);
    const suggested = await suggestedConnections(this.prisma, userId, run).catch(() => []);
    const meta: Prisma.InputJsonObject = {
      status: run.status,
      stopReason: run.stopReason,
      costUsd: Number(run.costUsd),
      costKnown: run.costKnown,
      stepCount: run.stepCount,
      confirmedActions: readConfirmedActions(run.confirmedActions).length,
      ...(savedApprovals ? { savedApprovals } : {}),
      ...(outputs ? { outputs: outputs as unknown as Prisma.InputJsonArray, outputsComplete: run.outputsComplete } : {}),
      // The owner's unlisted account that could have done it without the browser (E41.5): a line on the result card, never for the model.
      ...(suggested.length ? { suggestedConnections: suggested as unknown as Prisma.InputJsonArray } : {}),
    };
    await this.chats.append(run.conversationId, { role: 'assistant', kind: 'result', text: resultText(run).slice(0, RESULT_TEXT_MAX), runId: run.id, meta }, { onceForRun: true });
  }

  /** Write the result of every finished run of the chat that has none yet. */
  async sync(userId: string, conversationId: string): Promise<void> {
    const missing = await this.prisma.forUser({ userId }).run.findMany({
      where: { conversationId, batchId: null, status: { in: [...TERMINAL_RUN_STATUSES] }, chatMessages: { none: { kind: 'result' } } },
      orderBy: { finishedAt: 'asc' },
      select: { id: true },
    });
    for (const r of missing) await this.recordRunEnd(userId, r.id);
  }
}
