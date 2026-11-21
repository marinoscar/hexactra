import { ForbiddenException, Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';

import { PrismaService } from '../prisma/prisma.service';
import { buildUsageReport, usageCsv, usageWindow, type UsageWindow } from './usage-report';
import { UsagePricingService } from './usage-pricing.service';
import { UsageRollupService, type UsageRow } from './usage-rollup.service';
import type { UsageQuery, UsageReport } from './usage.schemas';

/** Who asks for a report. */
export interface UsageCaller {
  id: string;
  permissions: readonly string[];
}

/** The permission that opens every user's usage (the platform's AI administration). */
export const USAGE_ALL_PERMISSION = 'ai_config:read';

/**
 * The usage and cost report (#733): the caller's own (`scope=me`), or every
 * user's for an AI administrator (`scope=all`). Reads the hourly rollups plus
 * the unrolled ledger (`UsageRollupService.rows`), prices them with the
 * effective table and adds the runs' own counters. A user's report is always
 * filtered to their own id; a `userId` filter is refused without `scope=all`.
 */
@Injectable()
export class UsageReportService {
  constructor(
    private readonly rollup: UsageRollupService,
    private readonly pricing: UsagePricingService,
    private readonly prisma: PrismaService,
  ) {}

  async report(caller: UsageCaller, q: UsageQuery, timeZone: string, now = new Date()): Promise<UsageReport> {
    const { window, rows, all } = await this.read(caller, q, timeZone, now);
    const prices = all ? { table: await this.pricing.deployment(), overridesApplied: false } : await this.pricing.forUser(caller.id);
    const labels = q.breakdown === 'user' ? await this.userLabels(rows) : undefined;
    const core = buildUsageReport(rows, { window, timeZone, breakdown: q.breakdown, prices: prices.table, ...(labels ? { userLabel: labels } : {}) });
    return {
      range: q.range,
      scope: q.scope,
      breakdown: q.breakdown,
      timeZone,
      from: window.firstDay,
      to: window.lastDay,
      ...core,
      runs: await this.runs(all ? q.userId : caller.id, window),
      pricing: { overridesApplied: prices.overridesApplied },
    };
  }

  /** The CSV export of the same report and filters. */
  async csv(caller: UsageCaller, q: UsageQuery, timeZone: string, now = new Date()): Promise<{ filename: string; body: string }> {
    const { window, rows, all } = await this.read(caller, q, timeZone, now);
    const prices = all ? await this.pricing.deployment() : (await this.pricing.forUser(caller.id)).table;
    const withUser = all && !q.userId;
    const labels = withUser ? await this.userLabels(rows) : undefined;
    const body = usageCsv(rows, { window, timeZone, prices, withUser, ...(labels ? { userLabel: labels } : {}) });
    return { filename: `ai-usage-${q.scope}-${window.firstDay}-to-${window.lastDay}.csv`, body };
  }

  private async read(caller: UsageCaller, q: UsageQuery, timeZone: string, now: Date): Promise<{ window: UsageWindow; rows: UsageRow[]; all: boolean }> {
    const all = q.scope === 'all';
    if (all && !caller.permissions.includes(USAGE_ALL_PERMISSION)) throw new ForbiddenException(`scope=all needs the ${USAGE_ALL_PERMISSION} permission`);
    if (!all && q.userId && q.userId !== caller.id) throw new ForbiddenException('userId needs scope=all');
    if (!all && q.breakdown === 'user') throw new ForbiddenException('breakdown=user needs scope=all');
    const window = usageWindow(q.range, timeZone, now);
    const rows = await this.rollup.rows({
      from: window.from,
      to: window.to,
      ...(all ? (q.userId ? { userId: q.userId } : {}) : { userId: caller.id }),
      ...(q.provider ? { provider: q.provider } : {}),
      ...(q.model ? { model: q.model } : {}),
      ...(q.feature ? { feature: q.feature } : {}),
    });
    return { window, rows, all };
  }

  /** Each user id's e-mail, for an administrator's breakdown or export. */
  private async userLabels(rows: readonly UsageRow[]): Promise<(id: string | null) => string> {
    const ids = [...new Set(rows.map((r) => r.userId).filter((x): x is string => !!x))];
    const users = ids.length ? await this.prisma.user.findMany({ where: { id: { in: ids } }, select: { id: true, email: true } }) : [];
    const byId = new Map(users.map((u) => [u.id, u.email]));
    return (id) => (id ? (byId.get(id) ?? 'Deleted user') : 'Deployment');
  }

  /** The browser-agent runs started in the window: count, successes and their own cost counters. */
  private async runs(userId: string | undefined, window: UsageWindow): Promise<UsageReport['runs']> {
    const where: Prisma.RunWhereInput = { createdAt: { gte: window.from, lt: window.to }, ...(userId ? { userId } : {}) };
    const db = userId ? this.prisma.forUser({ userId }) : this.prisma;
    const [all, ok] = await Promise.all([
      db.run.aggregate({ where, _count: { _all: true }, _sum: { costUsd: true } }),
      db.run.aggregate({ where: { ...where, status: 'succeeded' }, _count: { _all: true }, _sum: { costUsd: true } }),
    ]);
    const succeeded = ok._count._all;
    const okCost = Number(ok._sum.costUsd ?? 0);
    return {
      count: all._count._all,
      succeeded,
      costUsd: Math.round(Number(all._sum.costUsd ?? 0) * 1e6) / 1e6,
      avgSuccessCostUsd: succeeded > 0 ? Math.round((okCost / succeeded) * 1e6) / 1e6 : null,
    };
  }
}
