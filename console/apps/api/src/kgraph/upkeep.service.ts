// Library upkeep (E46.24): the `kgraph.upkeep` job's work, per owner, idempotent. Skipped entirely while the deployment switch is off, and for
// every user whose own switch is off (their data is kept untouched). It never changes what an active version does and never deletes anything
// a pending review needs.
//   1. traces of runs whose compiled version was verified (active) or retired
//   2. retired and rejected versions beyond the newest 5 retired per procedure
//   3. procedures not run for `kgraph.retentionDays` are retired (not deleted)
//   4. Element and Site nodes no version references
//   5. duplicate Element nodes (same site, role, label, anchor) merged into the oldest
//   6. health roll-up per procedure for the Map
import { Injectable, Logger } from '@nestjs/common';
import type { Prisma } from '@prisma/client';

import { PrismaService } from '../prisma/prisma.service';
import { readKgraphUserSettings } from './kgraph.settings';
import { KgraphEnabledService } from './kgraph-enabled.service';
import { PrismaProcedureStore } from './prisma-procedure-store';

export const KEEP_RETIRED = 5;
export type UpkeepCounts = Record<'traces' | 'versions' | 'stale' | 'orphans' | 'duplicates' | 'health', number>;

const ZERO = (): UpkeepCounts => ({ traces: 0, versions: 0, stale: 0, orphans: 0, duplicates: 0, health: 0 });

/** A procedure's health from its active version's evidence: `good`, `flaky` or `failing` (or `new` with no runs). */
export function healthOf(e: { successes: number; failures: number }): 'new' | 'good' | 'flaky' | 'failing' {
  const n = e.successes + e.failures;
  if (n === 0) return 'new';
  const rate = e.successes / n;
  return rate >= 0.9 ? 'good' : rate >= 0.6 ? 'flaky' : 'failing';
}

@Injectable()
export class KgraphUpkeepService {
  private readonly log = new Logger(KgraphUpkeepService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly enabled: KgraphEnabledService,
    private readonly store: PrismaProcedureStore,
  ) {}

  /** The whole job: every owner whose switch is on. */
  async runAll(now = new Date()): Promise<UpkeepCounts> {
    const total = ZERO();
    const sys = await this.enabled.systemSettingsOf();
    if (!sys.enabled) return total;
    const owners = await this.prisma.kgProcedure.findMany({ distinct: ['userId'], select: { userId: true } });
    for (const { userId } of owners) {
      const row = await this.prisma.userSettings.findUnique({ where: { userId }, select: { value: true } });
      if (!readKgraphUserSettings(row?.value).enabled) continue;
      const c = await this.runOwner(userId, sys.retentionDays, now);
      for (const k of Object.keys(total) as (keyof UpkeepCounts)[]) total[k] += c[k];
    }
    this.log.log(`kgraph upkeep: ${JSON.stringify(total)}`);
    return total;
  }

  async runOwner(userId: string, retentionDays: number | null, now = new Date()): Promise<UpkeepCounts> {
    const c = ZERO();
    const db = this.prisma.forUser({ userId });
    const pendingReview = new Set((await db.kgReview.findMany({ where: { userId, status: 'pending' }, select: { versionId: true } })).map((r) => r.versionId));
    const procedures = await this.store.listProcedures(userId);

    // 3. Stale procedures (before the version sweep, so their versions count as retired).
    if (retentionDays !== null) {
      const since = new Date(now.getTime() - retentionDays * 86_400_000);
      for (const p of procedures) {
        if (new Date(p.createdAt) > since) continue;
        const versions = await this.store.listVersions(userId, p.id);
        const ran = await db.kgRun.count({ where: { userId, procedureVersionId: { in: versions.map((v) => v.id) }, createdAt: { gt: since } } });
        if (ran > 0) continue;
        let retired = 0;
        for (const v of versions) if (!pendingReview.has(v.id) && v.state !== 'retired' && v.state !== 'rejected' && (await this.store.setVersionState(userId, v.id, v.state, 'retired'))) retired++;
        if (retired) c.stale++;
      }
    }

    const allVersions = (await Promise.all(procedures.map((p) => this.store.listVersions(userId, p.id)))).flat();
    // 1. Traces whose run's compiled version was verified (now active) or retired.
    const settledRuns = allVersions.filter((v) => (v.state === 'active' || v.state === 'verified' || v.state === 'retired') && v.sourceRun).map((v) => v.sourceRun!);
    if (settledRuns.length) c.traces += (await db.kgTrace.deleteMany({ where: { userId, runId: { in: settledRuns } } })).count;

    // 2. Old versions: keep active, suspended, candidates, the newest 5 retired, and anything a pending review needs.
    for (const p of procedures) {
      const versions = allVersions.filter((v) => v.procedure === p.id); // newest first
      const retired = versions.filter((v) => v.state === 'retired' && !pendingReview.has(v.id));
      const doomed = [...retired.slice(KEEP_RETIRED), ...versions.filter((v) => v.state === 'rejected' && !pendingReview.has(v.id))];
      const referenced = new Set(versions.filter((v) => !doomed.includes(v)).map((v) => v.parent));
      const ids = doomed.filter((v) => !referenced.has(v.id) || v.state === 'rejected').map((v) => v.id);
      if (ids.length) c.versions += (await db.kgProcedureVersion.deleteMany({ where: { userId, id: { in: ids }, state: { in: ['retired', 'rejected'] } } })).count;
    }

    // 4. Orphans: Element and Site nodes no remaining version references.
    const kept = allVersions.filter((v) => true);
    const usedElements = new Set(kept.flatMap((v) => v.elements.map((e) => e.id)));
    const usedDomains = new Set(kept.flatMap((v) => v.sites.map((s) => s.domain)));
    const nodes = await db.kgNode.findMany({ where: { userId, type: { in: ['Element', 'Site'] } }, select: { id: true, type: true, key: true, label: true, props: true, createdAt: true } });
    const orphanIds = nodes.filter((n) => (n.type === 'Element' && !usedElements.has(n.key)) || (n.type === 'Site' && !usedDomains.has(n.key))).map((n) => n.id);
    if (orphanIds.length) c.orphans += (await db.kgNode.deleteMany({ where: { userId, id: { in: orphanIds } } })).count;

    // 5. Duplicate elements: same site, role, label and anchor. The oldest keeps the union of selector candidates; versions keep their own
    //    embedded fingerprints, so no active version's bytes change.
    const elements = nodes.filter((n) => n.type === 'Element' && !orphanIds.includes(n.id)).sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime());
    const groups = new Map<string, typeof elements>();
    for (const n of elements) {
      const p = (n.props ?? {}) as { site?: string; role?: string | null; name?: string | null; anchor?: string | null };
      const k = JSON.stringify([p.site ?? null, p.role ?? null, p.name ?? null, p.anchor ?? null]);
      groups.set(k, [...(groups.get(k) ?? []), n]);
    }
    for (const g of groups.values()) {
      if (g.length < 2) continue;
      const [keep, ...rest] = g;
      const selectors = [...new Set(g.flatMap((n) => ((n.props as { selectors?: string[] }).selectors ?? [])))].slice(0, 3);
      await db.kgNode.update({ where: { id: keep!.id }, data: { props: { ...(keep!.props as object), selectors, mergedKeys: rest.map((r) => r.key) } as Prisma.InputJsonValue } });
      // A version that referenced a merged key still resolves through its own embedded element; the key is kept as an alias on the survivor.
      c.duplicates += (await db.kgNode.deleteMany({ where: { userId, id: { in: rest.map((r) => r.id) } } })).count;
    }

    // 6. Health roll-up, per procedure, from its active version's evidence.
    for (const p of procedures) {
      const active = allVersions.find((v) => v.procedure === p.id && v.state === 'active');
      const props = { procedureId: p.id, health: active ? healthOf(active.evidence) : 'none', successes: active?.evidence.successes ?? 0, failures: active?.evidence.failures ?? 0 };
      const existing = await db.kgNode.findFirst({ where: { userId, type: 'Health', key: p.id } });
      if (existing && JSON.stringify(existing.props) === JSON.stringify(props)) continue;
      if (existing) await db.kgNode.update({ where: { id: existing.id }, data: { props } });
      else await db.kgNode.create({ data: { id: `kgh-${p.id}`.slice(0, 200), userId, type: 'Health', key: p.id, label: props.health, props } });
      c.health++;
    }
    return c;
  }
}
