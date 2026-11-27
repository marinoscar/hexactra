// Exa (E50.8, #978): a keyed search API built for agents. Decision record `docs/decisions/web-search.md` §1, Exa row.
//
//   POST https://api.exa.ai/search
//   header x-api-key: <key>                     (the key is sent in this header ONLY, never in the URL or the body)
//   body { query, numResults, type: "auto", includeDomains?, startPublishedDate?, contents: { highlights: { numSentences, highlightsPerUrl: 1 } } }
//   results[].title / .url / .highlights[0] → snippet / .publishedDate → WebSearchHit
//
// The default (`auto`) search; no page text is asked for (`web_fetch` reads pages): one short highlight per result is the snippet.
// Freshness is a start date (`startPublishedDate`, ISO 8601) one day, week, month or year back. Status codes: 401/403 the key is
// refused, 402 the credits are spent, 429 the rate.
import { Injectable, type OnModuleInit } from '@nestjs/common';
import { WebToolError, type WebSearchHit, type WebSearchResult } from '@marinoscar/hexactra-web-agent';

import { OutboundHttp } from '../../oauth-client/outbound-http';
import type { DiagnosticStage } from '../diagnostic-stage';
import { SearchProviderRegistry, type ProviderAuth, type ProviderDiagnoseOptions, type SearchProvider, type SearchRequest } from '../search-provider';
import { DIAGNOSTIC_QUERY, probeHost, providerStages } from '../web-search-diagnostics';
import { clampCount, hitOf, hitsOf, isSuccess, jsonBody, sendProviderRequest, siteOperand, statusFailure } from './provider-kit';

export const EXA_HOST = 'api.exa.ai';
export const EXA_ENDPOINT = `https://${EXA_HOST}/search`;
/** The most results one priced search returns (1 to 25, decision record §1). */
export const EXA_MAX_COUNT = 25;
/** The sentences of the one highlight that is the snippet. */
export const EXA_HIGHLIGHT_SENTENCES = 3;
/**
 * About USD 5 per 1,000 searches plus the highlights (about USD 1 per 1,000 pages) of a few results (decision record §1, 2026-11-26):
 * a default the administrator overrides.
 */
export const EXA_ESTIMATED_COST_PER_CALL_USD = 0.01;

const DAY_MS = 86_400_000;
const WINDOW_MS = { day: DAY_MS, week: 7 * DAY_MS, month: 31 * DAY_MS, year: 366 * DAY_MS } as const;

/** The body of one search. Never holds the key. */
export function exaBody(req: Pick<SearchRequest, 'query' | 'count' | 'freshness' | 'site'>, now: Date): Record<string, unknown> {
  const site = siteOperand(req.site);
  return {
    query: req.query,
    numResults: clampCount(req.count, EXA_MAX_COUNT),
    type: 'auto',
    ...(site ? { includeDomains: [site] } : {}),
    ...(req.freshness ? { startPublishedDate: new Date(now.getTime() - WINDOW_MS[req.freshness]).toISOString() } : {}),
    contents: { highlights: { numSentences: EXA_HIGHLIGHT_SENTENCES, highlightsPerUrl: 1 } },
  };
}

export function exaHits(body: string, max: number): WebSearchHit[] {
  const results = (jsonBody(body) as { results?: unknown } | null)?.results;
  if (results === undefined) return [];
  if (!Array.isArray(results)) throw new WebToolError('UNAVAILABLE');
  return hitsOf(results as Record<string, unknown>[], max, (r) => {
    const highlight = Array.isArray(r.highlights) ? r.highlights.find((h): h is string => typeof h === 'string') : undefined;
    return hitOf(r.title, r.url, highlight ?? r.summary ?? '', r.publishedDate);
  });
}

@Injectable()
export class ExaSearchProvider implements SearchProvider, OnModuleInit {
  readonly id = 'exa';
  readonly label = 'Exa';
  readonly kind = 'results' as const;
  readonly credential = 'api_key' as const;
  readonly hosts = [EXA_HOST] as const;
  readonly estimatedCostPerCallUsd = EXA_ESTIMATED_COST_PER_CALL_USD;

  /** The wall clock (the freshness start date); tests replace it. */
  clock: () => Date = () => new Date();

  constructor(
    private readonly registry: SearchProviderRegistry,
    private readonly http: OutboundHttp,
  ) {}

  onModuleInit(): void {
    this.registry.register(this);
  }

  async search(req: SearchRequest, auth: ProviderAuth): Promise<WebSearchResult> {
    if (auth.kind !== 'api_key') throw new WebToolError('NOT_CONFIGURED');
    const body = JSON.stringify(exaBody(req, this.clock()));
    const res = await auth.key.expose((bytes) =>
      sendProviderRequest(this.http, { method: 'POST', url: EXA_ENDPOINT, headers: { accept: 'application/json', 'content-type': 'application/json', 'x-api-key': bytes.toString('utf8') }, body, signal: req.signal }),
    );
    if (!isSuccess(res)) throw statusFailure(res);
    return { provider: this.id, hits: exaHits(res.body, clampCount(req.count, EXA_MAX_COUNT)), answer: null };
  }

  async diagnose(auth: ProviderAuth, signal: AbortSignal, opts: ProviderDiagnoseOptions = {}): Promise<DiagnosticStage[]> {
    return providerStages({
      network: (s) => probeHost(this.http, `https://${EXA_HOST}/`, s),
      query: (s) => this.search({ query: DIAGNOSTIC_QUERY, count: 1, freshness: null, site: null, signal: s }, auth),
      signal,
      liveQuery: opts.liveQuery ?? true,
    });
  }
}
