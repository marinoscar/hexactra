// "Browser agents" on the Telemetry Dashboard: runs started and finished, run
// duration, steps, waits for a person and the model tokens the goal runner
// used (its AI cost), from the console's `app.runs.*` metrics
// (src/tasks/run-metrics.ts). The fabric's own OTLP (hexactra-otel) goes to
// the same store: point OTEL_EXPORTER_OTLP_ENDPOINT of fabric-control and
// fabric-host at the console's collector (docs/runbooks/vps-stack.md).
import type { MetricGroupDef } from '@marinoscar/platform-api/telemetry';

declare module '@marinoscar/platform-api/telemetry' {
  interface MetricGroupIds {
    /** Browser agents: runs, steps, handoffs and AI tokens. */
    runs: true;
  }
}

const FILTERS = ['service', 'instance'] as const;

/** Served by `GET /api/admin/telemetry/dashboard/metrics?group=runs`. The id is permanent. */
export const RUNS_METRIC_GROUP: MetricGroupDef = {
  id: 'runs',
  label: 'Browser agents',
  title: 'Browser agents',
  order: 75,
  description: 'runs, their outcome and duration, steps, waits for a person and model tokens',
  families: [
    { key: 'runsStarted', group: 'runs', label: 'Runs started', table: 'app_runs_started_total', kind: 'counter', unit: 'count', rate: 'count', groupBy: 'trigger', requiredColumns: ['trigger'], filters: FILTERS },
    { key: 'runsFinished', group: 'runs', label: 'Runs finished', table: 'app_runs_finished_total', kind: 'counter', unit: 'count', rate: 'count', groupBy: 'status', requiredColumns: ['status'], filters: FILTERS },
    { key: 'runDurationP95', group: 'runs', label: 'Run duration p95', table: 'app_runs_duration_seconds_bucket', kind: 'histogram', unit: 'seconds', quantile: 0.95, groupBy: 'status', requiredColumns: ['le', 'status'], filters: FILTERS, series: false },
    { key: 'runSteps', group: 'runs', label: 'Steps', table: 'app_runs_steps_total', kind: 'counter', unit: 'count', rate: 'count', groupBy: 'kind', requiredColumns: ['kind'], filters: FILTERS },
    { key: 'runHandoffs', group: 'runs', label: 'Waits for a person', table: 'app_runs_handoffs_total', kind: 'counter', unit: 'count', rate: 'count', requiredColumns: [], filters: FILTERS },
    { key: 'runTokens', group: 'runs', label: 'Model tokens', table: 'app_runs_tokens_total', kind: 'counter', unit: 'count', rate: 'count', groupBy: 'direction', requiredColumns: ['direction'], filters: FILTERS },
  ],
};
