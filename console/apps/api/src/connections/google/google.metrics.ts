// Counters and a histogram of the Google adapter's requests (E39.3, #601). The labels are bounded enums: the service and the
// outcome. Never a connection, an account, an operation argument or a status text.
import { registerAppMetrics, type AppMetricDef } from '@marinoscar/platform-api/otel-core';

import { GOOGLE_SERVICES } from './google.constants';

export const GOOGLE_OUTCOMES = ['ok', 'client_error', 'rate_limited', 'server_error', 'network', 'aborted'] as const;
export type GoogleOutcome = (typeof GOOGLE_OUTCOMES)[number];

/** Names are permanent once dashboards read them. */
export const GOOGLE_METRICS: readonly AppMetricDef[] = [
  {
    key: 'googleRequests',
    name: 'app.connections.google.requests',
    kind: 'counter',
    unit: '{request}',
    description: 'Requests the Google adapter made (one per try), by Google service and outcome.',
    attributes: { service: { kind: 'enum', values: GOOGLE_SERVICES }, outcome: { kind: 'enum', values: GOOGLE_OUTCOMES } },
  },
  {
    key: 'googleRequestDuration',
    name: 'app.connections.google.duration_ms',
    kind: 'histogram',
    unit: 'ms',
    description: 'Wall time of one Google adapter call, retries and waits included.',
    buckets: [50, 100, 250, 500, 1000, 2500, 5000, 15000, 30000],
    attributes: { service: { kind: 'enum', values: GOOGLE_SERVICES } },
  },
];
registerAppMetrics(GOOGLE_METRICS);
