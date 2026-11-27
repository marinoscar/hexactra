// Tavily (E50.8, #978): a keyed search API built for agents. Decision record `docs/decisions/web-search.md` §1, Tavily row.
//
//   POST https://api.tavily.com/search
//   header Authorization: Bearer <key>          (the key is sent in this header ONLY, never in the URL or the body)
//   body { query, max_results, search_depth: "basic", topic: "general", time_range?, include_domains?,
//          include_answer: false, include_raw_content: false, include_images: false }
//   results[].title / .url / .content → snippet / .published_date → WebSearchHit
//
// The plain (`basic`) depth, one credit, by default; no answer and no page text are asked for (`web_fetch` reads pages). Status
// codes: 401/403 the key is refused, 429 the rate, 432 (plan limit) and 433 (pay-as-you-go limit) the quota.
import { Injectable, type OnModuleInit } from '@nestjs/common';
import { WebToolError, type WebSearchHit, type WebSearchResult } from '@marinoscar/hexactra-web-agent';

import { OutboundHttp, type OutboundResponse } from '../../oauth-client/outbound-http';
import type { DiagnosticStage } from '../diagnostic-stage';
import { SearchProviderRegistry, type ProviderAuth, type ProviderDiagnoseOptions, type SearchProvider, type SearchRequest } from '../search-provider';
import { DIAGNOSTIC_QUERY, probeHost, providerStages } from '../web-search-diagnostics';
import { clampCount, hitOf, hitsOf, isSuccess, jsonBody, sendProviderRequest, siteOperand, statusFailure } from './provider-kit';

export const TAVILY_HOST = 'api.tavily.com';
export const TAVILY_ENDPOINT = `https://${TAVILY_HOST}/search`;
/** Tavily's documented maximum for `max_results`. */
export const TAVILY_MAX_COUNT = 20;
/** One credit per basic search, about USD 0.008 a credit pay-as-you-go (decision record §1, 2026-11-26): a default the administrator overrides. */
export const TAVILY_ESTIMATED_COST_PER_CALL_USD = 0.008;
/** Tavily's quota statuses: the plan's limit (432) and the pay-as-you-go limit (433). */
export const TAVILY_QUOTA_STATUSES: ReadonlySet<number> = new Set([432, 433]);

/** The body of one search. Never holds the key. */
export function tavilyBody(req: Pick<SearchRequest, 'query' | 'count' | 'freshness' | 'site'>): Record<string, unknown> {
  const site = siteOperand(req.site);
  return {
    query: req.query,
    max_results: clampCount(req.count, TAVILY_MAX_COUNT),
    search_depth: 'basic',
    topic: 'general',
    include_answer: false,
    include_raw_content: false,
    include_images: false,
    ...(req.freshness ? { time_range: req.freshness } : {}),
    ...(site ? { include_domains: [site] } : {}),
  };
}

export function tavilyFailure(res: OutboundResponse): WebToolError {
  if (TAVILY_QUOTA_STATUSES.has(res.status)) return new WebToolError('QUOTA_EXCEEDED');
  return statusFailure(res);
}

export function tavilyHits(body: string, max: number): WebSearchHit[] {
  const results = (jsonBody(body) as { results?: unknown } | null)?.results;
  if (results === undefined) return [];
  if (!Array.isArray(results)) throw new WebToolError('UNAVAILABLE');
  return hitsOf(results as Record<string, unknown>[], max, (r) => hitOf(r.title, r.url, r.content, r.published_date));
}

@Injectable()
export class TavilySearchProvider implements SearchProvider, OnModuleInit {
  readonly id = 'tavily';
  readonly label = 'Tavily';
  readonly kind = 'results' as const;
  readonly credential = 'api_key' as const;
  readonly hosts = [TAVILY_HOST] as const;
  readonly estimatedCostPerCallUsd = TAVILY_ESTIMATED_COST_PER_CALL_USD;

  constructor(
    private readonly registry: SearchProviderRegistry,
    private readonly http: OutboundHttp,
  ) {}

  onModuleInit(): void {
    this.registry.register(this);
  }

  async search(req: SearchRequest, auth: ProviderAuth): Promise<WebSearchResult> {
    if (auth.kind !== 'api_key') throw new WebToolError('NOT_CONFIGURED');
    const body = JSON.stringify(tavilyBody(req));
    const res = await auth.key.expose((bytes) =>
      sendProviderRequest(this.http, { method: 'POST', url: TAVILY_ENDPOINT, headers: { accept: 'application/json', 'content-type': 'application/json', authorization: `Bearer ${bytes.toString('utf8')}` }, body, signal: req.signal }),
    );
    if (!isSuccess(res)) throw tavilyFailure(res);
    return { provider: this.id, hits: tavilyHits(res.body, clampCount(req.count, TAVILY_MAX_COUNT)), answer: null };
  }

  async diagnose(auth: ProviderAuth, signal: AbortSignal, opts: ProviderDiagnoseOptions = {}): Promise<DiagnosticStage[]> {
    return providerStages({
      network: (s) => probeHost(this.http, `https://${TAVILY_HOST}/`, s),
      query: (s) => this.search({ query: DIAGNOSTIC_QUERY, count: 1, freshness: null, site: null, signal: s }, auth),
      signal,
      liveQuery: opts.liveQuery ?? true,
    });
  }
}
