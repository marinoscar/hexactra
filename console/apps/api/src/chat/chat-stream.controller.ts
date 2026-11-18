import { BadRequestException, Controller, Injectable, NotFoundException, Param, ParseUUIDPipe, Query, Sse, UseGuards, type CanActivate, type ExecutionContext, type MessageEvent } from '@nestjs/common';
import { ApiQuery, ApiTags } from '@nestjs/swagger';
import { Auth, CurrentUser } from '@marinoscar/platform-api/identity';
import { Observable } from 'rxjs';

import { PrismaService } from '../prisma/prisma.service';
import { toQuestionView, type QuestionView } from '../questions/questions.service';
import { withCost } from '../tasks/run-cost';
import './chat.errors';
import { getChatSchema } from './chat.schemas';
import type { ChatMessageView } from './chat.service';

/** How often the stream looks for something new, and how often it says it is alive when there is nothing. */
export const CHAT_STREAM_POLL_MS = 1_000;
export const CHAT_STREAM_HEARTBEAT_MS = 15_000;
/** Messages per look: a longer backlog arrives over the next looks. */
const MESSAGES_PER_TICK = 200;

/** The chat's newest run as the thread shows it: its live columns, never its transcript or policy snapshot. */
export interface ChatRunView {
  id: string;
  status: string;
  goal: string;
  stepCount: number;
  activity: unknown;
  result: string | null;
  error: string | null;
  stopReason: string | null;
  cancelRequested: boolean;
  hostId: string | null;
  costUsd: number;
  costKnown: boolean;
  createdAt: Date;
  startedAt: Date | null;
  finishedAt: Date | null;
}

/** One look at a chat: what is new since `afterSeq`, and its current state. */
export interface ChatSnapshot {
  chat: { title: string; status: string };
  messages: ChatMessageView[];
  thinking: boolean;
  run: ChatRunView | null;
  /** The request the run waits on, without a response; null when it waits on none. */
  question: QuestionView | null;
}

/**
 * 404 for a chat that is not the caller's and 400 for a bad `afterSeq`, BEFORE
 * a stream's headers go out (Nest's SSE writes them before the handler and
 * its pipes run, where a failure could only be a 500). Placed above `@Auth`,
 * so it runs after authentication.
 */
@Injectable()
export class ChatOwnerGuard implements CanActivate {
  constructor(private readonly prisma: PrismaService) {}

  async canActivate(ctx: ExecutionContext): Promise<boolean> {
    const req = ctx.switchToHttp().getRequest<{ user?: { id: string }; params: { id?: string }; query?: unknown }>();
    if (!req.user || !req.params.id) return true;
    const query = getChatSchema.safeParse(req.query ?? {});
    if (!query.success) throw new BadRequestException({ code: 'VALIDATION_ERROR', message: 'afterSeq must be a whole number, 0 or more' });
    const found = await this.prisma.forUser({ userId: req.user.id }).conversation.count({ where: { id: req.params.id } });
    if (!found) throw new NotFoundException({ code: 'CHAT_NOT_FOUND', message: 'Chat not found' });
    return true;
  }
}

/** Reads what the stream sends. Apart from the controller so it can be read without holding a stream open. */
@Injectable()
export class ChatStreamService {
  constructor(private readonly prisma: PrismaService) {}

  /** Null when the chat is gone (or was never the user's). */
  async snapshot(userId: string, id: string, afterSeq: number): Promise<ChatSnapshot | null> {
    const db = this.prisma.forUser({ userId });
    const c = await db.conversation.findFirst({ where: { id }, select: { id: true, title: true, status: true, turnLeaseUntil: true } });
    if (!c) return null;
    const [rows, newest] = await Promise.all([
      this.prisma.chatMessage.findMany({ where: { conversationId: c.id, seq: { gt: afterSeq } }, orderBy: { seq: 'asc' }, take: MESSAGES_PER_TICK }),
      db.run.findFirst({
        where: { conversationId: c.id },
        orderBy: { createdAt: 'desc' },
        select: { id: true, status: true, goal: true, stepCount: true, activity: true, result: true, error: true, stopReason: true, cancelRequested: true, hostId: true, costUsd: true, costKnown: true, createdAt: true, startedAt: true, finishedAt: true },
      }),
    ]);
    // Only a run that waits for its person has a request to show.
    const pending =
      newest?.status === 'waiting_human'
        ? await db.question.findFirst({ where: { runId: newest.id, status: 'pending', expiresAt: { gt: new Date() } }, orderBy: { createdAt: 'desc' } })
        : null;
    return {
      chat: { title: c.title, status: c.status },
      messages: rows.map((m) => ({ id: m.id, seq: m.seq, role: m.role, kind: m.kind, text: m.text, runId: m.runId, meta: m.meta, createdAt: m.createdAt })),
      thinking: c.turnLeaseUntil !== null && c.turnLeaseUntil > new Date(),
      run: newest ? withCost(newest) : null,
      // A pending question has no response; the field is cleared all the same, so a stream can never carry one.
      question: pending ? { ...toQuestionView(pending), response: null, answeredAt: null } : null,
    };
  }
}

/**
 * `GET /api/chats/:id/stream` (#485): one event stream for an open chat, so
 * the page does not poll several routes.
 *
 * - `chat`: `{ title, status }`, when either changes (a first message names the chat).
 * - `message`: each message after `afterSeq`, oldest first, then each new one.
 * - `turn`: `{ thinking }`, true while the AI works on its reply.
 * - `run`: the chat's newest run (its live columns), or `null` when it has none.
 * - `question`: the request that run waits on, or `null` once it is answered, cancelled or expired. Never a response.
 * - `heartbeat`: every 15 s of silence.
 *
 * The stream stays open across runs and ends only when the chat is deleted.
 * Reconnect with the last `seq` seen as `afterSeq`: the state events are
 * sent again, the messages are not.
 */
@ApiTags('Chats')
@Controller('chats')
export class ChatStreamController {
  constructor(private readonly reader: ChatStreamService) {}

  @Sse(':id/stream')
  @ApiQuery({ name: 'afterSeq', required: false, type: Number, description: 'Send only messages with a `seq` greater than this; `0` (the default) sends the whole thread.' })
  @UseGuards(ChatOwnerGuard)
  @Auth({ permissions: ['chat:read'] })
  stream(@CurrentUser('id') userId: string, @Param('id', ParseUUIDPipe) id: string, @Query('afterSeq') afterSeq?: string | number): Observable<MessageEvent> {
    // Already validated by the guard; read plainly here, where a pipe's failure would come too late.
    const from = Math.max(0, Math.floor(Number(afterSeq ?? 0)) || 0);
    return new Observable<MessageEvent>((observer) => {
      let lastSeq = from;
      const last = { chat: '', turn: '', run: '', question: '' };
      let closed = false;
      let sinceBeat = 0;
      let timer: NodeJS.Timeout | undefined;
      const tick = async () => {
        if (closed) return;
        try {
          const snap = await this.reader.snapshot(userId, id, lastSeq);
          if (!snap) return void observer.complete();
          let sent = false;
          const state = (key: keyof typeof last, type: string, data: unknown) => {
            const now = JSON.stringify(data);
            if (now === last[key]) return;
            last[key] = now;
            observer.next({ type, data: data as object });
            sent = true;
          };
          state('chat', 'chat', snap.chat);
          for (const m of snap.messages) {
            observer.next({ type: 'message', id: `message-${m.seq}`, data: m });
            lastSeq = m.seq;
            sent = true;
          }
          state('turn', 'turn', { thinking: snap.thinking });
          // `null` is sent as a value, so the page can tell "no run" from "nothing new".
          state('run', 'run', { run: snap.run });
          state('question', 'question', { question: snap.question });
          if (sent) sinceBeat = 0;
          else if ((sinceBeat += CHAT_STREAM_POLL_MS) >= CHAT_STREAM_HEARTBEAT_MS) {
            observer.next({ type: 'heartbeat', data: {} });
            sinceBeat = 0;
          }
        } catch (e) {
          return void observer.error(e);
        }
        timer = setTimeout(() => void tick(), CHAT_STREAM_POLL_MS);
      };
      timer = setTimeout(() => void tick(), 0);
      return () => {
        closed = true;
        if (timer) clearTimeout(timer);
      };
    });
  }
}
