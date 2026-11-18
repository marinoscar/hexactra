import { Injectable, Logger, NotFoundException } from '@nestjs/common';
import { AiService } from '@marinoscar/platform-api/ai';
import type { Conversation } from '@prisma/client';

import { PrismaService } from '../prisma/prisma.service';
import { CHAT_ORCHESTRATOR_FEATURE_ID } from './chat-orchestrator.feature';
import { ChatService, titleFromMessage } from './chat.service';
import { transcriptLine } from './chat-transcript';

/** A task drafted from a chat: what `POST /tasks` takes, for the owner to review before saving. */
export interface ChatTaskDraft {
  name: string;
  goal: string;
  profile: string;
  hostId: string | null;
  hostFallback: boolean;
  policyId: string | null;
  allowedDomains: string[];
  confirmRiskyActions: boolean;
}

const NAME_MAX = 200;
const GOAL_MAX = 4000;
/** How much of the thread the draft is written from. */
const HISTORY_MESSAGES = 60;

export const TASK_DRAFT_INSTRUCTIONS = [
  'You turn a conversation between an owner and their browser agent into ONE reusable task for that agent.',
  'Write the goal as a complete, standalone instruction: someone who never saw the conversation must be able to run it. Fold in what the owner clarified, the choices they made and what turned out to work. Leave out one-off details that would be wrong next time (a specific date that has passed, an order number), or say how to choose them ("the next Saturday").',
  'Never include a password, a code, a card number or any other secret, and never invent facts the conversation does not contain.',
  'Answer with JSON only, no prose and no code fence: {"name": "<a short name, at most 60 characters>", "goal": "<the instruction, at most 3000 characters>"}',
].join('\n');

/** The `{ name, goal }` of a model answer, or null when it is not that. */
export function parseDraft(text: string): { name: string; goal: string } | null {
  const start = text.indexOf('{');
  const end = text.lastIndexOf('}');
  if (start < 0 || end <= start) return null;
  try {
    const value = JSON.parse(text.slice(start, end + 1)) as { name?: unknown; goal?: unknown };
    if (typeof value.goal !== 'string' || !value.goal.trim()) return null;
    return { name: typeof value.name === 'string' ? value.name.trim() : '', goal: value.goal.trim() };
  } catch {
    return null;
  }
}

/**
 * Drafts a reusable task from a chat (#489). The model writes the name and
 * the goal from the thread; everything else is the chat's own run settings.
 * It reads chat messages only (`transcriptLine`), so no question's answer and
 * no secret can reach the model or the draft. When the model gives nothing
 * usable, the draft falls back to the goal of the chat's newest run, so the
 * owner always gets a form to edit.
 */
@Injectable()
export class ChatTaskDraftService {
  private readonly log = new Logger(ChatTaskDraftService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly ai: AiService,
  ) {}

  /** What the model reads: the end of the thread, oldest first. */
  async buildInput(conversationId: string): Promise<string> {
    const rows = await this.prisma.chatMessage.findMany({ where: { conversationId }, orderBy: { seq: 'desc' }, take: HISTORY_MESSAGES, select: { role: true, kind: true, text: true, meta: true } });
    return ['Conversation, oldest first:', ...rows.reverse().map(transcriptLine)].join('\n');
  }

  private async fallback(c: Conversation): Promise<{ name: string; goal: string }> {
    const run = await this.prisma.forUser({ userId: c.userId }).run.findFirst({ where: { conversationId: c.id }, orderBy: { createdAt: 'desc' }, select: { goal: true } });
    const first = run ? null : await this.prisma.chatMessage.findFirst({ where: { conversationId: c.id, role: 'user' }, orderBy: { seq: 'asc' }, select: { text: true } });
    return { name: c.title, goal: run?.goal ?? first?.text ?? '' };
  }

  async draft(userId: string, conversationId: string, orgId: string | null): Promise<ChatTaskDraft> {
    const c = await this.prisma.forUser({ userId }).conversation.findFirst({ where: { id: conversationId } });
    if (!c) throw new NotFoundException({ code: 'CHAT_NOT_FOUND', message: 'Chat not found' });
    let written: { name: string; goal: string } | null = null;
    try {
      const response = await this.ai.forUser(userId, { feature: CHAT_ORCHESTRATOR_FEATURE_ID, ...(orgId ? { orgId } : {}) }).respond({ instructions: TASK_DRAFT_INSTRUCTIONS, input: await this.buildInput(c.id) });
      written = parseDraft(response.outputText ?? '');
    } catch (e) {
      // No model, or it failed: the owner still gets a draft to edit, from what the chat already holds.
      this.log.warn(`chat ${c.id}: the task draft falls back to the run's goal: ${e instanceof Error ? e.message : String(e)}`);
    }
    const base = written ?? (await this.fallback(c));
    return {
      name: (base.name || titleFromMessage(base.goal) || c.title || 'Task from a chat').slice(0, NAME_MAX),
      goal: base.goal.slice(0, GOAL_MAX),
      profile: c.profile,
      hostId: c.hostId,
      hostFallback: c.hostFallback,
      policyId: c.policyRef,
      allowedDomains: c.allowedDomains,
      confirmRiskyActions: c.confirmRiskyActions,
    };
  }
}
