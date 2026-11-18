// Saved approval metrics (#554): `app.approvals.rules` (a gauge of enabled rules,
// by kind) and `app.approvals.uses` (a counter, by kind and category). Labels are
// bounded enums: never a user, host or label.
import { Injectable, Logger, type OnModuleInit, Optional } from '@nestjs/common';
import { AppMetricsService } from '@marinoscar/platform-api/host';
import { createRegisteredGauge, registerAppMetrics, type AppMetricDef } from '@marinoscar/platform-api/otel-core';

import { PrismaService } from '../prisma/prisma.service';
import { APPROVAL_RULE_KINDS, GATE_CATEGORIES } from './approval-match';

/** Names are permanent once dashboards read them. */
export const APPROVAL_METRICS: readonly AppMetricDef[] = [
  {
    key: 'approvalRules',
    name: 'app.approvals.rules',
    kind: 'gauge',
    unit: '{rule}',
    description: 'Enabled saved approvals across all users, by kind (gate: a commitment; ask: a question the agent asks on its own).',
    attributes: { kind: { kind: 'enum', values: APPROVAL_RULE_KINDS } },
  },
  {
    key: 'approvalUses',
    name: 'app.approvals.uses',
    kind: 'counter',
    unit: '{use}',
    description: 'Steps that went ahead on a saved approval, by kind and gate category (`none` for an ask).',
    attributes: { kind: { kind: 'enum', values: APPROVAL_RULE_KINDS }, category: { kind: 'enum', values: [...GATE_CATEGORIES, 'none'] } },
  },
];
registerAppMetrics(APPROVAL_METRICS);

/** How long one gauge read is reused. */
const GAUGE_TTL_MS = 30_000;

/** Records the approval metrics; a no-op where the host has no metrics service (unit tests). */
@Injectable()
export class ApprovalMetrics implements OnModuleInit {
  private readonly log = new Logger(ApprovalMetrics.name);
  private cache: { at: number; rows: { kind: string; n: number }[] } | null = null;

  constructor(
    @Optional() private readonly prisma?: PrismaService,
    @Optional() private readonly metrics?: AppMetricsService,
  ) {}

  used(kind: string, category: string | null): void {
    this.metrics?.add('approvalUses' as never, 1, { kind, category: category || 'none' });
  }

  /** Registers the rules gauge once, only when gauges are on in this process. */
  onModuleInit(): void {
    try {
      const context = this.metrics?.gaugeContext();
      if (!context || !this.prisma) return;
      const gauge = createRegisteredGauge(context.meter, 'approvalRules');
      gauge.addCallback(async (result) => {
        if (!context.gateOpen()) return;
        for (const r of await this.counts(context.now())) result.observe(r.n, { kind: r.kind });
      });
    } catch (e) {
      this.log.debug(`Could not register the saved approval gauge: ${e instanceof Error ? e.message : 'error'}`);
    }
  }

  private async counts(now: number): Promise<{ kind: string; n: number }[]> {
    if (this.cache && now - this.cache.at < GAUGE_TTL_MS) return this.cache.rows;
    try {
      const rows = await this.prisma!.approvalRule.groupBy({ by: ['kind'], where: { enabled: true }, _count: { _all: true } });
      const byKind = new Map(rows.map((r) => [r.kind as string, r._count._all]));
      this.cache = { at: now, rows: APPROVAL_RULE_KINDS.map((kind) => ({ kind, n: byKind.get(kind) ?? 0 })) };
      return this.cache.rows;
    } catch {
      return [];
    }
  }
}
