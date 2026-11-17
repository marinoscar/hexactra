import { Injectable, Logger, type OnApplicationBootstrap, type OnModuleDestroy } from '@nestjs/common';

import { FabricClient, FabricError } from '../fabric/fabric.client';
import { PrismaService } from '../prisma/prisma.service';
import { RUN_BUDGET_ERROR_LIST } from '../runner/run-budget-errors';
import { HEXACTRA_ALERT_RULES, setAlertSources, type AlertSources } from './hexactra-alert-kinds';

/** Runs whose error says a budget stopped them (goal-runner.service.ts). */
const BUDGET_ERRORS = [...RUN_BUDGET_ERROR_LIST];

/**
 * Gives the console's alert kinds their data (the fabric's hosts, the
 * schedules and runs tables) and creates the console's three rules once, by
 * key: a rule that exists is never touched, so an administrator's edits and
 * thresholds survive restarts.
 */
@Injectable()
export class HexactraAlertsService implements OnApplicationBootstrap, OnModuleDestroy {
  private readonly log = new Logger(HexactraAlertsService.name);

  constructor(
    private readonly fabric: FabricClient,
    private readonly prisma: PrismaService,
  ) {}

  readonly sources: AlertSources = {
    hosts: async () => {
      try {
        return (await this.fabric.hosts()).map((h) => ({ id: h.id, name: h.name, online: h.online, draining: Boolean(h.draining) }));
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
        _sum: { inputTokens: true, outputTokens: true },
        _count: { _all: true },
      });
      const stops = await this.prisma.run.groupBy({
        by: ['userId'],
        where: { createdAt: { gte: since }, status: 'failed', error: { in: BUDGET_ERRORS } },
        _count: { _all: true },
      });
      const stopped = new Map(stops.map((s) => [s.userId, s._count._all]));
      return runs.map((r) => ({
        userId: r.userId,
        tokens: (r._sum.inputTokens ?? 0) + (r._sum.outputTokens ?? 0),
        budgetStops: stopped.get(r.userId) ?? 0,
        runs: r._count._all,
      }));
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
          data: { key: r.key, name: r.name, kind: r.kind, severity: r.severity, config: r.config, forSeconds: r.forSeconds, enabled: true },
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
