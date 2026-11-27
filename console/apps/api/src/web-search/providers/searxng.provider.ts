// SearXNG (E50.8, #978): a self-hosted metasearch instance, no key, no per-call cost. Decision record `docs/decisions/web-search.md`
// §1, SearXNG row.
//
//   GET <baseUrl>/search?q=…&format=json&categories=general&pageno=1&time_range=day|week|month|year     (`site:` in `q`)
//   results[].title / .url / .content → snippet / .publishedDate → WebSearchHit (SearXNG has no count: the first `count` are kept)
//
// The address is the administrator's setting `webSearch.providers.searxng.baseUrl`. It goes through `OutboundHttp`'s address check
// like any provider: https and a public address. Only when the administrator ticked "this instance is on my private network"
// (`allowPrivate`) does the check accept a private address and http, and then FOR THE CONFIGURED HOST ONLY (`allowedHosts: [host]`,
// `allowInsecureHttp`), never for another host, a redirect (never followed) or a page a result names. docs/web-search.md, "Threat model".
//
// A 403 usually means the instance has the JSON format switched off (`search.formats` in its settings.yml): a search reads it as
// `UNAVAILABLE` (the next provider is tried), and the diagnostic report names it `FORMAT_DISABLED`.
import { Injectable, type OnModuleInit } from '@nestjs/common';
import { WebToolError, type WebSearchHit, type WebSearchResult } from '@marinoscar/hexactra-web-agent';

import { OutboundHttp, type OutboundResponse } from '../../oauth-client/outbound-http';
import type { DiagnosticStage } from '../diagnostic-stage';
import { SearchProviderRegistry, type ProviderAuth, type ProviderDiagnoseOptions, type SearchProvider, type SearchRequest } from '../search-provider';
import { DIAGNOSTIC_QUERY, probeHost, providerStages } from '../web-search-diagnostics';
import { clampCount, hitOf, hitsOf, isSuccess, jsonBody, rateLimited, sendProviderRequest, siteOperand } from './provider-kit';

/** The most hits kept from one answer (the tool's maximum). */
export const SEARXNG_MAX_COUNT = 20;
/** The provider's own diagnostic code: the instance answers 403 to `format=json`. */
export const FORMAT_DISABLED = 'FORMAT_DISABLED';

/** A 403 of the search endpoint: `UNAVAILABLE` to a search, `FORMAT_DISABLED` in the diagnostic report. */
export class SearxngFormatDisabled extends WebToolError {
  constructor() {
    super('UNAVAILABLE');
  }
}

/** The search endpoint under the configured address (which may have a path prefix such as `/searx`). Null when it is not one. */
export function searxngEndpoint(baseUrl: string): URL | null {
  try {
    const u = new URL(baseUrl);
    if ((u.protocol !== 'https:' && u.protocol !== 'http:') || u.username || u.password) return null;
    u.search = '';
    u.hash = '';
    u.pathname = `${u.pathname.replace(/\/+$/, '')}/search`;
    return u;
  } catch {
    return null;
  }
}

/** The address of one search. */
export function searxngUrl(baseUrl: string, req: Pick<SearchRequest, 'query' | 'freshness' | 'site'>): string | null {
  const u = searxngEndpoint(baseUrl);
  if (!u) return null;
  const site = siteOperand(req.site);
  u.searchParams.set('q', site ? `${req.query} site:${site}` : req.query);
  u.searchParams.set('format', 'json');
  u.searchParams.set('categories', 'general');
  u.searchParams.set('pageno', '1');
  if (req.freshness) u.searchParams.set('time_range', req.freshness);
  return u.toString();
}

/** The address-check exemption of the configured host: only with `allowPrivate`. */
export function searxngTransport(auth: Extract<ProviderAuth, { kind: 'none' }>): { allowedHosts: string[]; allowInsecureHttp: boolean } {
  if (!auth.allowPrivate) return { allowedHosts: [], allowInsecureHttp: false };
  const host = new URL(auth.baseUrl).hostname.replace(/^\[|\]$/g, '');
  return { allowedHosts: [host], allowInsecureHttp: true };
}

export function searxngFailure(res: OutboundResponse): WebToolError {
  if (res.status === 403) return new SearxngFormatDisabled();
  if (res.status === 401) return new WebToolError('AUTH_REFUSED'); // the operator's proxy asks for a sign-in
  if (res.status === 429) return rateLimited(res.headers); // its limiter
  return new WebToolError('UNAVAILABLE');
}

export function searxngHits(body: string, max: number): WebSearchHit[] {
  const results = (jsonBody(body) as { results?: unknown } | null)?.results;
  if (results === undefined) return [];
  if (!Array.isArray(results)) throw new WebToolError('UNAVAILABLE');
  return hitsOf(results as Record<string, unknown>[], max, (r) => hitOf(r.title, r.url, r.content, r.publishedDate));
}

@Injectable()
export class SearxngSearchProvider implements SearchProvider, OnModuleInit {
  readonly id = 'searxng';
  readonly label = 'SearXNG (self-hosted)';
  readonly kind = 'results' as const;
  readonly credential = 'none' as const;
  /** None of its own: the egress list names the configured address's host. */
  readonly hosts = [] as const;
  readonly estimatedCostPerCallUsd = 0;
  readonly diagnosticCodes = [FORMAT_DISABLED] as const;

  constructor(
    private readonly registry: SearchProviderRegistry,
    private readonly http: OutboundHttp,
  ) {}

  onModuleInit(): void {
    this.registry.register(this);
  }

  async search(req: SearchRequest, auth: ProviderAuth): Promise<WebSearchResult> {
    if (auth.kind !== 'none') throw new WebToolError('NOT_CONFIGURED');
    const url = searxngUrl(auth.baseUrl, req);
    if (!url) throw new WebToolError('NOT_CONFIGURED');
    const res = await sendProviderRequest(this.http, { method: 'GET', url, headers: { accept: 'application/json' }, signal: req.signal, ...searxngTransport(auth) });
    if (!isSuccess(res)) throw searxngFailure(res);
    return { provider: this.id, hits: searxngHits(res.body, clampCount(req.count, SEARXNG_MAX_COUNT)), answer: null };
  }

  /** `network`: a GET of the configured address (the same exemption as a search); `live_query`: the fixed word, `FORMAT_DISABLED` on 403. */
  async diagnose(auth: ProviderAuth, signal: AbortSignal, opts: ProviderDiagnoseOptions = {}): Promise<DiagnosticStage[]> {
    let formatDisabled = false;
    const stages = await providerStages({
      network: async (s) => {
        if (auth.kind !== 'none' || !searxngEndpoint(auth.baseUrl)) return { status: 'fail', code: 'ADDRESS_MISSING' };
        return probeHost(this.http, auth.baseUrl, s, searxngTransport(auth));
      },
      query: async (s) => {
        try {
          return await this.search({ query: DIAGNOSTIC_QUERY, count: 1, freshness: null, site: null, signal: s }, auth);
        } catch (e) {
          formatDisabled = e instanceof SearxngFormatDisabled;
          throw e;
        }
      },
      signal,
      liveQuery: opts.liveQuery ?? true,
    });
    if (formatDisabled) {
      const live = stages.find((st) => st.id === 'live_query');
      if (live) Object.assign(live, { status: 'fail', code: FORMAT_DISABLED, remedy: FORMAT_DISABLED });
    }
    return stages;
  }
}
