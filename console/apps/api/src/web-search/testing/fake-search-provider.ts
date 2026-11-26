// A fake search provider (E50.5, #975): canned hits, `failNext(code)`, and a log of the requests it got. The log never holds the
// key: only whether one was presented and its tier is the caller's business. INVENTED data (`*.example.test`).
import { WebToolError, type WebSearchHit, type WebSearchResult, type WebToolErrorCode } from '@marinoscar/hexactra-web-agent';

import type { SecretBytes } from '../../secrets/secrets-provider.port';
import type { DiagnosticStage } from '../diagnostic-stage';
import type { ProviderAuth, SearchProvider, SearchRequest } from '../search-provider';

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

  async diagnose(auth: ProviderAuth | null): Promise<DiagnosticStage[]> {
    return [{ id: 'config', status: auth ? 'pass' : 'fail', code: auth ? null : 'NO_KEY', remedy: auth ? null : 'web_search.set_key', ms: null }];
  }
}
