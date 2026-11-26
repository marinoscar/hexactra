// The instruments of web_fetch (E50.6, #976). Bounded labels only: `outcome` and `content` are closed sets. Never an address, a host,
// a title or page text. The console's own instruments are named `app.*` (the issue wrote `hexactra.web_fetch.*`).
import { registerAppMetrics, type AppMetricDef } from '@marinoscar/platform-api/otel-core';

export const WEB_FETCH_OUTCOMES = ['ok', 'blocked', 'not_allowed', 'too_large', 'unsupported', 'unavailable'] as const;
export type WebFetchOutcome = (typeof WEB_FETCH_OUTCOMES)[number];

export const WEB_FETCH_METRICS: readonly AppMetricDef[] = [
  {
    key: 'webFetchCalls',
    name: 'app.web_fetch.calls',
    kind: 'counter',
    unit: '{call}',
    description: 'Pages web_fetch was asked to read on the console server, by outcome (ok, blocked, not_allowed, too_large, unsupported, unavailable). A cache hit counts as ok; a Stop is not counted.',
    attributes: { outcome: { kind: 'enum', values: WEB_FETCH_OUTCOMES } },
  },
  {
    key: 'webFetchDuration',
    name: 'app.web_fetch.duration',
    kind: 'histogram',
    unit: 's',
    description: 'How long one web_fetch read took, every redirect and the extraction included.',
    buckets: [0.1, 0.25, 0.5, 1, 2, 3, 5, 10, 15],
    attributes: {},
  },
];
registerAppMetrics(WEB_FETCH_METRICS);

/** A `WebToolError` code (null: a page) as the metric's outcome. */
export function fetchOutcomeOf(code: string | null): WebFetchOutcome {
  switch (code) {
    case null:
      return 'ok';
    case 'BLOCKED':
      return 'blocked';
    case 'NOT_ALLOWED':
      return 'not_allowed';
    case 'TOO_LARGE':
      return 'too_large';
    case 'UNSUPPORTED_TYPE':
      return 'unsupported';
    default:
      return 'unavailable';
  }
}

/** The size class of an answer, for the span: never the exact size. */
export function sizeClassOf(bytes: number): string {
  if (bytes < 10 * 1024) return 'lt_10k';
  if (bytes < 100 * 1024) return 'lt_100k';
  if (bytes < 1024 * 1024) return 'lt_1m';
  return 'lt_5m';
}
