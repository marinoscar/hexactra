import { BadRequestException, ConflictException, Injectable, NotFoundException } from '@nestjs/common';
import type { Conversation, Prisma } from '@prisma/client';

import { ChatService, type ChatMessageView } from '../chat/chat.service';
import { PrismaService } from '../prisma/prisma.service';
import './task-builder.errors';
import { TaskBuilderTurnQueue } from './task-builder-turn.enqueue';
import { mergeSpec, readSpec, taskBuilderSpecSchema, type TaskBuilderSpec, type TaskBuilderSpecPatch } from './task-builder.spec.schema';

/** A task builder as the API answers it. */
export interface TaskBuilderView {
  id: string;
  title: string;
  status: Conversation['status'];
  spec: TaskBuilderSpec;
  createdAt: Date;
  updatedAt: Date;
}

export interface TaskBuilderDetail extends TaskBuilderView {
  messages: ChatMessageView[];
  hasMore: boolean;
  /** True while the builder is working on its reply. */
  thinking: boolean;
}

interface Principal {
  id: string;
  activeOrgId?: string | null;
}

const notFound = () => new NotFoundException({ code: 'TASK_BUILDER_NOT_FOUND', message: 'Task builder not found' });
const archived = () => new ConflictException({ code: 'TASK_BUILDER_ARCHIVED', message: 'This task builder is archived. Start a new one' });

function view(c: Conversation): TaskBuilderView {
  return { id: c.id, title: c.title, status: c.status, spec: readSpec(c.builderSpec), createdAt: c.createdAt, updatedAt: c.updatedAt };
}

/**
 * The task builder (E42, #717): a conversation in `task_builder` mode whose
 * turns interview the owner and keep a live task spec. It reuses the chat's
 * messages, lease and stream; it never starts a run, never saves a task and
 * never appears in the chat list. Every query is the caller's own
 * (`forUser`), and a chat is "not found" here as another user's builder is.
 */
@Injectable()
export class TaskBuilderService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly chats: ChatService,
    private readonly turns: TaskBuilderTurnQueue,
  ) {}

  private db(userId: string) {
    return this.prisma.forUser({ userId });
  }

  async owned(userId: string, id: string): Promise<Conversation> {
    const c = await this.db(userId).conversation.findFirst({ where: { id, mode: 'task_builder' } });
    if (!c) throw notFound();
    return c;
  }

  /** A new builder with an empty spec. With a seed, it is the first owner message and the builder answers it. */
  async create(user: Principal, input: { seed?: string }): Promise<TaskBuilderView> {
    // No run settings and no connections: a builder never runs anything (the task form holds those).
    const c = await this.db(user.id).conversation.create({ data: { userId: user.id, mode: 'task_builder', builderSpec: {}, confirmRiskyActions: false } });
    if (input.seed) await this.postMessage(user, c.id, input.seed);
    return view(await this.owned(user.id, c.id));
  }

  async get(userId: string, id: string, afterSeq = 0): Promise<TaskBuilderDetail> {
    const c = await this.owned(userId, id);
    const detail = await this.chats.get(userId, c.id, afterSeq);
    return { ...view(c), messages: detail.messages, hasMore: detail.hasMore, thinking: detail.thinking };
  }

  /** The owner's message; the builder's reply arrives as later messages (a `task_builder.turn` job). */
  async postMessage(user: Principal, id: string, text: string): Promise<ChatMessageView> {
    const c = await this.owned(user.id, id);
    if (c.status === 'archived') throw archived();
    const message = await this.chats.postUserMessage(user.id, c.id, text);
    await this.turns.request(c.id, user.id, user.activeOrgId ?? null);
    return message;
  }

  /**
   * Apply a change to the spec, under the conversation's row lock so the owner's edit and the builder's never
   * lose each other. The merged spec must pass `taskBuilderSpecSchema` (400 `INVALID_TASK_SPEC`).
   */
  async patchSpec(userId: string, id: string, patch: TaskBuilderSpecPatch): Promise<TaskBuilderSpec> {
    const c = await this.owned(userId, id);
    if (c.status === 'archived') throw archived();
    return this.prisma.$transaction(async (tx) => {
      const locked = await tx.conversation.update({ where: { id: c.id }, data: { nextSeq: { increment: 0 } }, select: { builderSpec: true } });
      const merged = taskBuilderSpecSchema.safeParse(mergeSpec(readSpec(locked.builderSpec), patch));
      if (!merged.success) {
        throw new BadRequestException({ code: 'INVALID_TASK_SPEC', message: 'The task spec does not pass its checks', details: merged.error.issues.map((i) => ({ path: i.path.join('.'), message: i.message })) });
      }
      await tx.conversation.update({ where: { id: c.id }, data: { builderSpec: merged.data as Prisma.InputJsonValue } });
      return merged.data;
    });
  }
}
