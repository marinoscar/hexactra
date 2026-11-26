// The instruments of web search (E50.5, #975). Bounded labels only: `provider` is a registered provider id (anything else is
// counted as `other`), `outcome` a closed set. Never the query, a host of a result or a key. Names are permanent once dashboards
// read them (the console's own instruments are `app.*`).
import { registerAppMetrics, type AppMetricDef } from '@marinoscar/platform-api/otel-core';

export const WEB_SEARCH_OUTCOMES = ['ok', 'auth', 'rate_limited', 'quota', 'unavailable', 'limit'] as const;
export type WebSearchOutcome = (typeof WEB_SEARCH_OUTCOMES)[number];

export const WEB_SEARCH_METRICS: readonly AppMetricDef[] = [
  {
    key: 'webSearchCalls',
    name: 'app.web_search.calls',
    kind: 'counter',
    unit: '{call}',
    description: 'Web searches, by provider and outcome (ok, auth, rate_limited, quota, unavailable; limit: refused by the per-day or per-run limit before any call).',
    attributes: { provider: { kind: 'free' }, outcome: { kind: 'enum', values: WEB_SEARCH_OUTCOMES } },
  },
  {
    key: 'webSearchDuration',
    name: 'app.web_search.duration',
    kind: 'histogram',
    unit: 's',
    description: 'How long one call to a search provider took, by provider.',
    buckets: [0.1, 0.25, 0.5, 1, 2, 3, 5, 10],
    attributes: { provider: { kind: 'free' } },
  },
];
registerAppMetrics(WEB_SEARCH_METRICS);

/** A `WebToolError` code as the metric's outcome. */
export function outcomeOf(code: string | null): WebSearchOutcome {
  switch (code) {
    case null:
      return 'ok';
    case 'AUTH_REFUSED':
      return 'auth';
    case 'RATE_LIMITED':
      return 'rate_limited';
    case 'QUOTA_EXCEEDED':
      return 'quota';
    case 'LIMIT_REACHED':
      return 'limit';
    default:
      return 'unavailable';
  }
}
