// The Knowledge Graph's metrics (E46.6, #780). Labels are bounded enums: never a user, a task, a procedure or a value.
import { Injectable, Optional } from '@nestjs/common';
import { AppMetricsService } from '@marinoscar/platform-api/host';
import { registerAppMetrics, type AppMetricDef } from '@marinoscar/platform-api/otel-core';

import { LEDGER_OUTCOMES, type LedgerOutcome } from './ledger';

/** Names are permanent once dashboards read them. */
export const KGRAPH_METRICS: readonly AppMetricDef[] = [
  {
    key: 'kgraphRuns',
    name: 'app.kgraph.runs',
    kind: 'counter',
    unit: '{run}',
    description: 'Runs of a task with the Knowledge Graph on, written to the savings ledger, by mode and outcome.',
    attributes: { mode: { kind: 'enum', values: ['learn', 'reuse'] }, outcome: { kind: 'enum', values: LEDGER_OUTCOMES } },
  },
  {
    key: 'kgraphModelCallsSaved',
    name: 'app.kgraph.model_calls_saved',
    kind: 'counter',
    unit: '{call}',
    description: "Model calls a run that executed a procedure did not make, against its task's AI-only baseline (never counted without a baseline).",
  },
];
registerAppMetrics(KGRAPH_METRICS);

/** Records the Knowledge Graph metrics; a no-op where the host has no metrics service (unit tests). */
@Injectable()
export class KgraphMetrics {
  constructor(@Optional() private readonly metrics?: AppMetricsService) {}

  run(mode: 'learn' | 'reuse', outcome: LedgerOutcome): void {
    this.metrics?.add('kgraphRuns', 1, { mode, outcome });
  }

  modelCallsSaved(n: number): void {
    if (n > 0) this.metrics?.add('kgraphModelCallsSaved', n);
  }
}
