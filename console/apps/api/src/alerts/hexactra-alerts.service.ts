import { Injectable, Logger, type OnApplicationBootstrap, type OnModuleDestroy } from '@nestjs/common';

import { FabricClient, FabricError } from '../fabric/fabric.client';
import { toHost } from '../fleet/fleet.service';
import { ApprovalRulesService } from '../approvals/approval-rules.service';
import { PrismaService } from '../prisma/prisma.service';
import { UsageReportService } from '../usage/usage-report.service';
import { BUDGET_STOP_REASONS } from '../runner/budget';
import { RUN_BUDGET_ERROR_LIST } from '../runner/run-budget-errors';
import { HEXACTRA_ALERT_RULES, setAlertSources, type AlertSources } from './hexactra-alert-kinds';

/** Legacy: runs from before `runs.stop_reason` (#404) carry only the error text. Drop with the next major release. */
const BUDGET_ERRORS = [...RUN_BUDGET_ERROR_LIST];

/**
 * Gives the console's alert kinds their data (the fabric's hosts, the
 * schedules and runs tables) and creates the console's rules once, by key
 * (`HEXACTRA_ALERT_RULES`; the expensive-run rule disabled): a rule that
 * exists is never touched, so an administrator's edits and thresholds survive
 * restarts.
 */
@Injectable()
export class HexactraAlertsService implements OnApplicationBootstrap, OnModuleDestroy {
  private readonly log = new Logger(HexactraAlertsService.name);

  constructor(
    private readonly fabric: FabricClient,
    private readonly prisma: PrismaService,
    private readonly approvals: ApprovalRulesService,
    private readonly usage: UsageReportService,
  ) {}

  readonly sources: AlertSources = {
    hosts: async () => {
      try {
        // Each profile's sign-in state only (E48.5): the accounts and their emails stay out of the alerts.
        return (await this.fabric.hosts()).map((h) => ({ id: h.id, name: h.name, online: h.online, draining: Boolean(h.draining), profiles: toHost(h).profiles.map((p) => ({ name: p.name, signin: p.signin })) }));
      } catch (e) {
        if (e instanceof FabricError && e.kind === 'not_configured') return null;
        throw e;
      }
    },
    failingSchedules: async (minFailures) => {
      const rows = await this.prisma.taskSchedule.findMany({
        where: { enabled: true, consecutiveFailures: { gte: minFailures } },
        select: { id: true, consecutiveFailures: true, task: { select: { name: true } } },
        take: 1_000,
      });
      return rows.map((r) => ({ id: r.id, taskName: r.task.name, consecutiveFailures: r.consecutiveFailures }));
    },
    usage: async (since) => {
      const runs = await this.prisma.run.groupBy({
        by: ['userId'],
        where: { createdAt: { gte: since } },
        _sum: { inputTokens: true, outputTokens: true, costUsd: true },
        _count: { _all: true },
      });
      const unpriced = await this.prisma.run.groupBy({ by: ['userId'], where: { createdAt: { gte: since }, costKnown: false }, _count: { _all: true } });
      const unknownCost = new Set(unpriced.map((u) => u.userId));
      const stops = await this.prisma.run.groupBy({
        by: ['userId'],
        // `stop_reason LIKE 'budget_%'` (an enum: its six budget values), or the old error text on rows with no stop reason.
        where: {
          createdAt: { gte: since },
          status: 'failed',
          OR: [{ stopReason: { in: [...BUDGET_STOP_REASONS] } }, { stopReason: null, error: { in: BUDGET_ERRORS } }],
        },
        _count: { _all: true },
      });
      const stopped = new Map(stops.map((s) => [s.userId, s._count._all]));
      return runs.map((r) => ({
        userId: r.userId,
        tokens: (r._sum.inputTokens ?? 0) + (r._sum.outputTokens ?? 0),
        budgetStops: stopped.get(r.userId) ?? 0,
        runs: r._count._all,
        costUsd: Number(r._sum.costUsd ?? 0),
        costKnown: !unknownCost.has(r.userId),
      }));
    },
    stalls: async (since) => {
      const where = { createdAt: { gte: since }, stopReason: 'stalled' as const };
      const counts = await this.prisma.run.groupBy({ by: ['userId'], where, _count: { _all: true }, _max: { createdAt: true } });
      if (counts.length === 0) return [];
      // The latest stalled run of each user, to name it in the summary.
      const latest = await this.prisma.run.findMany({
        where: { ...where, OR: counts.map((c) => ({ userId: c.userId, createdAt: c._max.createdAt ?? since })) },
        select: { id: true, userId: true, goal: true, createdAt: true, task: { select: { name: true } } },
        orderBy: { createdAt: 'desc' },
      });
      const byUser = new Map<string, (typeof latest)[number]>();
      for (const r of latest) if (!byUser.has(r.userId)) byUser.set(r.userId, r);
      return counts.flatMap((c) => {
        const r = byUser.get(c.userId);
        return r ? [{ userId: c.userId, stalls: c._count._all, latest: { runId: r.id, taskName: r.task?.name ?? null, goal: r.goal } }] : [];
      });
    },
    monthlyAiSpend: (now) => this.usage.monthToDate(now),
    expensiveRuns: async (overUsd, since) => {
      const rows = await this.prisma.run.findMany({
        where: { createdAt: { gte: since }, costUsd: { gt: overUsd } },
        select: { id: true, userId: true, goal: true, costUsd: true, costKnown: true, task: { select: { name: true } } },
        orderBy: { costUsd: 'desc' },
        take: 200,
      });
      return rows.map((r) => ({ runId: r.id, userId: r.userId, taskName: r.task?.name ?? null, goal: r.goal, costUsd: Number(r.costUsd), costKnown: r.costKnown }));
    },
    recoveredRuns: async (minRecoveries, since) => {
      const rows = await this.prisma.run.findMany({
        where: { createdAt: { gte: since }, recoveries: { gte: minRecoveries } },
        select: { id: true, userId: true, goal: true, recoveries: true, task: { select: { name: true } } },
        orderBy: { recoveries: 'desc' },
        take: 200,
      });
      return rows.map((r) => ({ runId: r.id, userId: r.userId, taskName: r.task?.name ?? null, goal: r.goal, recoveries: r.recoveries }));
    },
    failingDeliveries: async (minFailures, since) => {
      const groups = await this.prisma.runDelivery.groupBy({ by: ['deliveryId', 'userId', 'kind'], where: { status: 'failed', createdAt: { gte: since }, deliveryId: { not: null } }, _count: { _all: true } });
      const over = groups.filter((g) => g._count._all >= minFailures && g.deliveryId).sort((a, b) => b._count._all - a._count._all).slice(0, 200);
      if (over.length === 0) return [];
      const tasks = await this.prisma.taskDelivery.findMany({ where: { id: { in: over.map((g) => g.deliveryId as string) } }, select: { id: true, task: { select: { name: true } } } });
      const name = new Map(tasks.map((t) => [t.id, t.task.name]));
      return over.map((g) => ({ deliveryId: g.deliveryId as string, userId: g.userId, kind: g.kind, taskName: name.get(g.deliveryId as string) ?? null, failures: g._count._all }));
    },
    busyApprovals: (minUses, since) => this.approvals.busyRules(minUses, since),
    cardUsage: async (since) => {
      // Card payments are the `number` releases that were typed (E37.7): counts and the declared amount, never a card or a merchant.
      const rows = await this.prisma.secretsActivity.findMany({ where: { event: 'release', field: 'number', purpose: 'purchase', outcome: 'typed', occurredAt: { gte: since } }, select: { userId: true, amount: true, currency: true }, take: 5_000 });
      const by = new Map<string, { uses: number; largest: { amount: string; currency: string } | null }>();
      for (const r of rows) {
        const cur = by.get(r.userId) ?? { uses: 0, largest: null };
        cur.uses += 1;
        if (r.amount && r.currency && (cur.largest === null || Number(r.amount) > Number(cur.largest.amount))) cur.largest = { amount: r.amount, currency: r.currency };
        by.set(r.userId, cur);
      }
      return [...by.entries()].map(([userId, v]) => ({ userId, ...v }));
    },
  };

  async onApplicationBootstrap(): Promise<void> {
    setAlertSources(this.sources);
    try {
      await this.seed();
    } catch (e) {
      this.log.warn(`Could not create the console's alert rules: ${e instanceof Error ? e.message : String(e)}`);
    }
  }

  onModuleDestroy(): void {
    setAlertSources(null);
  }

  /** Creates the missing console rules; returns how many it created. */
  async seed(): Promise<number> {
    let created = 0;
    for (const r of HEXACTRA_ALERT_RULES) {
      if (await this.prisma.alertRule.findUnique({ where: { key: r.key }, select: { id: true } })) continue;
      try {
        await this.prisma.alertRule.create({
          data: { key: r.key, name: r.name, kind: r.kind, severity: r.severity, config: r.config, forSeconds: r.forSeconds, enabled: r.enabled },
        });
        created++;
      } catch (e) {
        // Another replica created it first (unique key).
        if (!(e instanceof Error && 'code' in e && (e as { code?: string }).code === 'P2002')) throw e;
      }
    }
    return created;
  }
}
