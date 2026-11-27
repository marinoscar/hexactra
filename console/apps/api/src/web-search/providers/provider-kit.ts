// What every search adapter shares (E50.8, #978): the cleaning and capping of a hit, the site operand, the count clamp, one request
// through `OutboundHttp` with the closed error codes, and the reading of a provider's status code. An adapter file is the endpoint,
// the auth and the mapping; nothing else. Decision record `docs/decisions/web-search.md` §1.
//
// What leaves an adapter is a `WebSearchHit` (an `https`/`http` URL, plain text without control characters, capped like the tool
// caps what the model reads) or a `WebToolError` with a closed code: never a provider's message, a URL with a key, or the query.
import { WEB_CAPS, WebToolError, type WebSearchHit } from '@marinoscar/hexactra-web-agent';

import { OutboundHttpError, type OutboundHttp, type OutboundRequest, type OutboundResponse } from '../../oauth-client/outbound-http';

/** The deadline of one provider call. */
export const PROVIDER_TIMEOUT_MS = 10_000;
/** The most bytes read from a provider's answer. */
export const PROVIDER_MAX_BYTES = 512 * 1024;
/** The caps of a hit, the same as the tool's (decision record §1). */
export const HIT_CAPS = { title: WEB_CAPS.title, snippet: WEB_CAPS.snippet, url: WEB_CAPS.url, publishedAt: 40 } as const;

const ENTITIES: Record<string, string> = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", '#39': "'", '#x27': "'", nbsp: ' ' };
// eslint-disable-next-line no-control-regex
const CONTROL = new RegExp('[\\u0000-\\u001f\\u007f-\\u009f\\u200b-\\u200f\\u2028-\\u202e\\u2060-\\u2064\\ufeff]', 'g');

/** Plain text: tags and the common entities removed, control and invisible characters dropped, white space collapsed. */
export function plainText(raw: unknown): string {
  if (typeof raw !== 'string') return '';
  return raw
    .replace(/<[^>]{0,200}>/g, '')
    .replace(/&(amp|lt|gt|quot|apos|#39|#x27|nbsp);/g, (_m, e: string) => ENTITIES[e] ?? '')
    .replace(CONTROL, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/** At most `max` characters, cut on a code point, with an ellipsis when cut. */
export function capText(s: string, max: number): string {
  const chars = [...s];
  return chars.length <= max ? s : `${chars.slice(0, max - 1).join('').trimEnd()}…`;
}

/** Only `https` and `http` addresses are kept, at most {@link HIT_CAPS.url} characters, without user name or password. */
export function webUrl(raw: unknown): string | null {
  if (typeof raw !== 'string' || raw.length > HIT_CAPS.url) return null;
  try {
    const u = new URL(raw.trim());
    if (u.protocol !== 'https:' && u.protocol !== 'http:') return null;
    if (u.username || u.password) return null;
    const out = u.toString();
    return out.length <= HIT_CAPS.url ? out : null;
  } catch {
    return null;
  }
}

/** A date the provider gave, kept only when it parses. */
export function publishedAtOf(raw: unknown): string | null {
  return typeof raw === 'string' && raw.length <= HIT_CAPS.publishedAt && !Number.isNaN(Date.parse(raw)) ? raw : null;
}

/** One hit, cleaned and capped, or null when its address is not a web address. */
export function hitOf(title: unknown, url: unknown, snippet: unknown, publishedAt: unknown): WebSearchHit | null {
  const u = webUrl(url);
  if (!u) return null;
  return { title: capText(plainText(title), HIT_CAPS.title), url: u, snippet: capText(plainText(snippet), HIT_CAPS.snippet), publishedAt: publishedAtOf(publishedAt) };
}

/** Hits of a result list, at most `max`, skipping what is not a web address. */
export function hitsOf<T>(items: readonly T[], max: number, map: (item: T) => WebSearchHit | null): WebSearchHit[] {
  const out: WebSearchHit[] = [];
  for (const item of items) {
    if (out.length >= max) break;
    if (item === null || typeof item !== 'object') continue;
    const h = map(item);
    if (h) out.push(h);
  }
  return out;
}

/** A host name for a site filter, or null when it is not one (it is then left out rather than injected into the query). */
export function siteOperand(site: string | null): string | null {
  if (!site) return null;
  const host = site.trim().toLowerCase().replace(/^https?:\/\//, '').replace(/\/.*$/, '');
  return host.length <= 253 && /^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+$/.test(host) ? host : null;
}

/** The count, an integer from 1 to `max`. */
export const clampCount = (count: number, max: number): number => Math.max(1, Math.min(max, Math.floor(count) || 1));

/** Seconds in a header (`Retry-After`, or the first value of `X-RateLimit-Reset`), as milliseconds. */
export function retryAfterMs(headers: Record<string, string>): number | undefined {
  const raw = headers['retry-after'] ?? headers['x-ratelimit-reset']?.split(',')[0];
  const s = raw === undefined ? NaN : Number(raw.trim());
  return Number.isFinite(s) && s >= 0 && s <= 86_400 ? Math.round(s * 1000) : undefined;
}

/** `RATE_LIMITED`, with how long to wait when the provider said. */
export const rateLimited = (headers: Record<string, string>): WebToolError => {
  const after = retryAfterMs(headers);
  return new WebToolError('RATE_LIMITED', after === undefined ? {} : { retryAfterMs: after });
};

/** The JSON body of a success, or `UNAVAILABLE`. */
export function jsonBody(body: string): unknown {
  try {
    return JSON.parse(body) as unknown;
  } catch {
    throw new WebToolError('UNAVAILABLE');
  }
}

/** The usual reading of a status that is not a success; an adapter handles its own quota signal first. */
export function statusFailure(res: OutboundResponse): WebToolError {
  if (res.status === 401 || res.status === 403) return new WebToolError('AUTH_REFUSED');
  if (res.status === 402) return new WebToolError('QUOTA_EXCEEDED');
  if (res.status === 429) return rateLimited(res.headers);
  return new WebToolError('UNAVAILABLE');
}

/**
 * One request: Stop before it is sent and during it is `ABORTED`; any other transport refusal (timeout, network, too large, a
 * private target) is `UNAVAILABLE`. A non-2xx answer is returned for the adapter to read.
 */
export async function sendProviderRequest(http: OutboundHttp, req: OutboundRequest & { signal: AbortSignal }): Promise<OutboundResponse> {
  if (req.signal.aborted) throw new WebToolError('ABORTED');
  try {
    return await http.send({ timeoutMs: PROVIDER_TIMEOUT_MS, maxBytes: PROVIDER_MAX_BYTES, ...req });
  } catch (e) {
    if ((e instanceof OutboundHttpError && e.code === 'aborted') || req.signal.aborted) throw new WebToolError('ABORTED');
    if (e instanceof WebToolError) throw e;
    throw new WebToolError('UNAVAILABLE');
  }
}

/** A 2xx status. */
export const isSuccess = (res: OutboundResponse): boolean => res.status >= 200 && res.status < 300;
