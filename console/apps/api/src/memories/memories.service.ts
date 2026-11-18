import { ConflictException, Injectable, Logger, NotFoundException, UnprocessableEntityException } from '@nestjs/common';
import type { Memory, Prisma } from '@prisma/client';

import './memories.errors';
import { PrismaService } from '../prisma/prisma.service';
import { MAX_ACTIVE_MEMORIES, type CreateMemoryInput, type SupersedeMemoryInput, type UpdateMemoryInput } from './memories.schemas';
import { MemoryMetrics, type MemoryWriteOp } from './memory-metrics';
import { findMemorySecrets } from './memory-secrets';
import { buildMemoryFile, memoryFileName, type MemoryFile } from './memory-transfer';

/** Who wrote a memory: the owner typing it, or an agent proposal the owner approved (#553). */
export interface MemoryOrigin {
  source: 'owner' | 'agent_proposed';
  sourceRunId?: string | null;
  sourceConversationId?: string | null;
}

export interface MemoryView {
  id: string;
  kind: string;
  label: string;
  aliases: string[];
  attributes: Record<string, string>;
  note: string | null;
  status: string;
  source: string;
  sourceRunId: string | null;
  sourceConversationId: string | null;
  supersededById: string | null;
  lastUsedAt: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface MemoryListFilter {
  kind?: string;
  status?: 'active' | 'superseded' | 'archived' | 'all';
  q?: string;
}

type Tx = Prisma.TransactionClient;

const OWNER: MemoryOrigin = { source: 'owner' };

/** A 404 that does not tell a missing memory from another user's. */
function notFound(): NotFoundException {
  return new NotFoundException({ code: 'MEMORY_NOT_FOUND', message: 'Memory not found' });
}

/**
 * Memories (#551): the facts the owner lets the agent use. Every query is the
 * caller's own (`forUser`). The rules: no Secret Material (`memory-secrets.ts`),
 * at most 500 active memories, a label unique among the active ones ignoring
 * case, and a changed value supersedes the old version instead of editing it.
 * Audit events carry ids, kind and source only, never a label or a value.
 */
@Injectable()
export class MemoriesService {
  private readonly log = new Logger(MemoriesService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly metrics: MemoryMetrics,
  ) {}

  private db(userId: string) {
    return this.prisma.forUser({ userId });
  }

  // ---- Reading ----

  async list(userId: string, filter: MemoryListFilter = {}): Promise<MemoryView[]> {
    const status = filter.status ?? 'active';
    const rows = await this.db(userId).memory.findMany({
      where: { ...(status === 'all' ? {} : { status }), ...(filter.kind ? { kind: filter.kind as Memory['kind'] } : {}) },
      orderBy: [{ kind: 'asc' }, { label: 'asc' }],
    });
    const q = filter.q?.trim().toLowerCase();
    const hits = q ? rows.filter((r) => searchText(r).includes(q)) : rows;
    return hits.map(view);
  }

  /** One memory with the older versions it replaced, newest first. */
  async get(userId: string, id: string): Promise<MemoryView & { history: MemoryView[] }> {
    const row = await this.db(userId).memory.findFirst({ where: { id } });
    if (!row) throw notFound();
    const older = await this.ancestors(userId, id);
    return { ...view(row), history: older.map(view) };
  }

  /** The active memories the agent may read (#553), most recently used first. */
  async active(userId: string): Promise<MemoryView[]> {
    const rows = await this.db(userId).memory.findMany({ where: { status: 'active' }, orderBy: [{ lastUsedAt: { sort: 'desc', nulls: 'last' } }, { createdAt: 'desc' }] });
    return rows.map(view);
  }

  /** Marks memories as used now (a run or chat read them). Unknown or foreign ids are ignored. */
  async touch(userId: string, ids: readonly string[]): Promise<void> {
    if (ids.length === 0) return;
    await this.db(userId).memory.updateMany({ where: { id: { in: [...ids] } }, data: { lastUsedAt: new Date() } });
  }

  // ---- Writing ----

  /** A new memory typed by the owner (`origin` defaults to the owner; #553 passes an approved proposal's). */
  async create(userId: string, input: CreateMemoryInput, origin: MemoryOrigin = OWNER): Promise<MemoryView> {
    refuseSecrets(input);
    const row = await this.prisma.$transaction(async (tx) => {
      await lockUser(tx, userId);
      await this.assertRoom(tx, userId);
      await this.assertLabelFree(tx, userId, input.label);
      return tx.memory.create({
        data: {
          userId,
          kind: input.kind,
          label: input.label,
          aliases: input.aliases ?? [],
          attributes: input.attributes ?? {},
          note: input.note ?? null,
          source: origin.source,
          sourceRunId: origin.sourceRunId ?? null,
          sourceConversationId: origin.sourceConversationId ?? null,
        },
      });
    });
    await this.done(userId, 'create', 'memory.created', row);
    return view(row);
  }

  /** Label, aliases, note and kind of an active or archived memory. */
  async update(userId: string, id: string, patch: UpdateMemoryInput): Promise<MemoryView> {
    refuseSecrets({ label: patch.label, aliases: patch.aliases, note: patch.note });
    const row = await this.prisma.$transaction(async (tx) => {
      await lockUser(tx, userId);
      const current = await tx.memory.findFirst({ where: { id, userId } });
      if (!current) throw notFound();
      if (current.status === 'superseded') throw notActive('A superseded version cannot be edited: edit the current one.');
      if (patch.label !== undefined && current.status === 'active') await this.assertLabelFree(tx, userId, patch.label, id);
      return tx.memory.update({
        where: { id },
        data: {
          ...(patch.kind !== undefined ? { kind: patch.kind } : {}),
          ...(patch.label !== undefined ? { label: patch.label } : {}),
          ...(patch.aliases !== undefined ? { aliases: patch.aliases } : {}),
          ...(patch.note !== undefined ? { note: patch.note } : {}),
        },
      });
    });
    this.metrics.write('update', row.source);
    return view(row);
  }

  /** A new version with new values; the old one becomes `superseded` and points to it. One transaction. */
  async supersede(userId: string, id: string, input: SupersedeMemoryInput, origin: MemoryOrigin = OWNER): Promise<MemoryView> {
    refuseSecrets(input);
    const { next, old } = await this.prisma.$transaction(async (tx) => {
      await lockUser(tx, userId);
      const current = await tx.memory.findFirst({ where: { id, userId } });
      if (!current) throw notFound();
      if (current.status !== 'active') throw notActive('Only an active memory can be superseded.');
      const label = input.label ?? current.label;
      if (input.label !== undefined) await this.assertLabelFree(tx, userId, label, id);
      const created = await tx.memory.create({
        data: {
          userId,
          kind: input.kind ?? current.kind,
          label,
          aliases: input.aliases ?? current.aliases,
          attributes: input.attributes,
          note: input.note !== undefined ? input.note : current.note,
          source: origin.source,
          sourceRunId: origin.sourceRunId ?? null,
          sourceConversationId: origin.sourceConversationId ?? null,
          lastUsedAt: current.lastUsedAt,
        },
      });
      await tx.memory.update({ where: { id }, data: { status: 'superseded', supersededById: created.id } });
      return { next: created, old: current };
    });
    await this.done(userId, 'supersede', 'memory.superseded', next, { supersededId: old.id });
    return view(next);
  }

  async archive(userId: string, id: string): Promise<MemoryView> {
    const row = await this.prisma.$transaction(async (tx) => {
      const current = await tx.memory.findFirst({ where: { id, userId } });
      if (!current) throw notFound();
      if (current.status !== 'active') throw notActive('Only an active memory can be archived.');
      return tx.memory.update({ where: { id }, data: { status: 'archived' } });
    });
    await this.done(userId, 'archive', 'memory.archived', row);
    return view(row);
  }

  async unarchive(userId: string, id: string): Promise<MemoryView> {
    const row = await this.prisma.$transaction(async (tx) => {
      await lockUser(tx, userId);
      const current = await tx.memory.findFirst({ where: { id, userId } });
      if (!current) throw notFound();
      if (current.status !== 'archived') throw notActive('Only an archived memory can be unarchived.');
      await this.assertRoom(tx, userId);
      await this.assertLabelFree(tx, userId, current.label, id);
      return tx.memory.update({ where: { id }, data: { status: 'active' } });
    });
    this.metrics.write('unarchive', row.source);
    return view(row);
  }

  /** Deletes a memory and every older version of it, permanently. */
  async remove(userId: string, id: string): Promise<void> {
    const row = await this.db(userId).memory.findFirst({ where: { id } });
    if (!row) throw notFound();
    const older = await this.ancestors(userId, id);
    const ids = [id, ...older.map((r) => r.id)];
    await this.db(userId).memory.deleteMany({ where: { id: { in: ids } } });
    await this.done(userId, 'delete', 'memory.deleted', row, { versions: ids.length });
  }

  /** The `hexactra.memories` file: active and archived memories, no ids. */
  async export(userId: string, now: Date = new Date()): Promise<{ file: MemoryFile; filename: string }> {
    const rows = await this.db(userId).memory.findMany({ where: { status: { in: ['active', 'archived'] } }, orderBy: [{ kind: 'asc' }, { label: 'asc' }] });
    const file = buildMemoryFile(rows, now);
    await this.audit(userId, 'memory.exported', null, { count: file.memories.length });
    return { file, filename: memoryFileName(now) };
  }

  // ---- Helpers ----

  /** The versions that led to `id`, newest first. */
  private async ancestors(userId: string, id: string): Promise<Memory[]> {
    const replaced = await this.db(userId).memory.findMany({ where: { supersededById: { not: null } } });
    const byNext = new Map(replaced.map((r) => [r.supersededById!, r]));
    const out: Memory[] = [];
    const seen = new Set<string>([id]);
    for (let prev = byNext.get(id); prev && !seen.has(prev.id); prev = byNext.get(prev.id)) {
      seen.add(prev.id);
      out.push(prev);
    }
    return out;
  }

  private async assertRoom(tx: Tx, userId: string): Promise<void> {
    const n = await tx.memory.count({ where: { userId, status: 'active' } });
    if (n >= MAX_ACTIVE_MEMORIES) {
      throw new ConflictException({ code: 'MEMORY_LIMIT', message: `You already have ${MAX_ACTIVE_MEMORIES} active memories. Archive or delete some first.` });
    }
  }

  private async assertLabelFree(tx: Tx, userId: string, label: string, exceptId?: string): Promise<void> {
    const clash = await tx.memory.findFirst({
      where: { userId, status: 'active', label: { equals: label, mode: 'insensitive' }, ...(exceptId ? { id: { not: exceptId } } : {}) },
      select: { id: true },
    });
    if (clash) throw new ConflictException({ code: 'MEMORY_LABEL_TAKEN', message: `You already have a memory called "${label}".`, details: { field: 'label' } });
  }

  private async done(userId: string, op: MemoryWriteOp, action: string, row: Memory, meta: Record<string, unknown> = {}): Promise<void> {
    this.metrics.write(op, row.source);
    await this.audit(userId, action, row.id, { memoryId: row.id, kind: row.kind, source: row.source, ...meta });
  }

  /** Ids, kind and source only: never a label, an alias, a note or a value. */
  private async audit(userId: string, action: string, targetId: string | null, meta: Record<string, unknown>): Promise<void> {
    try {
      await this.prisma.auditEvent.create({ data: { actorUserId: userId, action, targetType: targetId ? 'memory' : 'user', targetId: targetId ?? userId, meta: meta as Prisma.InputJsonValue } });
    } catch (err) {
      this.log.warn(`${action}: the audit record could not be written: ${err instanceof Error ? err.name : 'error'}`);
    }
  }
}

/** Serialises one user's memory writes, so the limit and the label rule hold under concurrent requests. */
async function lockUser(tx: Tx, userId: string): Promise<void> {
  await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${`memories:${userId}`}))`;
}

function refuseSecrets(input: Parameters<typeof findMemorySecrets>[0]): void {
  const hits = findMemorySecrets(input);
  if (hits.length === 0) return;
  throw new UnprocessableEntityException({
    code: 'MEMORY_HOLDS_SECRET',
    message: hits[0]!.message,
    details: { issues: hits.map((h) => ({ field: h.field, reason: h.reason, message: h.message })) },
  });
}

function notActive(message: string): ConflictException {
  return new ConflictException({ code: 'MEMORY_NOT_ACTIVE', message });
}

function searchText(r: Memory): string {
  const attrs = r.attributes && typeof r.attributes === 'object' ? Object.values(r.attributes as Record<string, unknown>).map(String) : [];
  return [r.label, ...r.aliases, ...attrs].join('\n').toLowerCase();
}

function view(r: Memory): MemoryView {
  return {
    id: r.id,
    kind: r.kind,
    label: r.label,
    aliases: r.aliases,
    attributes: (r.attributes ?? {}) as Record<string, string>,
    note: r.note,
    status: r.status,
    source: r.source,
    sourceRunId: r.sourceRunId,
    sourceConversationId: r.sourceConversationId,
    supersededById: r.supersededById,
    lastUsedAt: r.lastUsedAt ? r.lastUsedAt.toISOString() : null,
    createdAt: r.createdAt.toISOString(),
    updatedAt: r.updatedAt.toISOString(),
  };
}
