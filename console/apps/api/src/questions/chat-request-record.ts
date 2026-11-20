// E40.1 (#685): a request a chat's run makes of the owner stays in the chat
// thread after it is answered, declined or expired. The message holds the
// masked prompt and the question's id; its outcome is read from the question
// when the thread is shown, so no settle path has to touch the chat, and no
// value (a secret, a sign-in, a typed answer) is ever written here.
import type { Logger } from '@nestjs/common';
import { Prisma, type PrismaClient } from '@prisma/client';

import { maskSensitive } from '../tasks/mask';

/** Inputs that are never recorded as a request: suggestions have their own cards in the thread. */
const NOT_RECORDED = new Set(['memory', 'save_login']);

/** The text of a request message: the masked prompt, on one line. */
export function requestMessageText(prompt: string): string {
  return maskSensitive(prompt.replace(/\s+/g, ' ').trim()).text.slice(0, 2000);
}

export interface RecordedQuestion {
  id: string;
  runId: string | null;
  input: string;
  kind: string;
  prompt: string;
  blocking?: boolean;
}

type Db = Pick<PrismaClient, 'run' | '$transaction'>;

/**
 * Append a `request` message to the chat of the question's run, if the run
 * belongs to a chat. Once per question. Never throws: a failure is logged and
 * the question stands.
 */
export async function recordRequestInChat(prisma: Db, q: RecordedQuestion, log?: Pick<Logger, 'warn'>): Promise<void> {
  if (!q.runId || q.blocking === false || NOT_RECORDED.has(q.input)) return;
  try {
    const run = await prisma.run.findFirst({ where: { id: q.runId }, select: { conversationId: true } });
    const conversationId = run?.conversationId;
    if (!conversationId) return;
    await prisma.$transaction(async (tx) => {
      const there = await tx.chatMessage.count({ where: { conversationId, kind: 'request', meta: { path: ['questionId'], equals: q.id } } });
      if (there > 0) return;
      const now = new Date();
      const c = await tx.conversation.update({ where: { id: conversationId }, data: { nextSeq: { increment: 1 }, lastMessageAt: now }, select: { nextSeq: true } });
      await tx.chatMessage.create({
        data: {
          conversationId,
          seq: c.nextSeq - 1,
          role: 'assistant',
          kind: 'request',
          text: requestMessageText(q.prompt),
          runId: q.runId,
          meta: { questionId: q.id, input: q.input, questionKind: q.kind } as Prisma.InputJsonValue,
          createdAt: now,
        },
      });
    });
  } catch (e) {
    log?.warn(`question ${q.id}: could not record it in the chat: ${e instanceof Error ? e.message : String(e)}`);
  }
}

/** How a settled request reads in the model's transcript and the thread: outcome words only, never a value. */
export function requestOutcomeWords(q: { status: string; input: string; response: unknown }): string {
  if (q.status === 'pending') return 'waiting for the owner';
  if (q.status === 'expired') return 'expired without an answer';
  const r = (q.response ?? {}) as { outcome?: string };
  if (q.status === 'cancelled' || r.outcome === 'cancelled') return q.input === 'confirm' ? 'denied' : 'declined';
  if (q.input === 'confirm') return 'allowed';
  if (q.input === 'takeover' || q.input === 'none') return 'done by the owner';
  return 'provided';
}

/**
 * The thread rows with each request's outcome as `meta.outcome`, read from its
 * question (one query). Rows of other kinds pass through unchanged.
 */
export async function withRequestOutcomes<T extends { kind: string; meta: Prisma.JsonValue | null }>(prisma: Pick<PrismaClient, 'question'>, rows: T[]): Promise<T[]> {
  const ids = rows.filter((r) => r.kind === 'request').map((r) => (r.meta as { questionId?: unknown } | null)?.questionId).filter((id): id is string => typeof id === 'string');
  if (ids.length === 0) return rows;
  const qs = await prisma.question.findMany({ where: { id: { in: ids } }, select: { id: true, status: true, input: true, response: true } });
  const byId = new Map(qs.map((q) => [q.id, q]));
  return rows.map((r) => {
    if (r.kind !== 'request') return r;
    const meta = (r.meta ?? {}) as Record<string, unknown>;
    const q = typeof meta.questionId === 'string' ? byId.get(meta.questionId) : undefined;
    return { ...r, meta: { ...meta, outcome: q ? requestOutcomeWords(q) : 'no longer kept' } };
  });
}
