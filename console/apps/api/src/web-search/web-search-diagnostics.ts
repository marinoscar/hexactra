// The stages of a search provider's diagnostic report (E50.13, #983; epic E50 Design §4). Shared by every provider's `diagnose`:
//
//   switches     the deployment's and the user's switch, the provider's own switch, its place in `order`        (the service)
//   credential   which tier answers and where it is kept; a self-hosted provider's address; an AI provider's key   (the service)
//   network      the provider's host resolves and connects: one GET of its root, no key, any HTTP answer passes     (the provider)
//   live_query   ONE real search of the fixed word {@link DIAGNOSTIC_QUERY} with `count: 1`                         (the provider)
//   limits       today's count against the per-day limit                                                         (the service)
//   fetch        `web_fetch` is on and reads the fixed page {@link FETCH_CHECK_URL}                                  (the service)
//
// The query and the page are constants: nothing a user typed is sent. A stage holds codes, counts, timings and a host name; never a
// key, a query, a result or a provider's message.
import { isWebToolError, type WebSearchResult } from '@marinoscar/hexactra-web-agent';

import type { DiagnosticStage } from '../diagnostics/diagnostic-report';
import type { StageOutcome } from '../diagnostics/stages';
import { OutboundHttp, OutboundHttpError } from '../oauth-client/outbound-http';

/** The word the live query searches for: neutral, common, fixed in code. Never what a user typed. */
export const DIAGNOSTIC_QUERY = 'weather';
/** The public page the `fetch` stage reads: IANA's documentation domain (RFC 2606), small and stable. Listed in the egress entry. */
export const FETCH_CHECK_URL = 'https://example.com/';
export const FETCH_CHECK_HOST = 'example.com';
/** `LIMIT_NEAR` over this share of the per-day limit. */
export const LIMIT_NEAR_RATIO = 0.8;
/** The connect probe of the `network` stage. */
export const NETWORK_PROBE_TIMEOUT_MS = 5_000;
const NETWORK_PROBE_MAX_BYTES = 4 * 1024;

/** Every code a search provider's report can carry. Each has an entry in the remedy table (test/diagnostics.spec.ts). */
export const SEARCH_DIAGNOSTIC_CODES: readonly string[] = [
  // switches
  'SEARCH_OFF',
  'PROVIDER_OFF',
  'NOT_IN_ORDER',
  // credential
  'KEY_MISSING',
  'DEPLOYMENT_KEY_NOT_SHARED',
  'USER_KEYS_NOT_ALLOWED',
  'SECRETS_PROVIDER_UNAVAILABLE',
  'MODEL_NOT_CHOSEN',
  'ADDRESS_MISSING',
  // network
  'UNRESOLVABLE',
  'PRIVATE_TARGET',
  'TLS_FAILED',
  'TIMEOUT',
  'NETWORK',
  // live_query
  'AUTH_REFUSED',
  'RATE_LIMITED',
  'QUOTA_EXCEEDED',
  'UNAVAILABLE',
  'FORMAT_DISABLED',
  'NO_RESULTS',
  // limits
  'LIMIT_REACHED',
  'LIMIT_NEAR',
  // fetch
  'FETCH_OFF',
  'BLOCKED',
  // the stage runner
  'ABORTED',
  'DEADLINE_EXCEEDED',
  'UNKNOWN',
];

/**
 * The remedy key of a code in a search report, where the words differ from a connection's (a refused KEY, not a refused sign-in).
 * A code not listed here uses its own entry.
 */
export const SEARCH_REMEDIES: Readonly<Record<string, string>> = {
  AUTH_REFUSED: 'SEARCH_KEY_REFUSED',
  RATE_LIMITED: 'SEARCH_RATE_LIMITED',
  QUOTA_EXCEEDED: 'SEARCH_QUOTA_EXCEEDED',
  UNAVAILABLE: 'SEARCH_UNAVAILABLE',
  PRIVATE_TARGET: 'SEARCH_PRIVATE_TARGET',
  PROVIDER_OFF: 'SEARCH_PROVIDER_OFF',
};

export const searchRemedy = (code: string | null | undefined): string | null => (code ? (SEARCH_REMEDIES[code] ?? code) : null);

/** TLS failures arrive as `network` with the socket's error code in the message: read for that code only, never copied. */
const TLS_ERROR = /\((CERT_|ERR_TLS|ERR_SSL|UNABLE_TO_|DEPTH_ZERO|SELF_SIGNED|HOSTNAME_MISMATCH)/;

/** A transport refusal of `OutboundHttp`, as a `network` outcome. */
export function transportOutcome(e: unknown): StageOutcome {
  if (!(e instanceof OutboundHttpError)) return { status: 'fail', code: 'NETWORK' };
  switch (e.code) {
    case 'unresolvable':
      return { status: 'fail', code: 'UNRESOLVABLE' };
    case 'private_target':
      return { status: 'fail', code: 'PRIVATE_TARGET', remedy: 'SEARCH_PRIVATE_TARGET' };
    case 'timeout':
      return { status: 'fail', code: 'TIMEOUT' };
    case 'aborted':
      return { status: 'fail', code: 'ABORTED' };
    case 'network':
      return { status: 'fail', code: TLS_ERROR.test(e.message) ? 'TLS_FAILED' : 'NETWORK' };
    default:
      return { status: 'fail', code: 'NETWORK' };
  }
}

/** `network`: one GET of the provider's root with no key. Any HTTP answer means the host resolved and connected. */
export async function probeHost(http: OutboundHttp, url: string, signal: AbortSignal): Promise<StageOutcome> {
  const host = new URL(url).hostname;
  try {
    await http.send({ method: 'GET', url, headers: { accept: '*/*' }, timeoutMs: NETWORK_PROBE_TIMEOUT_MS, maxBytes: NETWORK_PROBE_MAX_BYTES, signal });
    return { status: 'pass', data: { host } };
  } catch (e) {
    // More than a few bytes came back: it connected.
    if (e instanceof OutboundHttpError && e.code === 'too_large') return { status: 'pass', data: { host } };
    const o = transportOutcome(e);
    return { ...o, data: { host } };
  }
}

/** `live_query`: the outcome of the one search. A failure is a closed code with the search words of the remedy table. */
export function liveQueryOutcome(result: WebSearchResult | null, error: unknown, ms: number): StageOutcome {
  if (error !== null && error !== undefined) {
    const code = isWebToolError(error) ? error.code : 'UNAVAILABLE';
    if (code === 'RATE_LIMITED') return { status: 'warn', code, remedy: searchRemedy(code), data: { ms } };
    if (code === 'NOT_CONFIGURED') return { status: 'fail', code: 'KEY_MISSING', data: { ms } };
    const known = ['AUTH_REFUSED', 'QUOTA_EXCEEDED', 'UNAVAILABLE', 'ABORTED', 'LIMIT_REACHED'].includes(code) ? code : 'UNAVAILABLE';
    return { status: 'fail', code: known, remedy: searchRemedy(known), data: { ms } };
  }
  const hits = result ? result.hits.length + (result.answer ? 1 : 0) : 0;
  if (hits === 0) return { status: 'warn', code: 'NO_RESULTS', data: { hits: 0, ms } };
  return { status: 'pass', data: { hits: result!.hits.length, ms } };
}

export interface ProviderStageInput {
  /** The `network` probe (usually {@link probeHost} on the provider's root). */
  network: (signal: AbortSignal) => Promise<StageOutcome>;
  /** The live search of {@link DIAGNOSTIC_QUERY}, `count: 1`. */
  query: (signal: AbortSignal) => Promise<WebSearchResult>;
  signal: AbortSignal;
  /** False when today's limit is reached: the query is not sent (`LIMIT_REACHED`). */
  liveQuery: boolean;
  clock?: () => number;
}

const stage = (id: string, o: StageOutcome, ms: number | null): DiagnosticStage => ({
  id,
  status: o.status,
  code: o.code ?? null,
  remedy: o.remedy ?? searchRemedy(o.code),
  ms,
  ...(o.data ? { data: o.data } : {}),
});

/** The provider's two stages, `network` then `live_query` (skipped after a failed `network`). Never throws for the provider's answer. */
export async function providerStages(input: ProviderStageInput): Promise<DiagnosticStage[]> {
  const clock = input.clock ?? Date.now;
  let started = clock();
  let net: StageOutcome;
  try {
    net = await input.network(input.signal);
  } catch (e) {
    net = transportOutcome(e);
  }
  const out = [stage('network', net, clock() - started)];
  if (net.status === 'fail') {
    out.push({ id: 'live_query', status: 'skipped', code: null, remedy: null, ms: null });
    return out;
  }
  if (!input.liveQuery) {
    out.push({ id: 'live_query', status: 'skipped', code: 'LIMIT_REACHED', remedy: 'LIMIT_REACHED', ms: null });
    return out;
  }
  started = clock();
  let result: WebSearchResult | null = null;
  let error: unknown = null;
  try {
    result = await input.query(input.signal);
  } catch (e) {
    error = e ?? new Error('failed');
  }
  const ms = clock() - started;
  out.push(stage('live_query', liveQueryOutcome(result, error, ms), ms));
  return out;
}
