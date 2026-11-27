// Brave Search (E50.5, #975): the first search provider. Decision record `docs/decisions/web-search.md` §1, Brave row.
//
//   GET https://api.search.brave.com/res/v1/web/search?q=…&count=…&freshness=pd|pw|pm|py
//   header X-Subscription-Token: <key>          (the key is sent in this header ONLY, never in the URL)
//   web.results[].title / .url / .description (HTML-marked: tags stripped) / .page_age → WebSearchHit
//
// Every call goes through `OutboundHttp` (address checked, pinned, no redirect followed) with a 10 s deadline and a 512 kB cap. The
// provider's error body is read for its CODE only (`QUOTA_LIMITED`-style), never copied anywhere: what leaves this file is a
// `WebToolError`.
import { Injectable, type OnModuleInit } from '@nestjs/common';
import { WebToolError, type WebSearchHit, type WebSearchResult } from '@marinoscar/hexactra-web-agent';

import { OutboundHttp, type OutboundResponse } from '../../oauth-client/outbound-http';
import type { DiagnosticStage } from '../diagnostic-stage';
import { SearchProviderRegistry, type ProviderAuth, type ProviderDiagnoseOptions, type SearchProvider, type SearchRequest } from '../search-provider';
import { DIAGNOSTIC_QUERY, probeHost, providerStages } from '../web-search-diagnostics';
import { clampCount, hitOf, hitsOf, isSuccess, jsonBody, plainText, sendProviderRequest, siteOperand, statusFailure, webUrl } from './provider-kit';

export const BRAVE_HOST = 'api.search.brave.com';
export const BRAVE_ENDPOINT = `https://${BRAVE_HOST}/res/v1/web/search`;
/** Brave's documented maximum for `count`. */
export const BRAVE_MAX_COUNT = 20;
export const BRAVE_TIMEOUT_MS = 10_000;
export const BRAVE_MAX_BYTES = 512 * 1024;
/** About USD 5 per 1,000 calls on the paid plan (decision record §1, 2026-11-26): a default the administrator overrides. */
export const BRAVE_ESTIMATED_COST_PER_CALL_USD = 0.005;

const FRESHNESS = { day: 'pd', week: 'pw', month: 'pm', year: 'py' } as const;

export { plainText, siteOperand, webUrl };

/** The address of one search. Never holds the key. */
export function braveUrl(req: Pick<SearchRequest, 'query' | 'count' | 'freshness' | 'site'>): string {
  const site = siteOperand(req.site);
  const params = new URLSearchParams({ q: site ? `${req.query} site:${site}` : req.query, count: String(clampCount(req.count, BRAVE_MAX_COUNT)) });
  if (req.freshness) params.set('freshness', FRESHNESS[req.freshness]);
  return `${BRAVE_ENDPOINT}?${params.toString()}`;
}

/** The provider's error code, read from its JSON body (`{ error: { code } }`). Used to tell a quota from a rate; never copied out. */
function errorCode(body: string): string {
  try {
    const parsed = JSON.parse(body) as { error?: { code?: unknown } };
    return typeof parsed?.error?.code === 'string' ? parsed.error.code.toUpperCase() : '';
  } catch {
    return '';
  }
}

/** The monthly quota is spent: the last value of `X-RateLimit-Remaining` (per second, per month) is 0, or the code says so. */
function quotaSpent(res: OutboundResponse): boolean {
  if (/QUOTA/.test(errorCode(res.body))) return true;
  const remaining = res.headers['x-ratelimit-remaining']?.split(',').map((v) => Number(v.trim()));
  return !!remaining && remaining.length > 1 && remaining[remaining.length - 1] === 0;
}

/** A response that is not a success, as a closed code. */
export function braveFailure(res: OutboundResponse): WebToolError {
  if (res.status === 429 && quotaSpent(res)) return new WebToolError('QUOTA_EXCEEDED');
  return statusFailure(res);
}

/** Brave's documented response, mapped. Anything unexpected is `UNAVAILABLE`. */
export function braveHits(body: string, max: number): WebSearchHit[] {
  const parsed = jsonBody(body);
  const results = (parsed as { web?: { results?: unknown } } | null)?.web?.results;
  if (results === undefined) return []; // no web results for this query
  if (!Array.isArray(results)) throw new WebToolError('UNAVAILABLE');
  return hitsOf(results as Record<string, unknown>[], max, (r) => hitOf(r.title, r.url, r.description, r.page_age));
}

@Injectable()
export class BraveSearchProvider implements SearchProvider, OnModuleInit {
  readonly id = 'brave';
  readonly label = 'Brave Search';
  readonly kind = 'results' as const;
  readonly credential = 'api_key' as const;
  readonly hosts = [BRAVE_HOST] as const;
  readonly estimatedCostPerCallUsd = BRAVE_ESTIMATED_COST_PER_CALL_USD;

  constructor(
    private readonly registry: SearchProviderRegistry,
    private readonly http: OutboundHttp,
  ) {}

  onModuleInit(): void {
    this.registry.register(this);
  }

  async search(req: SearchRequest, auth: ProviderAuth): Promise<WebSearchResult> {
    if (auth.kind !== 'api_key') throw new WebToolError('NOT_CONFIGURED');
    // The key is read into the header at the last moment; the header object is not kept.
    const res = await auth.key.expose((bytes) =>
      sendProviderRequest(this.http, { method: 'GET', url: braveUrl(req), headers: { accept: 'application/json', 'x-subscription-token': bytes.toString('utf8') }, timeoutMs: BRAVE_TIMEOUT_MS, maxBytes: BRAVE_MAX_BYTES, signal: req.signal }),
    );
    if (!isSuccess(res)) throw braveFailure(res);
    return { provider: this.id, hits: braveHits(res.body, clampCount(req.count, BRAVE_MAX_COUNT)), answer: null };
  }

  /** `network` (a GET of the host's root, no key) and `live_query` (the fixed word, `count: 1`). Codes only (E50.13). */
  async diagnose(auth: ProviderAuth, signal: AbortSignal, opts: ProviderDiagnoseOptions = {}): Promise<DiagnosticStage[]> {
    return providerStages({
      network: (s) => probeHost(this.http, `https://${BRAVE_HOST}/`, s),
      query: (s) => this.search({ query: DIAGNOSTIC_QUERY, count: 1, freshness: null, site: null, signal: s }, auth),
      signal,
      liveQuery: opts.liveQuery ?? true,
    });
  }
}
