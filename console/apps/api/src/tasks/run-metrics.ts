// The console's run metrics (`app.runs.*`), exported through OTLP like the
// platform's own and charted by the "Browser agents" telemetry group
// (platform/telemetry/runs.metric-group.ts). Labels are bounded enums: never
// a user, task, URL or goal (those belong to the run record, not to a metric).
import { Injectable, Optional } from '@nestjs/common';
import { AppMetricsService } from '@marinoscar/platform-api/host';
import { registerAppMetrics, type AppMetricDef } from '@marinoscar/platform-api/otel-core';

const TRIGGERS = ['manual', 'schedule', 'api', 'mcp', 'external'] as const;
const STATUSES = ['succeeded', 'failed', 'cancelled'] as const;
const STEP_KINDS = ['action', 'handoff', 'finish', 'error', 'note'] as const;

/** Names are permanent once dashboards read them. */
export const RUN_METRICS: readonly AppMetricDef[] = [
  { key: 'runsStarted', name: 'app.runs.started', kind: 'counter', unit: '{run}', description: 'Runs that started executing.', attributes: { trigger: { kind: 'enum', values: TRIGGERS } } },
  {
    key: 'runsFinished',
    name: 'app.runs.finished',
    kind: 'counter',
    unit: '{run}',
    description: 'Runs that ended, by outcome.',
    attributes: { status: { kind: 'enum', values: STATUSES }, trigger: { kind: 'enum', values: TRIGGERS } },
  },
  {
    key: 'runDuration',
    name: 'app.runs.duration',
    kind: 'histogram',
    unit: 's',
    description: 'Wall time of a run from its start to its end, waits for a person included.',
    buckets: [5, 15, 30, 60, 120, 300, 600, 1800, 3600],
    attributes: { status: { kind: 'enum', values: STATUSES } },
  },
  {
    key: 'runSteps',
    name: 'app.runs.steps',
    kind: 'counter',
    unit: '{step}',
    description: 'Recorded run steps, by kind and success.',
    attributes: { kind: { kind: 'enum', values: STEP_KINDS }, ok: { kind: 'enum', values: ['true', 'false'] } },
  },
  { key: 'runHandoffs', name: 'app.runs.handoffs', kind: 'counter', unit: '{handoff}', description: 'Times a run waited for a person (CAPTCHA, code, sign-in, confirmation).' },
  {
    key: 'runTokens',
    name: 'app.runs.tokens',
    kind: 'counter',
    unit: '{token}',
    description: "Model tokens the goal runner used: the AI cost of browser agents.",
    attributes: { direction: { kind: 'enum', values: ['input', 'output'] } },
  },
];
registerAppMetrics(RUN_METRICS);

/** Records the run metrics; a no-op where the host has no metrics service (unit tests). */
@Injectable()
export class RunMetrics {
  constructor(@Optional() private readonly metrics?: AppMetricsService) {}

  started(trigger: string): void {
    this.metrics?.add('runsStarted', 1, { trigger });
  }

  finished(status: string, trigger: string, seconds: number | null): void {
    this.metrics?.add('runsFinished', 1, { status, trigger });
    if (seconds !== null && seconds >= 0) this.metrics?.record('runDuration', seconds, { status });
  }

  step(kind: string, ok: boolean): void {
    this.metrics?.add('runSteps', 1, { kind, ok: String(ok) });
  }

  handoff(): void {
    this.metrics?.add('runHandoffs', 1);
  }

  tokens(input: number, output: number): void {
    if (input > 0) this.metrics?.add('runTokens', input, { direction: 'input' });
    if (output > 0) this.metrics?.add('runTokens', output, { direction: 'output' });
  }
}
