// The console's binding of the Knowledge Graph's SiteFactStorePort (phase 5, E46.31): the `kg_site_facts` table through
// `PrismaService.forUser`. Every read and write is scoped to one owner; another owner's id answers as not found. A proposal is always stored
// `proposed`; one identity (site, kind, normalised text) per owner. It passes `runSiteFactStoreConformance` (test/kgraph-site-facts.db.spec.ts).
// The secret check is the console's: the memories secret rules (`memory-secrets.ts`) and the sensitive-pattern table.
import { Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { canMoveSiteFact, siteFactKey, siteFactSchema, type NewSiteFact, type SecretCheckPort, type SiteFact, type SiteFactStatus, type SiteFactStorePort } from '@marinoscar/hexactra-kgraph';

import { findMemorySecrets } from '../memories/memory-secrets';
import { PrismaService } from '../prisma/prisma.service';
import { consoleIsSensitive } from '../runner/host/kgraph/observer-port';

/** The console's secret rules for a fact's text: a memory's note check, then the sensitive-pattern table. Never throws. */
export const consoleSecretCheck: SecretCheckPort = Object.freeze({
  hasSecret(text: string): boolean {
    try {
      return findMemorySecrets({ note: text }).length > 0 || consoleIsSensitive(text);
    } catch {
      return true;
    }
  },
});

export type SiteFactRow = { id: string; site: string; kind: string; text: string; source: string; status: string; evidence: Prisma.JsonValue; declinedAt: Date | null; lastUsedAt: Date | null; createdAt: Date; updatedAt: Date };

export const toSiteFact = (r: SiteFactRow): SiteFact =>
  siteFactSchema.parse({ id: r.id, site: r.site, kind: r.kind, text: r.text, source: r.source, status: r.status, evidence: r.evidence ?? {}, createdAt: r.createdAt.toISOString(), lastUsedAt: r.lastUsedAt?.toISOString() ?? null });

@Injectable()
export class PrismaSiteFactStore implements SiteFactStorePort {
  constructor(private readonly prisma: PrismaService) {}

  private db(owner: string) {
    return this.prisma.forUser({ userId: owner });
  }

  async proposeSiteFact(owner: string, fact: NewSiteFact): Promise<{ fact: SiteFact; created: boolean }> {
    const identity = siteFactKey(fact);
    const db = this.db(owner);
    const existing = await db.kgSiteFact.findFirst({ where: { userId: owner, identity } });
    if (existing) return { fact: toSiteFact(existing), created: false };
    try {
      const row = await db.kgSiteFact.create({
        data: { id: fact.id, userId: owner, site: fact.site, kind: fact.kind, text: fact.text, identity, source: fact.source, status: 'proposed', evidence: (fact.evidence ?? {}) as Prisma.InputJsonValue, createdAt: new Date(fact.createdAt) },
      });
      return { fact: toSiteFact(row), created: true };
    } catch (err) {
      // Two writers raced on the same identity: the other one's fact is the stored one.
      if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002') {
        const raced = await db.kgSiteFact.findFirst({ where: { userId: owner, identity } });
        if (raced) return { fact: toSiteFact(raced), created: false };
      }
      throw err;
    }
  }

  async listSiteFacts(owner: string, sites: readonly string[], status: SiteFactStatus | readonly SiteFactStatus[]): Promise<SiteFact[]> {
    if (sites.length === 0) return [];
    const statuses = typeof status === 'string' ? [status] : [...status];
    const rows = await this.db(owner).kgSiteFact.findMany({ where: { userId: owner, site: { in: [...sites] }, status: { in: statuses } }, orderBy: [{ site: 'asc' }, { createdAt: 'asc' }, { id: 'asc' }] });
    return rows.map(toSiteFact);
  }

  async setSiteFactStatus(owner: string, id: string, expected: SiteFactStatus, next: SiteFactStatus): Promise<boolean> {
    if (!canMoveSiteFact(expected, next)) return false;
    const r = await this.db(owner).kgSiteFact.updateMany({ where: { id, userId: owner, status: expected }, data: { status: next } });
    return r.count === 1;
  }

  async touchSiteFacts(owner: string, ids: readonly string[], at: string): Promise<number> {
    if (ids.length === 0) return 0;
    const r = await this.db(owner).kgSiteFact.updateMany({ where: { id: { in: [...new Set(ids)] }, userId: owner }, data: { lastUsedAt: new Date(at) } });
    return r.count;
  }
}
