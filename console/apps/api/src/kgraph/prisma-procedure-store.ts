// The console's binding of the Knowledge Graph's ProcedureStorePort (E46.3, #777): PostgreSQL `kg_` tables through `PrismaService.forUser`.
// Every read and write is scoped to one owner; another user's id answers as not found. A version's `graph` column holds the package's
// ProcedureVersion without its state and evidence (columns and kg_evidence rows). It passes `runStoreConformance` (test/kgraph-store.db.spec.ts).
import { Injectable } from '@nestjs/common';
import type { Prisma } from '@prisma/client';
import { canTransition, emptyEvidence, procedureVersionSchema, type Evidence, type EvidenceOutcome, type Procedure, type ProcedureStorePort, type ProcedureVersion, type VersionState } from '@marinoscar/hexactra-kgraph';

import { PrismaService } from '../prisma/prisma.service';

type ProcedureRow = { id: string; userId: string; taskId: string; name: string; activeVersionId: string | null; createdAt: Date; updatedAt: Date };
type EvidenceRow = { stepId: string; successes: number; failures: number; repairs: number; lastSuccessAt: Date | null; lastFailureAt: Date | null };
type VersionRow = { id: string; procedureId: string; seq: number; state: string; graph: Prisma.JsonValue; changeClass: string; sourceRunId: string | null; parentVersionId: string | null; createdAt: Date; evidence: EvidenceRow[] };

const toProcedure = (r: ProcedureRow): Procedure => ({ id: r.id, owner: r.userId, task: r.taskId, name: r.name, activeVersion: r.activeVersionId, createdAt: r.createdAt.toISOString(), updatedAt: r.updatedAt.toISOString() });
const toEvidence = (e: EvidenceRow | undefined): Evidence =>
  e ? { successes: e.successes, failures: e.failures, repairs: e.repairs, lastSuccessAt: e.lastSuccessAt?.toISOString() ?? null, lastFailureAt: e.lastFailureAt?.toISOString() ?? null } : emptyEvidence();

function toVersion(r: VersionRow): ProcedureVersion {
  const graph = (r.graph ?? {}) as Record<string, unknown>;
  const stepEvidence: Record<string, Evidence> = {};
  for (const e of r.evidence) if (e.stepId !== '') stepEvidence[e.stepId] = toEvidence(e);
  return procedureVersionSchema.parse({
    ...graph,
    id: r.id,
    procedure: r.procedureId,
    number: r.seq,
    state: r.state,
    changeClass: r.changeClass,
    sourceRun: r.sourceRunId,
    parent: r.parentVersionId,
    createdAt: r.createdAt.toISOString(),
    evidence: toEvidence(r.evidence.find((e) => e.stepId === '')),
    stepEvidence,
  });
}

/** The graph column: everything but the fields that are columns, the state and the evidence. */
function graphOf(v: ProcedureVersion): Prisma.InputJsonValue {
  const { id: _id, procedure: _p, number: _n, state: _s, changeClass: _c, sourceRun: _r, parent: _pa, createdAt: _at, evidence: _e, stepEvidence: _se, ...graph } = v;
  return graph as unknown as Prisma.InputJsonValue;
}

@Injectable()
export class PrismaProcedureStore implements ProcedureStorePort {
  constructor(private readonly prisma: PrismaService) {}

  private db(owner: string) {
    return this.prisma.forUser({ userId: owner });
  }

  async getProcedure(owner: string, id: string): Promise<Procedure | null> {
    const r = await this.db(owner).kgProcedure.findFirst({ where: { id, userId: owner } });
    return r ? toProcedure(r) : null;
  }

  async findProcedureForTask(owner: string, task: string): Promise<Procedure | null> {
    const r = await this.db(owner).kgProcedure.findFirst({ where: { taskId: task, userId: owner } });
    return r ? toProcedure(r) : null;
  }

  async listProcedures(owner: string): Promise<Procedure[]> {
    return (await this.db(owner).kgProcedure.findMany({ where: { userId: owner }, orderBy: { createdAt: 'asc' } })).map(toProcedure);
  }

  async putProcedure(p: Procedure): Promise<void> {
    const db = this.db(p.owner);
    const existing = await this.prisma.kgProcedure.findUnique({ where: { id: p.id }, select: { userId: true } });
    if (existing && existing.userId !== p.owner) throw new Error('procedure belongs to another owner');
    // The task must be the owner's own.
    const task = await db.task.findFirst({ where: { id: p.task, userId: p.owner }, select: { id: true } });
    if (!task) throw new Error('task not found for this owner');
    await db.kgProcedure.upsert({
      where: { id: p.id },
      create: { id: p.id, userId: p.owner, taskId: p.task, name: p.name, activeVersionId: p.activeVersion, createdAt: new Date(p.createdAt) },
      update: { name: p.name, activeVersionId: p.activeVersion },
    });
  }

  async getVersion(owner: string, id: string): Promise<ProcedureVersion | null> {
    const r = await this.db(owner).kgProcedureVersion.findFirst({ where: { id, userId: owner }, include: { evidence: true } });
    return r ? toVersion(r) : null;
  }

  async listVersions(owner: string, procedure: string): Promise<ProcedureVersion[]> {
    const rows = await this.db(owner).kgProcedureVersion.findMany({ where: { procedureId: procedure, userId: owner }, include: { evidence: true }, orderBy: { seq: 'desc' } });
    return rows.map(toVersion);
  }

  async putVersion(owner: string, v: ProcedureVersion): Promise<void> {
    const db = this.db(owner);
    const p = await db.kgProcedure.findFirst({ where: { id: v.procedure, userId: owner }, select: { id: true } });
    if (!p) throw new Error('procedure not found for this owner');
    // `create` fails on an existing id: versions are immutable.
    await db.kgProcedureVersion.create({
      data: { id: v.id, userId: owner, procedureId: v.procedure, seq: v.number, state: v.state, graph: graphOf(v), changeClass: v.changeClass, sourceRunId: v.sourceRun, parentVersionId: v.parent, createdAt: new Date(v.createdAt) },
    });
  }

  async setVersionState(owner: string, version: string, expected: VersionState, next: VersionState): Promise<boolean> {
    if (!canTransition(expected, next)) return false;
    const r = await this.db(owner).kgProcedureVersion.updateMany({ where: { id: version, userId: owner, state: expected }, data: { state: next } });
    return r.count === 1;
  }

  async activate(owner: string, version: string, from: 'candidate' | 'verified' | 'suspended'): Promise<boolean> {
    if (from !== 'candidate' && !canTransition(from, 'active')) return false;
    return this.prisma.$transaction(async (tx) => {
      const v = await tx.kgProcedureVersion.findFirst({ where: { id: version, userId: owner }, select: { procedureId: true } });
      if (!v) return false;
      // Compare-and-set on the current state: of two jobs racing, one moves it and the other changes nothing.
      const moved = await tx.kgProcedureVersion.updateMany({ where: { id: version, userId: owner, state: from }, data: { state: 'active' } });
      if (moved.count !== 1) return false;
      await tx.kgProcedureVersion.updateMany({ where: { procedureId: v.procedureId, userId: owner, state: 'active', NOT: { id: version } }, data: { state: 'retired' } });
      await tx.kgProcedure.updateMany({ where: { id: v.procedureId, userId: owner }, data: { activeVersionId: version } });
      return true;
    });
  }

  async recordEvidence(owner: string, version: string, step: string | null, outcome: EvidenceOutcome, at: string): Promise<Evidence> {
    const db = this.db(owner);
    const v = await db.kgProcedureVersion.findFirst({ where: { id: version, userId: owner }, select: { id: true } });
    if (!v) throw new Error('version not found for this owner');
    const when = new Date(at);
    const inc = outcome === 'success' ? { successes: { increment: 1 }, lastSuccessAt: when } : outcome === 'failure' ? { failures: { increment: 1 }, lastFailureAt: when } : { repairs: { increment: 1 } };
    const start = { successes: outcome === 'success' ? 1 : 0, failures: outcome === 'failure' ? 1 : 0, repairs: outcome === 'repair' ? 1 : 0, lastSuccessAt: outcome === 'success' ? when : null, lastFailureAt: outcome === 'failure' ? when : null };
    const keys = step === null ? [''] : ['', step];
    let versionEvidence: EvidenceRow | undefined;
    for (const stepId of keys) {
      const row = await db.kgEvidence.upsert({ where: { versionId_stepId: { versionId: version, stepId } }, create: { userId: owner, versionId: version, stepId, ...start }, update: inc });
      if (stepId === '') versionEvidence = row;
    }
    return toEvidence(versionEvidence);
  }

  async deleteAll(owner: string): Promise<number> {
    return (await purgeKgraph(this.prisma, owner)).procedures;
  }
}

/** Remove every `kg_` row of one user, and none of anyone else's. Returns the counts. */
export async function purgeKgraph(prisma: PrismaService, userId: string): Promise<Record<'procedures' | 'versions' | 'nodes' | 'edges' | 'tasks' | 'runs' | 'reviews' | 'evidence' | 'traces' | 'ledger' | 'siteFacts', number>> {
  return prisma.$transaction(async (tx) => {
    const evidence = (await tx.kgEvidence.deleteMany({ where: { userId } })).count;
    const reviews = (await tx.kgReview.deleteMany({ where: { userId } })).count;
    const versions = (await tx.kgProcedureVersion.deleteMany({ where: { userId } })).count;
    const procedures = (await tx.kgProcedure.deleteMany({ where: { userId } })).count;
    const edges = (await tx.kgEdge.deleteMany({ where: { userId } })).count;
    const nodes = (await tx.kgNode.deleteMany({ where: { userId } })).count;
    const tasks = (await tx.kgTaskSettings.deleteMany({ where: { userId } })).count;
    const runs = (await tx.kgRun.deleteMany({ where: { userId } })).count;
    const traces = (await tx.kgTrace.deleteMany({ where: { userId } })).count;
    const ledger = (await tx.kgLedger.deleteMany({ where: { userId } })).count;
    const siteFacts = (await tx.kgSiteFact.deleteMany({ where: { userId } })).count;
    return { procedures, versions, nodes, edges, tasks, runs, reviews, evidence, traces, ledger, siteFacts };
  });
}
