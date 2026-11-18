// Memory proposals (#553): the agent suggests a fact worth keeping, the owner
// decides on a card. A proposal is a non-blocking question of input `memory`
// (questions.contract.ts); only the question's answer handler writes the
// memory, through `MemoriesService`, so the secret check, the label rule and
// the limit apply to what the owner saves. Nothing here writes a memory.
import { createHash } from 'node:crypto';

import { Injectable, Logger } from '@nestjs/common';
import type { Prisma } from '@prisma/client';

import { PrismaService } from '../prisma/prisma.service';
import { memoryProposalSchema, type MemoryProposal } from '../questions/questions.contract';
import { QuestionsService } from '../questions/questions.service';
import { findMemorySecrets, MEMORY_SECRET_HINT } from './memory-secrets';
import { memorySettingsOf } from './memories.settings';

/** How long a declined proposal is not made again. */
export const DECLINED_SUPPRESS_MS = 30 * 24 * 3600_000;

/** Where a proposal comes from: a chat (the orchestrator) or a run (the goal runner). */
export interface ProposalOrigin {
  runId?: string | null;
  conversationId?: string | null;
}

/** What `propose` tells the model. `questionId` when a card was made. */
export interface ProposalResult {
  proposed: boolean;
  message: string;
  questionId?: string;
}

/** The key of "the same proposal": its kind and its label, ignoring case and spacing. */
export function proposalKey(kind: string, label: string): string {
  return createHash('sha256').update(`${kind}\u0000${label.trim().toLowerCase().replace(/\s+/g, ' ')}`).digest('hex');
}

/** A value as compared with what the owner wrote: lower-case, without spaces and the punctuation of phone numbers. */
function squash(v: string): string {
  return v.toLowerCase().replace(/[\s().\-+_/,]/g, '');
}

/** A value that identifies someone or something (a number of four digits or more, an email): it must come from the owner. */
function identifying(v: string): boolean {
  return /@/.test(v) || (v.match(/\d/g)?.length ?? 0) >= 4;
}

/**
 * Whether a proposal the goal runner makes is backed by what the owner said
 * (#553): at least one of its values appears in the owner's own answers, and
 * every identifying value (a number of four or more digits, an email) does.
 * A proposal built from page text fails: a page cannot plant a memory.
 */
export function ownerBacked(attributes: Record<string, string>, ownerTexts: readonly string[]): boolean {
  const said = ownerTexts.map(squash).filter(Boolean);
  const found = (v: string) => {
    const s = squash(v);
    return s.length > 0 && said.some((t) => t.includes(s));
  };
  const values = Object.values(attributes).map(String);
  if (values.length === 0 || !values.some(found)) return false;
  return values.filter(identifying).every(found);
}

function sameValues(a: Record<string, string>, b: Record<string, string>): boolean {
  const ka = Object.keys(a).sort();
  const kb = Object.keys(b).sort();
  return ka.length === kb.length && ka.every((k, i) => k === kb[i] && String(a[k]).trim() === String(b[k]).trim());
}

@Injectable()
export class MemoryProposals {
  private readonly log = new Logger(MemoryProposals.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly questions: QuestionsService,
  ) {}

  /** Whether the owner lets the agent suggest memories (`memories.suggest`, on by default). */
  async suggestionsOn(userId: string): Promise<boolean> {
    const row = await this.prisma.userSettings.findUnique({ where: { userId }, select: { value: true } });
    return memorySettingsOf(row?.value).suggest;
  }

  /**
   * Proposes a memory: a card the owner answers when they like. Refused (with
   * the reason, for the model) when suggestions are off, the proposal is not
   * valid, it holds Secret Material, the owner declined the same one in the
   * last 30 days, the same one is already waiting, or it is already
   * remembered with the same values. A label the owner already uses becomes
   * a proposal to replace that memory's values.
   */
  async propose(userId: string, raw: unknown, origin: ProposalOrigin): Promise<ProposalResult> {
    if (!(await this.suggestionsOn(userId))) return { proposed: false, message: 'The owner turned suggestions off. Do not propose memories.' };
    const parsed = memoryProposalSchema.safeParse(raw);
    if (!parsed.success) return { proposed: false, message: `Invalid proposal: ${parsed.error.issues.map((i) => `${i.path.join('.') || 'proposal'}: ${i.message}`).join('; ')}` };
    const proposal: MemoryProposal = { ...parsed.data, aliases: [...new Set(parsed.data.aliases.map((a) => a.toLowerCase().replace(/\s+/g, ' ')))] };
    if (findMemorySecrets(proposal).length > 0) return { proposed: false, message: `Refused: ${MEMORY_SECRET_HINT}` };

    const db = this.prisma.forUser({ userId });
    if (proposal.supersedes) {
      const old = await db.memory.findFirst({ where: { id: proposal.supersedes, status: 'active' }, select: { id: true } });
      if (!old) return { proposed: false, message: 'Refused: supersedes names no active memory of the owner.' };
    } else {
      const same = await db.memory.findFirst({ where: { status: 'active', kind: proposal.kind, label: { equals: proposal.label, mode: 'insensitive' } } });
      if (same) {
        if (sameValues((same.attributes ?? {}) as Record<string, string>, proposal.attributes)) return { proposed: false, message: 'Already remembered: nothing to propose.' };
        proposal.supersedes = same.id;
      }
    }

    const key = proposalKey(proposal.kind, proposal.label);
    const since = new Date(Date.now() - DECLINED_SUPPRESS_MS);
    const declined = await db.question.findFirst({ where: { input: 'memory', proposalKey: key, status: 'cancelled', answeredAt: { gt: since } }, select: { id: true } });
    if (declined) return { proposed: false, message: 'The owner declined this recently. Do not propose it again.' };
    const waiting = await db.question.findFirst({ where: { input: 'memory', proposalKey: key, status: 'pending', expiresAt: { gt: new Date() } }, select: { id: true } });
    if (waiting) return { proposed: false, message: 'Already proposed: it waits for the owner.', questionId: waiting.id };

    const q = await this.questions.createProposal(userId, proposal, {
      askedBy: origin.runId ? `run:${origin.runId}` : origin.conversationId ? `chat:${origin.conversationId}` : `user:${userId}`,
      proposalKey: key,
      runId: origin.runId ?? null,
      conversationId: origin.conversationId ?? null,
    });
    // In a chat, the card is a message of the thread.
    if (origin.conversationId) await this.appendCard(origin.conversationId, q.id, proposal.label);
    this.log.log(`memory proposal ${q.id} (${proposal.kind}${proposal.supersedes ? ', supersede' : ''})`);
    return { proposed: true, message: 'Proposed; the owner decides.', questionId: q.id };
  }

  /** The thread message that shows the card (`kind: memory`, `meta.questionId`), as `ChatService.append` writes one. */
  private async appendCard(conversationId: string, questionId: string, label: string): Promise<void> {
    await this.prisma.$transaction(async (tx) => {
      const now = new Date();
      const c = await tx.conversation.update({ where: { id: conversationId }, data: { nextSeq: { increment: 1 }, lastMessageAt: now }, select: { nextSeq: true } });
      await tx.chatMessage.create({
        data: { conversationId, seq: c.nextSeq - 1, role: 'assistant', kind: 'memory', text: `Suggested remembering: ${label}`.slice(0, 8000), meta: { questionId } as Prisma.InputJsonValue, createdAt: now },
      });
    });
  }
}
