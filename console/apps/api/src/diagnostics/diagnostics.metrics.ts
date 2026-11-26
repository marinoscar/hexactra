// The counter of diagnostics (E50.10, #980). Labels are bounded enums: never a user, a connection or a target id.
import { Injectable, Optional } from '@nestjs/common';
import { AppMetricsService } from '@marinoscar/platform-api/host';
import { registerAppMetrics, type AppMetricDef } from '@marinoscar/platform-api/otel-core';

import { DIAGNOSTIC_TARGET_KINDS, STAGE_STATUSES, type DiagnosticTargetKind, type StageStatus } from './diagnostic-report';

/** The provider ids a label may carry; any other is counted as `other`. */
export const DIAGNOSTIC_METRIC_PROVIDERS = ['google', 'microsoft', 'mcp', 'other'] as const;

export const DIAGNOSTICS_METRICS: readonly AppMetricDef[] = [
  {
    key: 'diagnosticsRuns',
    // The platform requires the `app.` prefix of every app metric (the epic's `hexactra.diagnostics.runs`).
    name: 'app.diagnostics.runs',
    kind: 'counter',
    unit: '{report}',
    description: 'Diagnostic reports run, by target kind, provider and overall status.',
    attributes: {
      target_kind: { kind: 'enum', values: DIAGNOSTIC_TARGET_KINDS },
      provider: { kind: 'enum', values: DIAGNOSTIC_METRIC_PROVIDERS },
      overall: { kind: 'enum', values: STAGE_STATUSES },
    },
  },
];
registerAppMetrics(DIAGNOSTICS_METRICS);

@Injectable()
export class DiagnosticsMetrics {
  constructor(@Optional() private readonly metrics?: AppMetricsService) {}

  run(kind: DiagnosticTargetKind, provider: string, overall: StageStatus): void {
    const p = (DIAGNOSTIC_METRIC_PROVIDERS as readonly string[]).includes(provider) ? provider : 'other';
    this.metrics?.add('diagnosticsRuns', 1, { target_kind: kind, provider: p, overall });
  }
}
