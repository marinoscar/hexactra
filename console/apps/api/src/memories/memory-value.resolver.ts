import { Injectable } from '@nestjs/common';

import { PrismaService } from '../prisma/prisma.service';
import type { MemoryValueResolver } from '../tasks/task-params';

/**
 * A task parameter's memory-backed default (#552) read from the owner's
 * memories (#551): the attribute of their ACTIVE memory with that id. A
 * memory that is missing, another user's, archived or superseded, or one
 * without the attribute (or with an empty value), resolves to null, so the
 * value is asked for. Resolving marks the memory used (`lastUsedAt`).
 */
@Injectable()
export class MemoryValueResolverService implements MemoryValueResolver {
  constructor(private readonly prisma: PrismaService) {}

  async resolve(userId: string, ref: { id: string; attribute: string }): Promise<string | null> {
    const db = this.prisma.forUser({ userId });
    const m = await db.memory.findFirst({ where: { id: ref.id, status: 'active' }, select: { id: true, attributes: true } });
    if (!m || !m.attributes || typeof m.attributes !== 'object' || Array.isArray(m.attributes)) return null;
    const attrs = m.attributes as Record<string, unknown>;
    const want = ref.attribute.trim().toLowerCase();
    const key = Object.prototype.hasOwnProperty.call(attrs, ref.attribute) ? ref.attribute : Object.keys(attrs).find((k) => k.trim().toLowerCase() === want);
    const raw = key === undefined ? undefined : attrs[key];
    if (raw === undefined || raw === null || String(raw).trim() === '') return null;
    await db.memory.updateMany({ where: { id: m.id }, data: { lastUsedAt: new Date() } });
    return String(raw);
  }
}
