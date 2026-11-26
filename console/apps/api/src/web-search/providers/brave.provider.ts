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

import { OutboundHttp, OutboundHttpError, type OutboundResponse } from '../../oauth-client/outbound-http';
import type { DiagnosticStage } from '../diagnostic-stage';
import { SearchProviderRegistry, type ProviderAuth, type ProviderDiagnoseOptions, type SearchProvider, type SearchRequest } from '../search-provider';
import { DIAGNOSTIC_QUERY, probeHost, providerStages } from '../web-search-diagnostics';

export const BRAVE_HOST = 'api.search.brave.com';
export const BRAVE_ENDPOINT = `https://${BRAVE_HOST}/res/v1/web/search`;
/** Brave's documented maximum for `count`. */
export const BRAVE_MAX_COUNT = 20;
export const BRAVE_TIMEOUT_MS = 10_000;
export const BRAVE_MAX_BYTES = 512 * 1024;
/** About USD 5 per 1,000 calls on the paid plan (decision record §1, 2026-11-26): a default the administrator overrides. */
export const BRAVE_ESTIMATED_COST_PER_CALL_USD = 0.005;

const FRESHNESS = { day: 'pd', week: 'pw', month: 'pm', year: 'py' } as const;

const ENTITIES: Record<string, string> = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", '#39': "'", '#x27': "'", nbsp: ' ' };

/** Brave marks matches with `<strong>` in titles and descriptions: plain text for the hit. */
export function plainText(raw: unknown): string {
  if (typeof raw !== 'string') return '';
  return raw
    .replace(/<[^>]{0,200}>/g, '')
    .replace(/&(amp|lt|gt|quot|apos|#39|#x27|nbsp);/g, (_m, e: string) => ENTITIES[e] ?? '')
    .replace(/\s+/g, ' ')
    .trim();
}

/** Only `https` and `http` addresses are kept. */
export function webUrl(raw: unknown): string | null {
  if (typeof raw !== 'string' || raw.length > 2_000) return null;
  try {
    const u = new URL(raw);
    return u.protocol === 'https:' || u.protocol === 'http:' ? u.toString() : null;
  } catch {
    return null;
  }
}

/** A host name for the `site:` operator, or null when it is not one (it is then left out rather than injected into the query). */
export function siteOperand(site: string | null): string | null {
  if (!site) return null;
  const host = site.trim().toLowerCase().replace(/^https?:\/\//, '').replace(/\/.*$/, '');
  return /^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+$/.test(host) ? host : null;
}

/** The address of one search. Never holds the key. */
export function braveUrl(req: Pick<SearchRequest, 'query' | 'count' | 'freshness' | 'site'>): string {
  const site = siteOperand(req.site);
  const params = new URLSearchParams({ q: site ? `${req.query} site:${site}` : req.query, count: String(Math.max(1, Math.min(BRAVE_MAX_COUNT, Math.floor(req.count) || 1))) });
  if (req.freshness) params.set('freshness', FRESHNESS[req.freshness]);
  return `${BRAVE_ENDPOINT}?${params.toString()}`;
}

/** Seconds in a header (`Retry-After`, or the first value of `X-RateLimit-Reset`), as milliseconds. */
function retryAfterMs(headers: Record<string, string>): number | undefined {
  const raw = headers['retry-after'] ?? headers['x-ratelimit-reset']?.split(',')[0];
  const s = raw === undefined ? NaN : Number(raw.trim());
  return Number.isFinite(s) && s >= 0 && s <= 86_400 ? Math.round(s * 1000) : undefined;
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
  if (res.status === 401 || res.status === 403) return new WebToolError('AUTH_REFUSED');
  if (res.status === 402) return new WebToolError('QUOTA_EXCEEDED');
  if (res.status === 429) {
    if (quotaSpent(res)) return new WebToolError('QUOTA_EXCEEDED');
    const after = retryAfterMs(res.headers);
    return new WebToolError('RATE_LIMITED', after === undefined ? {} : { retryAfterMs: after });
  }
  return new WebToolError('UNAVAILABLE');
}

/** Brave's documented response, mapped. Anything unexpected is `UNAVAILABLE`. */
export function braveHits(body: string, max: number): WebSearchHit[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(body);
  } catch {
    throw new WebToolError('UNAVAILABLE');
  }
  const results = (parsed as { web?: { results?: unknown } } | null)?.web?.results;
  if (results === undefined) return []; // no web results for this query
  if (!Array.isArray(results)) throw new WebToolError('UNAVAILABLE');
  const hits: WebSearchHit[] = [];
  for (const r of results as Record<string, unknown>[]) {
    const url = webUrl(r?.url);
    if (!url) continue;
    const age = typeof r.page_age === 'string' && !Number.isNaN(Date.parse(r.page_age)) ? r.page_age : null;
    hits.push({ title: plainText(r.title), url, snippet: plainText(r.description), publishedAt: age });
    if (hits.length >= max) break;
  }
  return hits;
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
    if (req.signal.aborted) throw new WebToolError('ABORTED');
    let res: OutboundResponse;
    try {
      // The key is read into the header at the last moment; the header object is not kept.
      res = await auth.key.expose((bytes) =>
        this.http.send({ method: 'GET', url: braveUrl(req), headers: { accept: 'application/json', 'x-subscription-token': bytes.toString('utf8') }, timeoutMs: BRAVE_TIMEOUT_MS, maxBytes: BRAVE_MAX_BYTES, signal: req.signal }),
      );
    } catch (e) {
      if (e instanceof OutboundHttpError && e.code === 'aborted') throw new WebToolError('ABORTED');
      if (e instanceof WebToolError) throw e;
      throw new WebToolError('UNAVAILABLE');
    }
    if (res.status < 200 || res.status >= 300) throw braveFailure(res);
    return { provider: this.id, hits: braveHits(res.body, Math.max(1, Math.min(BRAVE_MAX_COUNT, req.count))), answer: null };
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
