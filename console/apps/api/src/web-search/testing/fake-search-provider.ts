// A fake search provider (E50.5, #975): canned hits, `failNext(code)`, and a log of the requests it got. The log never holds the
// key: only whether one was presented and its tier is the caller's business. INVENTED data (`*.example.test`).
import { WebToolError, type WebSearchHit, type WebSearchResult, type WebToolErrorCode } from '@marinoscar/hexactra-web-agent';

import type { SecretBytes } from '../../secrets/secrets-provider.port';
import type { DiagnosticStage } from '../diagnostic-stage';
import type { ProviderAuth, ProviderDiagnoseOptions, SearchProvider, SearchRequest } from '../search-provider';
import { DIAGNOSTIC_QUERY, providerStages } from '../web-search-diagnostics';

export interface FakeSearchLogEntry {
  query: string;
  count: number;
  freshness: SearchRequest['freshness'];
  site: string | null;
  authKind: ProviderAuth['kind'];
  /** The key was still readable when the provider got it. Never the key. */
  keyPresent: boolean;
}

export const FAKE_HITS: readonly WebSearchHit[] = [
  { title: 'Person A writes about example widgets', url: 'https://docs.example.test/widgets', snippet: 'An invented page about widgets.', publishedAt: '2026-11-01T00:00:00Z' },
  { title: 'Widget catalogue', url: 'https://shop.example.test/catalogue', snippet: 'Invented catalogue entries.', publishedAt: null },
];

export class FakeSearchProvider implements SearchProvider {
  readonly kind = 'results' as const;
  readonly hosts: readonly string[];
  readonly log: FakeSearchLogEntry[] = [];
  hits: WebSearchHit[] = [...FAKE_HITS];
  private failures: { code: WebToolErrorCode; retryAfterMs?: number }[] = [];
  /** Keys this provider saw were wiped after the call (checked by the caller with `auth.key.wiped`). */
  readonly seenKeys: SecretBytes[] = [];

  constructor(
    readonly id: string,
    readonly label = `Fake ${id}`,
    readonly credential: SearchProvider['credential'] = 'api_key',
    readonly estimatedCostPerCallUsd: number | null = 0.001,
  ) {
    this.hosts = [`${id}.search.example.test`];
  }

  failNext(code: WebToolErrorCode, retryAfterMs?: number): this {
    this.failures.push(retryAfterMs === undefined ? { code } : { code, retryAfterMs });
    return this;
  }

  async search(req: SearchRequest, auth: ProviderAuth): Promise<WebSearchResult> {
    const keyPresent = auth.kind === 'api_key' && !auth.key.wiped;
    if (auth.kind === 'api_key') this.seenKeys.push(auth.key);
    this.log.push({ query: req.query, count: req.count, freshness: req.freshness, site: req.site, authKind: auth.kind, keyPresent });
    if (req.signal.aborted) throw new WebToolError('ABORTED');
    const fail = this.failures.shift();
    if (fail) throw new WebToolError(fail.code, fail.retryAfterMs === undefined ? {} : { retryAfterMs: fail.retryAfterMs });
    return { provider: this.id, hits: this.hits.slice(0, req.count), answer: null };
  }

  /** The next `network` stage answers with this (a code of `SEARCH_DIAGNOSTIC_CODES`), once. */
  failNetworkNext(code: 'UNRESOLVABLE' | 'PRIVATE_TARGET' | 'TLS_FAILED' | 'TIMEOUT' | 'NETWORK'): this {
    this.networkFailures.push(code);
    return this;
  }

  /** The next live query answers with a provider code of its own (SearXNG's `FORMAT_DISABLED`), once. */
  liveCodeNext(code: string): this {
    this.liveCodes.push(code);
    return this;
  }

  private networkFailures: string[] = [];
  private liveCodes: string[] = [];
  readonly diagnosticCodes = ['FORMAT_DISABLED'] as const;
  /** How many network probes and live queries the diagnostics made. */
  probes = 0;

  async diagnose(auth: ProviderAuth, signal: AbortSignal, opts: ProviderDiagnoseOptions = {}): Promise<DiagnosticStage[]> {
    const stages = await providerStages({
      network: async () => {
        this.probes += 1;
        const code = this.networkFailures.shift();
        return code ? { status: 'fail', code, data: { host: this.hosts[0]! } } : { status: 'pass', data: { host: this.hosts[0]! } };
      },
      query: (s) => this.search({ query: DIAGNOSTIC_QUERY, count: 1, freshness: null, site: null, signal: s }, auth),
      signal,
      liveQuery: opts.liveQuery ?? true,
    });
    const own = this.liveCodes.shift();
    const live = stages.find((st) => st.id === 'live_query');
    if (own && live && live.status !== 'skipped') Object.assign(live, { status: 'fail', code: own, remedy: own });
    return stages;
  }
}
