import { Injectable, type OnModuleDestroy, type OnModuleInit } from '@nestjs/common';
import type { Prisma } from '@prisma/client';

import { PrismaService } from '../prisma/prisma.service';
import { readConfirmedActions } from '../runner/confirmed-actions';
import { RunEndHooks } from '../tasks/run-end-hooks';
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

  constructor(
    private readonly prisma: PrismaService,
    private readonly chats: ChatService,
    private readonly hooks: RunEndHooks,
  ) {}

  onModuleInit(): void {
    this.unregister = this.hooks.register((userId, runId) => this.recordRunEnd(userId, runId));
  }

  onModuleDestroy(): void {
    this.unregister?.();
  }

  /** The run ended: if a chat started it, say so in the chat. No-op for any other run and for a live one. */
  async recordRunEnd(userId: string, runId: string): Promise<void> {
    const run = await this.prisma.forUser({ userId }).run.findFirst({
      where: { id: runId, conversationId: { not: null }, status: { in: [...TERMINAL_RUN_STATUSES] } },
      select: { id: true, conversationId: true, status: true, result: true, error: true, stopReason: true, costUsd: true, costKnown: true, stepCount: true, confirmedActions: true },
    });
    if (!run?.conversationId) return;
    const meta: Prisma.InputJsonObject = { status: run.status, stopReason: run.stopReason, costUsd: Number(run.costUsd), costKnown: run.costKnown, stepCount: run.stepCount, confirmedActions: readConfirmedActions(run.confirmedActions).length };
    await this.chats.append(run.conversationId, { role: 'assistant', kind: 'result', text: resultText(run).slice(0, RESULT_TEXT_MAX), runId: run.id, meta }, { onceForRun: true });
  }

  /** Write the result of every finished run of the chat that has none yet. */
  async sync(userId: string, conversationId: string): Promise<void> {
    const missing = await this.prisma.forUser({ userId }).run.findMany({
      where: { conversationId, status: { in: [...TERMINAL_RUN_STATUSES] }, chatMessages: { none: { kind: 'result' } } },
      orderBy: { finishedAt: 'asc' },
      select: { id: true },
    });
    for (const r of missing) await this.recordRunEnd(userId, r.id);
  }
}
