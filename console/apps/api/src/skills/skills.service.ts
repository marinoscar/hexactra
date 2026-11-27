import { BadRequestException, ConflictException, Injectable, Logger, NotFoundException } from '@nestjs/common';
import type { Prisma, Skill } from '@prisma/client';
import { siteOf } from '@marinoscar/hexactra-kgraph';

import './skills.errors';
import { PrismaService } from '../prisma/prisma.service';
import { findSkillSecrets } from './skill-secrets';
import { MAX_SKILLS, type CreateSkillInput, type UpdateSkillInput } from './skills.schemas';

export interface SkillView {
  id: string;
  name: string;
  description: string;
  body: string;
  sites: string[];
  enabled: boolean;
  archivedAt: string | null;
  lastUsedAt: string | null;
  useCount: number;
  createdAt: string;
  updatedAt: string;
}

export interface SkillListFilter {
  q?: string;
  archived?: 'true' | 'false' | 'all';
}

type Tx = Prisma.TransactionClient;

/** A 404 that does not tell a missing skill from another user's. */
function notFound(): NotFoundException {
  return new NotFoundException({ code: 'SKILL_NOT_FOUND', message: 'Skill not found' });
}

/**
 * The sites of a skill as registrable domains (the Knowledge Graph's `siteOf`, so a skill and a procedure agree on what a site is), without
 * repeats. A value that is not a host or an address of one is refused with `INVALID_SITE`.
 */
export function normaliseSites(sites: readonly string[]): string[] {
  const out: string[] = [];
  for (const raw of sites) {
    const d = siteOf(raw.trim().replace(/^\*\./, ''));
    if (!d || !d.includes('.')) throw new BadRequestException({ code: 'INVALID_SITE', message: `"${raw.slice(0, 100)}" is not a site such as google.com.`, details: { site: raw.slice(0, 253) } });
    if (!out.includes(d)) out.push(d);
  }
  return out;
}

function refuseSecrets(input: { name?: string; description?: string; body?: string }): void {
  const hits = findSkillSecrets(input);
  if (hits.length === 0) return;
  throw new BadRequestException({ code: 'SKILL_SECRET', message: hits[0]!.message, details: { issues: hits.map((h) => ({ field: h.field, reason: h.reason, message: h.message })) } });
}

/**
 * Skills (#1008): the owner's own playbooks. Every query is the caller's own (`forUser`). The rules: no Secret Material
 * (`skill-secrets.ts`), sites are registrable domains, at most 100 skills, a name unique ignoring case. Written only through this service by
 * the signed-in owner (the console or their CLI): no agent, chat, MCP or webhook path reaches the writes. Audit events carry ids only, never
 * a name or the text.
 */
@Injectable()
export class SkillsService {
  private readonly log = new Logger(SkillsService.name);

  constructor(private readonly prisma: PrismaService) {}

  private db(userId: string) {
    return this.prisma.forUser({ userId });
  }

  async list(userId: string, filter: SkillListFilter = {}): Promise<SkillView[]> {
    const archived = filter.archived ?? 'false';
    const rows = await this.db(userId).skill.findMany({
      where: archived === 'all' ? {} : archived === 'true' ? { archivedAt: { not: null } } : { archivedAt: null },
      orderBy: [{ name: 'asc' }],
    });
    const q = filter.q?.trim().toLowerCase();
    const hits = q ? rows.filter((r) => [r.name, r.description, ...r.sites].join('\n').toLowerCase().includes(q)) : rows;
    return hits.map(view);
  }

  async get(userId: string, id: string): Promise<SkillView> {
    const row = await this.db(userId).skill.findFirst({ where: { id } });
    if (!row) throw notFound();
    return view(row);
  }

  async create(userId: string, input: CreateSkillInput): Promise<SkillView> {
    refuseSecrets(input);
    const sites = normaliseSites(input.sites ?? []);
    const row = await this.prisma.$transaction(async (tx) => {
      await lockUser(tx, userId);
      const n = await tx.skill.count({ where: { userId } });
      if (n >= MAX_SKILLS) throw new ConflictException({ code: 'SKILL_LIMIT', message: `You already have ${MAX_SKILLS} skills. Delete some first.` });
      await assertNameFree(tx, userId, input.name);
      return tx.skill.create({ data: { userId, name: input.name, description: input.description, body: input.body, sites, enabled: input.enabled ?? true } });
    });
    await this.audit(userId, 'skill.created', row.id);
    return view(row);
  }

  async update(userId: string, id: string, patch: UpdateSkillInput): Promise<SkillView> {
    refuseSecrets(patch);
    const sites = patch.sites !== undefined ? normaliseSites(patch.sites) : undefined;
    const row = await this.prisma.$transaction(async (tx) => {
      await lockUser(tx, userId);
      const current = await tx.skill.findFirst({ where: { id, userId } });
      if (!current) throw notFound();
      if (patch.name !== undefined) await assertNameFree(tx, userId, patch.name, id);
      return tx.skill.update({
        where: { id },
        data: {
          ...(patch.name !== undefined ? { name: patch.name } : {}),
          ...(patch.description !== undefined ? { description: patch.description } : {}),
          ...(patch.body !== undefined ? { body: patch.body } : {}),
          ...(sites !== undefined ? { sites } : {}),
          ...(patch.enabled !== undefined ? { enabled: patch.enabled } : {}),
        },
      });
    });
    await this.audit(userId, 'skill.updated', row.id);
    return view(row);
  }

  async setArchived(userId: string, id: string, archived: boolean): Promise<SkillView> {
    const current = await this.db(userId).skill.findFirst({ where: { id } });
    if (!current) throw notFound();
    const row = await this.db(userId).skill.update({ where: { id }, data: { archivedAt: archived ? (current.archivedAt ?? new Date()) : null } });
    await this.audit(userId, archived ? 'skill.archived' : 'skill.unarchived', row.id);
    return view(row);
  }

  async remove(userId: string, id: string): Promise<void> {
    const row = await this.db(userId).skill.findFirst({ where: { id } });
    if (!row) throw notFound();
    await this.db(userId).skill.deleteMany({ where: { id } });
    await this.audit(userId, 'skill.deleted', id);
  }

  /** Ids only: never a name or the text. */
  private async audit(userId: string, action: string, skillId: string): Promise<void> {
    try {
      await this.prisma.auditEvent.create({ data: { actorUserId: userId, action, targetType: 'skill', targetId: skillId, meta: { skillId } } });
    } catch (err) {
      this.log.warn(`${action}: the audit record could not be written: ${err instanceof Error ? err.name : 'error'}`);
    }
  }
}

/** Serialises one user's skill writes, so the limit and the name rule hold under concurrent requests. */
async function lockUser(tx: Tx, userId: string): Promise<void> {
  await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${`skills:${userId}`}))`;
}

async function assertNameFree(tx: Tx, userId: string, name: string, exceptId?: string): Promise<void> {
  const clash = await tx.skill.findFirst({ where: { userId, name: { equals: name, mode: 'insensitive' }, ...(exceptId ? { id: { not: exceptId } } : {}) }, select: { id: true } });
  if (clash) throw new ConflictException({ code: 'SKILL_NAME_TAKEN', message: `You already have a skill called "${name}".`, details: { field: 'name' } });
}

export function view(r: Skill): SkillView {
  return {
    id: r.id,
    name: r.name,
    description: r.description,
    body: r.body,
    sites: r.sites,
    enabled: r.enabled,
    archivedAt: r.archivedAt ? r.archivedAt.toISOString() : null,
    lastUsedAt: r.lastUsedAt ? r.lastUsedAt.toISOString() : null,
    useCount: r.useCount,
    createdAt: r.createdAt.toISOString(),
    updatedAt: r.updatedAt.toISOString(),
  };
}
