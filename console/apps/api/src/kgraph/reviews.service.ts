// Reviews of sensitive repairs (E46.17): a repaired version that adds or changes a send, a payment, a recipient, a site, an account or a
// credential waits here for the owner. It never pauses a run: the task keeps its old version, or runs with AI. Approve or decline only in
// the signed-in console: the answer route refuses a personal access token, an OAuth app (MCP, hosted AI apps), a node credential, and there
// is no webhook or MCP tool for it. A declined change is not proposed again for 30 days; a review expires after 7 days (not approved).
// Approval grants nothing at run time: the version still passes every gate on every run.
import { ConflictException, ForbiddenException, Injectable, NotFoundException } from '@nestjs/common';
import type { Prisma } from '@prisma/client';
import type { Classification } from '@marinoscar/hexactra-kgraph';

import { PrismaService } from '../prisma/prisma.service';
import { maskSensitive } from '../tasks/mask';
import { PrismaProcedureStore } from './prisma-procedure-store';

export const REVIEW_TTL_MS = 7 * 24 * 3600_000;
export const DECLINE_SUPPRESS_MS = 30 * 24 * 3600_000;

/** The same change, for "not again within 30 days": the procedure and the sorted reasons. */
export const changeSignature = (procedureId: string, c: Classification) => `${procedureId}|${[...new Set(c.reasons.map((r) => `${r.reason}:${r.detail}`))].sort().join('|')}`.slice(0, 2000);

@Injectable()
export class KgraphReviewsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly store: PrismaProcedureStore,
  ) {}

  /** Whether the same change was declined in the last 30 days (then it is not proposed again). */
  async recentlyDeclined(userId: string, signature: string, now = new Date()): Promise<boolean> {
    const rows = await this.prisma.forUser({ userId }).kgReview.findMany({ where: { userId, status: 'declined', updatedAt: { gt: new Date(now.getTime() - DECLINE_SUPPRESS_MS) } }, select: { summary: true } });
    return rows.some((r) => (r.summary as { signature?: string } | null)?.signature === signature);
  }

  /** Open a review for a stored sensitive version. Plain words, masked; no typed value. */
  async open(userId: string, versionId: string, procedureId: string, c: Classification): Promise<string> {
    const changes = c.reasons.map((r) => ({ reason: r.reason, text: maskSensitive(r.detail).text.slice(0, 300), ...(r.step ? { step: r.step } : {}) }));
    const row = await this.prisma.forUser({ userId }).kgReview.create({ data: { userId, versionId, summary: { procedureId, signature: changeSignature(procedureId, c), changes } as unknown as Prisma.InputJsonValue } });
    return row.id;
  }

  private async expire(userId: string): Promise<void> {
    const old = await this.prisma.forUser({ userId }).kgReview.findMany({ where: { userId, status: 'pending', createdAt: { lt: new Date(Date.now() - REVIEW_TTL_MS) } }, select: { id: true, versionId: true } });
    for (const r of old) {
      await this.prisma.forUser({ userId }).kgReview.updateMany({ where: { id: r.id, status: 'pending' }, data: { status: 'expired' } });
      await this.store.setVersionState(userId, r.versionId, 'candidate', 'retired');
    }
  }

  async list(userId: string, status?: string) {
    await this.expire(userId);
    const rows = await this.prisma.forUser({ userId }).kgReview.findMany({ where: { userId, ...(status ? { status } : {}) }, orderBy: { createdAt: 'desc' }, take: 200 });
    return rows.map(view);
  }

  async get(userId: string, id: string) {
    await this.expire(userId);
    const r = await this.prisma.forUser({ userId }).kgReview.findFirst({ where: { id, userId } });
    if (!r) throw new NotFoundException({ code: 'KGRAPH_REVIEW_NOT_FOUND', message: 'Review not found' });
    return view(r);
  }

  /** The owner's answer, from a signed-in browser session only. */
  async answer(userId: string, id: string, approve: boolean, credentialKind: string | null | undefined) {
    if (credentialKind !== 'session') throw new ForbiddenException({ code: 'KGRAPH_REVIEW_CONSOLE_ONLY', message: 'A Knowledge Graph review is answered only by the owner, signed in to the console' });
    await this.expire(userId);
    const r = await this.prisma.forUser({ userId }).kgReview.findFirst({ where: { id, userId } });
    if (!r) throw new NotFoundException({ code: 'KGRAPH_REVIEW_NOT_FOUND', message: 'Review not found' });
    const moved = await this.prisma.forUser({ userId }).kgReview.updateMany({ where: { id, userId, status: 'pending' }, data: { status: approve ? 'approved' : 'declined' } });
    if (moved.count !== 1) throw new ConflictException({ code: 'KGRAPH_REVIEW_ANSWERED', message: 'This review was already answered or expired' });
    // Declined: the version retires. Approved: it stays a candidate; its next run verifies it (asking before every commit step), then it is active.
    if (!approve) await this.store.setVersionState(userId, r.versionId, 'candidate', 'retired');
    await this.prisma.auditEvent.create({ data: { actorUserId: userId, action: approve ? 'kgraph.review.approved' : 'kgraph.review.declined', targetType: 'kgraph_review', targetId: id, meta: { reviewId: id, versionId: r.versionId } } }).catch(() => undefined);
    return this.get(userId, id);
  }
}

function view(r: { id: string; versionId: string; status: string; summary: Prisma.JsonValue; createdAt: Date }) {
  const s = (r.summary ?? {}) as { procedureId?: string; changes?: { reason: string; text: string }[] };
  return { id: r.id, versionId: r.versionId, procedureId: s.procedureId ?? null, status: r.status, changes: (s.changes ?? []).map((c) => ({ reason: c.reason, text: c.text })), createdAt: r.createdAt.toISOString(), expiresAt: new Date(r.createdAt.getTime() + REVIEW_TTL_MS).toISOString() };
}
