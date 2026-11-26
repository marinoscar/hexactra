// The history of diagnostics (E50.10, #980): the last {@link KEEP_PER_TARGET} reports per target in `connection_diagnostics`. A write
// deletes the older rows of its target in the same transaction. An owner's reports are read through `PrismaService.forUser`, so another
// user's are never seen. Rows hold only what `sanitizeStages` let through.
import { Injectable } from '@nestjs/common';
import type { ConnectionDiagnostic, Prisma } from '@prisma/client';
import { z } from 'zod';

import { PrismaService } from '../prisma/prisma.service';
import { diagnosticStageSchema, type DiagnosticReport, type DiagnosticTargetKind, type DiagnosticTrigger, type StageStatus } from './diagnostic-report';

export const KEEP_PER_TARGET = 20;
export const DEFAULT_HISTORY = 5;

export interface StoredDiagnosticReport extends DiagnosticReport {
  id: string;
}

export interface DiagnosticSummary {
  targetId: string;
  overall: StageStatus;
  at: string;
}

const stagesSchema = z.array(diagnosticStageSchema);

function toReport(row: ConnectionDiagnostic): StoredDiagnosticReport {
  const stages = stagesSchema.safeParse(row.stages);
  return {
    id: row.id,
    target: { kind: row.targetKind as DiagnosticTargetKind, id: row.targetId },
    trigger: row.trigger as DiagnosticTrigger,
    overall: row.overall as StageStatus,
    startedAt: row.startedAt.toISOString(),
    finishedAt: row.createdAt.toISOString(),
    stages: stages.success ? stages.data : [],
  };
}

@Injectable()
export class DiagnosticsHistory {
  constructor(private readonly prisma: PrismaService) {}

  /**
   * Stores a report (already sanitized) and keeps only the last {@link KEEP_PER_TARGET} of its target AND owner: a search provider's
   * id is shared by every user and the deployment (E50.13), so one owner's reports never push out another's.
   */
  async record(report: DiagnosticReport, userId: string | null): Promise<StoredDiagnosticReport> {
    const { kind, id: targetId } = report.target;
    const row = await this.prisma.$transaction(async (tx) => {
      const created = await tx.connectionDiagnostic.create({
        data: {
          userId,
          targetKind: kind,
          targetId,
          overall: report.overall,
          stages: report.stages as unknown as Prisma.InputJsonValue,
          trigger: report.trigger,
          startedAt: new Date(report.startedAt),
          createdAt: new Date(report.finishedAt),
        },
      });
      const keep = await tx.connectionDiagnostic.findMany({ where: { targetKind: kind, targetId, userId }, orderBy: [{ createdAt: 'desc' }, { id: 'desc' }], take: KEEP_PER_TARGET, select: { id: true } });
      await tx.connectionDiagnostic.deleteMany({ where: { targetKind: kind, targetId, userId, id: { notIn: keep.map((k) => k.id) } } });
      return created;
    });
    return toReport(row);
  }

  /** The owner's last reports of one target, newest first. */
  async list(userId: string, kind: DiagnosticTargetKind, targetId: string, limit = DEFAULT_HISTORY): Promise<StoredDiagnosticReport[]> {
    const rows = await this.prisma.forUser({ userId }).connectionDiagnostic.findMany({
      where: { targetKind: kind, targetId },
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      take: Math.min(Math.max(1, limit), KEEP_PER_TARGET),
    });
    return rows.map(toReport);
  }

  /** The owner's last reports of every target of one kind (a user's search providers), newest first. */
  async listOfKind(userId: string, kind: DiagnosticTargetKind, limit = DEFAULT_HISTORY): Promise<StoredDiagnosticReport[]> {
    const rows = await this.prisma.forUser({ userId }).connectionDiagnostic.findMany({
      where: { targetKind: kind },
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      take: Math.min(Math.max(1, limit), KEEP_PER_TARGET),
    });
    return rows.map(toReport);
  }

  /** The deployment's last reports of one target (no owner: a provider's app, a search provider's deployment tier), newest first. */
  async listDeployment(kind: DiagnosticTargetKind, targetId: string, limit = DEFAULT_HISTORY): Promise<StoredDiagnosticReport[]> {
    const rows = await this.prisma.connectionDiagnostic.findMany({
      where: { targetKind: kind, targetId, userId: null },
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      take: Math.min(Math.max(1, limit), KEEP_PER_TARGET),
    });
    return rows.map(toReport);
  }

  /** The deployment's last report of one target, or null: what Doctor reads (read-only; one query). */
  async lastDeployment(kind: DiagnosticTargetKind, targetId: string): Promise<DiagnosticSummary | null> {
    const row = await this.prisma.connectionDiagnostic.findFirst({
      where: { targetKind: kind, targetId, userId: null },
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      select: { targetId: true, overall: true, createdAt: true },
    });
    return row ? { targetId: row.targetId, overall: row.overall as StageStatus, at: row.createdAt.toISOString() } : null;
  }

  /**
   * How many of these targets' last reports (any owner) are `fail` and `warn`: a count for Doctor, never who or which. One query.
   */
  async lastOverallCounts(kind: DiagnosticTargetKind, targetIds: readonly string[]): Promise<{ fail: number; warn: number }> {
    if (targetIds.length === 0) return { fail: 0, warn: 0 };
    const rows = await this.prisma.connectionDiagnostic.findMany({
      where: { targetKind: kind, targetId: { in: [...targetIds] } },
      distinct: ['targetId'],
      orderBy: [{ targetId: 'asc' }, { createdAt: 'desc' }],
      select: { overall: true },
    });
    return { fail: rows.filter((r) => r.overall === 'fail').length, warn: rows.filter((r) => r.overall === 'warn').length };
  }

  /** For each of the owner's targets of this kind: the last overall status and time. One query. */
  async summary(userId: string, kind: DiagnosticTargetKind): Promise<DiagnosticSummary[]> {
    const rows = await this.prisma.forUser({ userId }).connectionDiagnostic.findMany({
      where: { targetKind: kind },
      distinct: ['targetId'],
      orderBy: [{ targetId: 'asc' }, { createdAt: 'desc' }],
      select: { targetId: true, overall: true, createdAt: true },
    });
    return rows.map((r) => ({ targetId: r.targetId, overall: r.overall as StageStatus, at: r.createdAt.toISOString() }));
  }

  /** Deletes every report of a target (a removed connection). */
  async deleteTarget(kind: DiagnosticTargetKind, targetId: string): Promise<number> {
    return (await this.prisma.connectionDiagnostic.deleteMany({ where: { targetKind: kind, targetId } })).count;
  }
}
