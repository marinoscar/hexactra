import { BadRequestException, ConflictException, Injectable, NotFoundException, Optional } from '@nestjs/common';
import { Prisma, type ChatMessage, type ChatMessageKind, type ChatMessageRole, type Conversation } from '@prisma/client';

import { assertSelectable, conversationConnectionViews, replaceConversationConnections, type ConnectionSelectionView } from '../connections/agent-connections';
import { defaultChatSelections } from '../connections/chat-default';
import { ownerDefaultUseSavedLogins } from '../secrets/saved-logins-default';
import { PoliciesService } from '../policies/policies.service';
import { PrismaService } from '../prisma/prisma.service';
import { RunDeleteService } from '../tasks/run-delete.service';
import { LIVE_RUN_STATUSES } from '../tasks/runs.schemas';
import { withRequestOutcomes } from '../questions/chat-request-record';
import './chat.errors';
import { CHAT_MESSAGES_MAX, CHAT_TITLE_MAX, type CreateChatDto, type ListChatsDto, type UpdateChatDto } from './chat.schemas';

/** A conversation as the API answers it: no owner column, no sequence counter. */
export interface ChatView {
  id: string;
  title: string;
  status: Conversation['status'];
  profile: string;
  hostId: string | null;
  hostFallback: boolean;
  policyId: string | null;
  allowedDomains: string[];
  confirmRiskyActions: boolean;
  useSavedLogins: boolean;
  useSavedIdentity: boolean;
  useSavedCards: boolean;
  /** The connections the chat may use (E39.7). */
  connections: ConnectionSelectionView[];
  lastMessageAt: Date;
  createdAt: Date;
  updatedAt: Date;
}

export interface ChatMessageView {
  id: string;
  seq: number;
  role: ChatMessageRole;
  kind: ChatMessageKind;
  text: string;
  runId: string | null;
  meta: Prisma.JsonValue | null;
  createdAt: Date;
}

/** The live run of a chat, when it has one: what the list's dot and the thread's header show. */
export interface ChatLiveRun {
  id: string;
  status: (typeof LIVE_RUN_STATUSES)[number];
}

export interface ChatListItem extends ChatView {
  /** The start of the newest message, on one line; null for an empty chat. */
  preview: { role: ChatMessageRole; kind: ChatMessageKind; text: string } | null;
  liveRun: ChatLiveRun | null;
}

export interface ChatDetail extends ChatView {
  messages: ChatMessageView[];
  /** True when the thread has more messages after the last one returned. */
  hasMore: boolean;
  liveRun: ChatLiveRun | null;
  /** True while a turn is working on its reply (the conversation's lease is held). */
  thinking: boolean;
}

/** A message to append: what the turn engine (#484) and the routes write. */
export interface NewChatMessage {
  role: ChatMessageRole;
  kind?: ChatMessageKind;
  text?: string;
  runId?: string | null;
  meta?: Prisma.InputJsonValue;
}

const PREVIEW_MAX = 140;
const TITLE_FROM_MESSAGE_MAX = 80;

const oneLine = (text: string) => text.replace(/\s+/g, ' ').trim();
const clip = (text: string, max: number) => (text.length > max ? `${text.slice(0, max - 1).trimEnd()}…` : text);

/** A chat's title from its first message: one line, at most 80 characters. */
export function titleFromMessage(text: string): string {
  return clip(oneLine(text), Math.min(TITLE_FROM_MESSAGE_MAX, CHAT_TITLE_MAX));
}

function view(c: Conversation, connections: ConnectionSelectionView[] = []): ChatView {
  return { connections, id: c.id, title: c.title, status: c.status, profile: c.profile, hostId: c.hostId, hostFallback: c.hostFallback, policyId: c.policyRef, allowedDomains: c.allowedDomains, confirmRiskyActions: c.confirmRiskyActions, useSavedLogins: c.useSavedLogins, useSavedIdentity: c.useSavedIdentity, useSavedCards: c.useSavedCards, lastMessageAt: c.lastMessageAt, createdAt: c.createdAt, updatedAt: c.updatedAt };
}
function messageView(m: ChatMessage): ChatMessageView {
  return { id: m.id, seq: m.seq, role: m.role, kind: m.kind, text: m.text, runId: m.runId, meta: m.meta, createdAt: m.createdAt };
}

interface ChatCursor {
  at: string;
  id: string;
}
const encodeCursor = (c: ChatCursor) => Buffer.from(JSON.stringify(c)).toString('base64url');
function decodeCursor(text: string): ChatCursor {
  try {
    const c = JSON.parse(Buffer.from(text, 'base64url').toString('utf8')) as Partial<ChatCursor>;
    if (typeof c.at === 'string' && typeof c.id === 'string' && !Number.isNaN(Date.parse(c.at)) && /^[0-9a-f-]{36}$/i.test(c.id)) return { at: c.at, id: c.id };
  } catch {
    // Falls through to the typed error.
  }
  throw new BadRequestException({ code: 'INVALID_CURSOR', message: 'The cursor is not one a chats page returned. Start again from the first page' });
}

const notFound = () => new NotFoundException({ code: 'CHAT_NOT_FOUND', message: 'Chat not found' });

/**
 * Conversations and their messages (#483), always the caller's own: every
 * conversation query goes through `forUser()`, and a message is only reached
 * through a conversation that query returned. Another user's chat is "not
 * found", never "forbidden".
 */
@Injectable()
export class ChatService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly runsDelete: RunDeleteService,
    @Optional() private readonly policies?: PoliciesService,
  ) {}

  private db(userId: string) {
    return this.prisma.forUser({ userId });
  }

  private async owned(userId: string, id: string): Promise<Conversation> {
    const c = await this.db(userId).conversation.findFirst({ where: { id } });
    if (!c) throw notFound();
    return c;
  }

  private async liveRuns(userId: string, conversationIds: string[]): Promise<Map<string, ChatLiveRun>> {
    const out = new Map<string, ChatLiveRun>();
    if (conversationIds.length === 0) return out;
    const rows = await this.db(userId).run.findMany({
      where: { conversationId: { in: conversationIds }, status: { in: [...LIVE_RUN_STATUSES] } },
      orderBy: { createdAt: 'asc' },
      select: { id: true, status: true, conversationId: true },
    });
    // Oldest first, so the newest live run of a chat is the one that stays.
    for (const r of rows) out.set(r.conversationId!, { id: r.id, status: r.status as ChatLiveRun['status'] });
    return out;
  }

  /** One page of the user's chats, most recently active first. Rows never carry the messages. */
  async list(userId: string, q: ListChatsDto): Promise<{ items: ChatListItem[]; nextCursor: string | null }> {
    const after = q.cursor ? decodeCursor(q.cursor) : null;
    const rows = await this.db(userId).conversation.findMany({
      where: {
        status: q.status,
        ...(after ? { OR: [{ lastMessageAt: { lt: new Date(after.at) } }, { lastMessageAt: new Date(after.at), id: { lt: after.id } }] } : {}),
      },
      orderBy: [{ lastMessageAt: 'desc' }, { id: 'desc' }],
      take: q.limit + 1,
    });
    const page = rows.slice(0, q.limit);
    const ids = page.map((c) => c.id);
    const [last, live] = await Promise.all([
      ids.length
        ? this.prisma.chatMessage.findMany({ where: { conversationId: { in: ids } }, orderBy: [{ conversationId: 'asc' }, { seq: 'desc' }], distinct: ['conversationId'], select: { conversationId: true, role: true, kind: true, text: true } })
        : [],
      this.liveRuns(userId, ids),
    ]);
    const conns = await conversationConnectionViews(this.prisma, ids);
    const previews = new Map(last.map((m) => [m.conversationId, { role: m.role, kind: m.kind, text: clip(oneLine(m.text), PREVIEW_MAX) }]));
    const tail = page[page.length - 1];
    return {
      items: page.map((c) => ({ ...view(c, conns.get(c.id) ?? []), preview: previews.get(c.id) ?? null, liveRun: live.get(c.id) ?? null })),
      nextCursor: rows.length > q.limit && tail ? encodeCursor({ at: tail.lastMessageAt.toISOString(), id: tail.id }) : null,
    };
  }

  private async withConnections(c: Conversation): Promise<ChatView> {
    return view(c, (await conversationConnectionViews(this.prisma, [c.id])).get(c.id) ?? []);
  }

  async create(userId: string, input: CreateChatDto): Promise<ChatView> {
    await this.policies?.assertAssignable(userId, input.policyId);
    if (input.connections) await assertSelectable(this.prisma, userId, input.connections);
    // A chat that does not say which accounts starts with the owner's own default (#680); a list, even an empty one, is taken as it is.
    const selections = input.connections ?? (await defaultChatSelections(this.prisma, userId));
    const c = await this.db(userId).conversation.create({
      data: {
        userId,
        title: input.title ?? '',
        ...(input.profile !== undefined ? { profile: input.profile } : {}),
        ...(input.hostId !== undefined ? { hostId: input.hostId } : {}),
        ...(input.hostFallback !== undefined ? { hostFallback: input.hostFallback } : {}),
        ...(input.policyId !== undefined ? { policyRef: input.policyId } : {}),
        ...(input.allowedDomains !== undefined ? { allowedDomains: input.allowedDomains } : {}),
        ...(input.confirmRiskyActions !== undefined ? { confirmRiskyActions: input.confirmRiskyActions } : {}),
        // Absent: the owner's `secrets.defaultUseSavedLogins` (off unless they turned it on).
        useSavedLogins: input.useSavedLogins ?? (await ownerDefaultUseSavedLogins(this.prisma, userId)),
        ...(input.useSavedIdentity !== undefined ? { useSavedIdentity: input.useSavedIdentity } : {}),
        ...(input.useSavedCards !== undefined ? { useSavedCards: input.useSavedCards } : {}),
      },
    });
    if (selections.length) await this.prisma.$transaction((tx) => replaceConversationConnections(tx, c.id, selections));
    return this.withConnections(c);
  }

  /** The chat and its messages after `afterSeq`, oldest first (at most `CHAT_MESSAGES_MAX`). */
  async get(userId: string, id: string, afterSeq = 0): Promise<ChatDetail> {
    const c = await this.owned(userId, id);
    const [rows, live] = await Promise.all([
      this.prisma.chatMessage.findMany({ where: { conversationId: c.id, seq: { gt: afterSeq } }, orderBy: { seq: 'asc' }, take: CHAT_MESSAGES_MAX + 1 }).then((r) => withRequestOutcomes(this.prisma, r)),
      this.liveRuns(userId, [c.id]),
    ]);
    return { ...(await this.withConnections(c)), messages: rows.slice(0, CHAT_MESSAGES_MAX).map(messageView), hasMore: rows.length > CHAT_MESSAGES_MAX, liveRun: live.get(c.id) ?? null, thinking: c.turnLeaseUntil !== null && c.turnLeaseUntil > new Date() };
  }

  async update(userId: string, id: string, patch: UpdateChatDto): Promise<ChatView> {
    const { policyId, connections, ...fields } = patch;
    await this.policies?.assertAssignable(userId, policyId);
    if (connections) await assertSelectable(this.prisma, userId, connections);
    const data: Prisma.ConversationUpdateManyMutationInput = { ...fields, ...(policyId !== undefined ? { policyRef: policyId } : {}) };
    const { count } = await this.db(userId).conversation.updateMany({ where: { id }, data });
    if (count === 0) throw notFound();
    // The chat's own list changes; a run already started keeps its snapshot (E39.7).
    if (connections) await this.prisma.$transaction((tx) => replaceConversationConnections(tx, id, connections));
    return this.withConnections(await this.owned(userId, id));
  }

  /**
   * Delete the chat, its messages and its runs. A chat with a live run is not
   * deleted (409 `CHAT_RUN_LIVE`): a live run is never deleted, and a chat
   * removed under it would leave the run with nowhere to report.
   */
  async remove(userId: string, id: string, opts: { orgId?: string | null } = {}): Promise<void> {
    const c = await this.owned(userId, id);
    const runs = await this.db(userId).run.findMany({ where: { conversationId: c.id }, select: { id: true, status: true } });
    const live = () => new ConflictException({ code: 'CHAT_RUN_LIVE', message: 'A run of this chat is still live. Stop it first' });
    if (runs.some((r) => (LIVE_RUN_STATUSES as readonly string[]).includes(r.status))) throw live();
    if (runs.length > 0) {
      const done = await this.runsDelete.deleteByIds(userId, runs.map((r) => r.id), { orgId: opts.orgId });
      // A run went live between the check and the delete (a turn started it): leave the chat.
      if (done.skippedLive.length > 0) throw live();
    }
    const { count } = await this.db(userId).conversation.deleteMany({ where: { id: c.id } });
    if (count === 0) throw notFound();
  }

  /** The owner's message. Names an untitled chat after its first message. Refused on an archived chat. */
  async postUserMessage(userId: string, id: string, text: string): Promise<ChatMessageView> {
    const c = await this.owned(userId, id);
    if (c.status === 'archived') throw new ConflictException({ code: 'CHAT_ARCHIVED', message: 'This chat is archived. Unarchive it to continue' });
    return this.append(c.id, { role: 'user', kind: 'text', text }, { title: c.title === '' ? titleFromMessage(text) : undefined });
  }

  /** A task was saved from the chat: say so in the thread, once per task, with the task's id for the link. */
  async linkTask(userId: string, id: string, taskId: string): Promise<ChatMessageView> {
    const c = await this.owned(userId, id);
    const task = await this.db(userId).task.findFirst({ where: { id: taskId }, select: { id: true, name: true } });
    if (!task) throw new NotFoundException({ code: 'TASK_NOT_FOUND', message: 'Task not found' });
    const there = await this.prisma.chatMessage.findFirst({ where: { conversationId: c.id, role: 'system', meta: { path: ['taskId'], equals: task.id } } });
    if (there) return messageView(there);
    return this.append(c.id, { role: 'system', kind: 'text', text: `Saved as the task "${task.name}".`, meta: { taskId: task.id } });
  }

  /**
   * Append a message with the conversation's next `seq`. The counter is bumped
   * by the same UPDATE that reserves the number, under the row's lock, so
   * concurrent appends never share a `seq`. The caller has already established
   * that the conversation is the user's.
   *
   * `onceForRun`: write the message only if the conversation has none of its
   * kind for its run yet (a run's result is written once, whoever notices the
   * run ended). Checked under the same row lock; answers null when it exists.
   */
  async append(conversationId: string, message: NewChatMessage, opts?: { title?: string }): Promise<ChatMessageView>;
  async append(conversationId: string, message: NewChatMessage, opts: { title?: string; onceForRun: true }): Promise<ChatMessageView | null>;
  async append(conversationId: string, message: NewChatMessage, opts: { title?: string; onceForRun?: boolean } = {}): Promise<ChatMessageView | null> {
    const row = await this.prisma.$transaction(async (tx) => {
      const now = new Date();
      if (opts.onceForRun && message.runId) {
        // Take the conversation's row lock first, so two writers of the same result queue up here.
        // (A no-op UPDATE: it locks the row like SELECT ... FOR UPDATE, without raw SQL.)
        await tx.conversation.update({ where: { id: conversationId }, data: { nextSeq: { increment: 0 } }, select: { id: true } });
        const there = await tx.chatMessage.count({ where: { conversationId, runId: message.runId, kind: message.kind ?? 'text' } });
        if (there > 0) return null;
      }
      const c = await tx.conversation.update({
        where: { id: conversationId },
        data: { nextSeq: { increment: 1 }, lastMessageAt: now, ...(opts.title ? { title: opts.title } : {}) },
        select: { nextSeq: true },
      });
      return tx.chatMessage.create({
        data: {
          conversationId,
          seq: c.nextSeq - 1,
          role: message.role,
          kind: message.kind ?? 'text',
          text: message.text ?? '',
          runId: message.runId ?? null,
          ...(message.meta !== undefined ? { meta: message.meta } : {}),
          createdAt: now,
        },
      });
    });
    return row ? messageView(row) : null;
  }
}
