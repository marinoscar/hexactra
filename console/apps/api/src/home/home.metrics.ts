// How long the Home summary takes to build (#430), exported through OTLP like
// the run metrics (tasks/run-metrics.ts). No labels: never a user or a block.
import { registerAppMetrics, type AppMetricDef } from '@marinoscar/platform-api/otel-core';

/** In the store: `app_home_summary_duration_seconds_bucket`. The name is permanent once a dashboard reads it. */
export const HOME_METRICS: readonly AppMetricDef[] = [
  {
    key: 'homeSummaryDuration',
    name: 'app.home.summary.duration',
    kind: 'histogram',
    unit: 's',
    description: 'Time to build the Home summary (GET /api/home/summary), the fleet lookup included.',
    buckets: [0.01, 0.025, 0.05, 0.1, 0.15, 0.25, 0.5, 1, 1.5, 3],
  },
];
registerAppMetrics(HOME_METRICS);
