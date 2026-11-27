// The web search usage table (E50.5, #975): one upsert per call, the per-day count the limit reads, and the administrator's totals.
// Counts only. A user's rows are read and written through `PrismaService.forUser`; the administrator's totals are deployment-wide sums
// with no user id in the answer.
import { Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';

import { PrismaService } from '../prisma/prisma.service';

/** The UTC day of `at`, as a date at midnight UTC. */
export function utcDay(at: Date): Date {
  return new Date(Date.UTC(at.getUTCFullYear(), at.getUTCMonth(), at.getUTCDate()));
}

export const isoDay = (d: Date): string => d.toISOString().slice(0, 10);

export interface UsageRow {
  day: string;
  provider: string;
  calls: number;
  failures: number;
  estimatedCostUsd: number;
}

@Injectable()
export class WebSearchUsage {
  constructor(private readonly prisma: PrismaService) {}

  /**
   * Counts one call (`failed`: it reached the provider and did not answer). `costUsd` (per call) is added for a call that answered.
   * `calls`: an answer-type provider that made several searches in one call counts each (default 1, E50.9); the fee is per search.
   */
  async record(userId: string, provider: string, at: Date, outcome: { failed: boolean; costUsd: number | null; calls?: number }): Promise<void> {
    const day = utcDay(at);
    const calls = Math.max(1, Math.floor(outcome.calls ?? 1));
    const cost = new Prisma.Decimal(!outcome.failed && outcome.costUsd ? outcome.costUsd * calls : 0);
    await this.prisma.forUser({ userId }).webSearchUsage.upsert({
      where: { userId_day_provider: { userId, day, provider } },
      create: { userId, day, provider, calls, failures: outcome.failed ? 1 : 0, estimatedCostUsd: cost },
      update: { calls: { increment: calls }, failures: { increment: outcome.failed ? 1 : 0 }, estimatedCostUsd: { increment: cost } },
    });
  }

  /** The user's calls on the UTC day of `at`, every provider together. */
  async callsOn(userId: string, at: Date): Promise<number> {
    const r = await this.prisma.forUser({ userId }).webSearchUsage.aggregate({ where: { userId, day: utcDay(at) }, _sum: { calls: true } });
    return r._sum.calls ?? 0;
  }

  /** The deployment's calls, failures and estimated cost by day and provider, newest first, for the last `days` UTC days. No user. */
  async totals(now: Date, days: number): Promise<UsageRow[]> {
    const from = new Date(utcDay(now).getTime() - (days - 1) * 86_400_000);
    const rows = await this.prisma.webSearchUsage.groupBy({
      by: ['day', 'provider'],
      where: { day: { gte: from } },
      _sum: { calls: true, failures: true, estimatedCostUsd: true },
      orderBy: [{ day: 'desc' }, { provider: 'asc' }],
    });
    return rows.map((r) => ({
      day: isoDay(r.day),
      provider: r.provider,
      calls: r._sum.calls ?? 0,
      failures: r._sum.failures ?? 0,
      estimatedCostUsd: Number(r._sum.estimatedCostUsd ?? 0),
    }));
  }
}
