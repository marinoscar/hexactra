// web_fetch in the host (E50.6, #976): the binding of `WebFetchPort`. It reads ONE public page from the console server and returns its
// readable text. A server that fetches any address it is given is the classic SSRF primitive, so these rules are the point:
//
//   * `https` only, no user name or password in the address, port 443 or 8443 only; `localhost`, a loopback, private, link-local,
//     carrier-grade NAT or cloud metadata address is refused at every hop, in every environment (the development conveniences of
//     `OutboundHttp` never apply here).
//   * Through `OutboundHttp`: every address the name resolves to is checked, and the connection goes to the address that was checked
//     (pinned: a second DNS answer cannot move it). `OutboundHttp` never follows a redirect: this service follows up to 5 itself and
//     runs every check on each hop, the run's allowed sites included (the callback of the tool's context). A hop that fails one ends
//     the call with `BLOCKED` (the address) or `NOT_ALLOWED` (the run's sites), before any byte is sent to it.
//   * A fixed User-Agent naming Hexactra and its version, nothing of the user. No cookie is sent or kept, no Authorization, no referrer.
//   * 15 s for the whole call, every hop included; the run's Stop (`signal`) cancels it. At most 5 MB read (`TOO_LARGE`).
//   * 401, 403, 429 and a known bot-check page (`challenge.ts`) are `BLOCKED`: the tool says to open the page in the browser.
//   * `robots.txt` is not read: one page read because the owner's agent asked for it is a user-initiated read, like the browser's; there
//     is no crawling (decision record docs/decisions/web-search.md, "Implementation notes (E50.6)").
//
// The text is data for the model, read only inside the tool's wrapper. Nothing fetched is kept beyond the 10-minute in-process cache
// (`fetch-cache.ts`); the step records the host and path, never the text. The span carries the content class and the size class and
// the host, never the path or the query.
import { Injectable, Logger, Optional } from '@nestjs/common';
import { cleanPageText, DEFAULT_WEB_LIMITS, WebToolError, isWebToolError, type WebFetchPort, type WebFetchRequest, type WebPage, type WebSites, type WebToolErrorCode } from '@marinoscar/hexactra-web-agent';
import { isBlockedAddress } from '@marinoscar/platform-api/core';
import { AppMetricsService, resolveApiVersion } from '@marinoscar/platform-api/host';
import { SpanStatusCode, trace } from '@opentelemetry/api';
import { isIP } from 'node:net';

import { hostMatches } from '../../connections/mcp/mcp-url';
import { OutboundHttp, OutboundHttpError, type OutboundResponse } from '../../oauth-client/outbound-http';
import { WebSearchService } from '../web-search.service';
import type { ResolvedWebSearchSystemSettings } from '../web-search.settings';
import { challengeOf } from './challenge';
import { classify, decode, extractHtml, extractPdf, mediaTypeOf, type ContentClass, type Extracted } from './extract';
import { FetchCache, type CachedPage } from './fetch-cache';
import { fetchOutcomeOf, sizeClassOf } from './web-fetch.metrics';
import './web-fetch.metrics';

export const WEB_FETCH_DEADLINE_MS = 15_000;
export const WEB_FETCH_MAX_BYTES = 5 * 1024 * 1024;
export const WEB_FETCH_MAX_REDIRECTS = 5;
export const WEB_FETCH_PORTS: ReadonlySet<string> = new Set(['', '443', '8443']);
export const WEB_FETCH_ACCEPT = 'text/html, text/plain, application/pdf, application/json';
const REDIRECTS = new Set([301, 302, 303, 307, 308]);
const REFUSED_STATUSES = new Set([401, 403, 429]);
/** The longest text kept (and cached): the most a caller may ask for. */
const TEXT_KEEP = DEFAULT_WEB_LIMITS.maxFetchChars;

/** The User-Agent: the product and its version, and where it comes from. Never a user's name, address or e-mail. */
export function webFetchUserAgent(version: string): string {
  return `Hexactra/${version} (web_fetch; +https://github.com/marinoscar/hexactra)`;
}

let cachedVersion: string | null = null;
function apiVersion(): string {
  if (cachedVersion === null) {
    try {
      cachedVersion = resolveApiVersion(__dirname) || '0.0.0';
    } catch {
      cachedVersion = '0.0.0';
    }
  }
  return cachedVersion;
}

const bareHost = (host: string): string => (host.startsWith('[') && host.endsWith(']') ? host.slice(1, -1) : host).toLowerCase();

/**
 * The checks of one hop that need no DNS: scheme, user name or password, port, a loopback name, a non-public literal address, the
 * administrator's blocked hosts (`BLOCKED`), then the run's allowed sites (`NOT_ALLOWED`). The address check after DNS is
 * `OutboundHttp`'s, at send time.
 */
export function hopRefusal(raw: string, blockedHosts: readonly string[], sites: WebSites | null): WebToolErrorCode | null {
  let u: URL;
  try {
    u = new URL(raw);
  } catch {
    return 'BLOCKED';
  }
  if (u.protocol !== 'https:') return 'BLOCKED';
  if (u.username !== '' || u.password !== '') return 'BLOCKED';
  if (!WEB_FETCH_PORTS.has(u.port)) return 'BLOCKED';
  const host = bareHost(u.hostname);
  if (host === '' || host === 'localhost' || host.endsWith('.localhost') || host.endsWith('.local') || host.endsWith('.internal')) return 'BLOCKED';
  if (isIP(host) !== 0 && isBlockedAddress(host)) return 'BLOCKED';
  if (isIP(host) === 0 && !host.includes('.')) return 'BLOCKED'; // a single-label name is an internal one
  if (blockedHosts.some((p) => hostMatches(host, p))) return 'BLOCKED';
  if (sites && !sites.allowed(u.href)) return 'NOT_ALLOWED';
  return null;
}

/** An `OutboundHttp` refusal or failure as a web tool code. */
function codeOfOutbound(e: OutboundHttpError, stopped: boolean): WebToolErrorCode {
  switch (e.code) {
    case 'invalid_url':
    case 'scheme_not_allowed':
    case 'userinfo_not_allowed':
    case 'port_not_allowed':
    case 'private_target':
      return 'BLOCKED';
    case 'too_large':
      return 'TOO_LARGE';
    case 'aborted':
      return stopped ? 'ABORTED' : 'UNAVAILABLE';
    default:
      // unresolvable, timeout, network
      return 'UNAVAILABLE';
  }
}

/** The options of one run's port. */
export interface WebFetchRunOptions {
  userId: string;
  /** The run's allowed sites (the tool context's `ext.web.sites`): every hop is checked against it. Null: no list. */
  sites: WebSites | null;
}

interface Outcome {
  page: CachedPage;
  contentClass: ContentClass;
  bytes: number;
  redirects: number;
  cacheHit: boolean;
}

@Injectable()
export class WebFetchService {
  private readonly log = new Logger('WebFetch');
  readonly cache = new FetchCache();
  /** The whole call's deadline; a test shortens it. */
  deadlineMs = WEB_FETCH_DEADLINE_MS;

  constructor(
    private readonly http: OutboundHttp,
    private readonly webSearch: WebSearchService,
    @Optional() private readonly metrics?: AppMetricsService,
  ) {}

  /**
   * The port the agent's `web_fetch` tool is bound to (E50.7), or null when the administrator switched web_fetch off. One port counts
   * its own reads against `limits.fetchPerRun`: bind one per run.
   */
  async forRun(opts: WebFetchRunOptions): Promise<WebFetchPort | null> {
    if (!(await this.webSearch.system()).fetch.enabled) return null;
    let used = 0;
    return {
      fetch: async (req: WebFetchRequest): Promise<WebPage> => {
        const s = await this.webSearch.system();
        if (!s.fetch.enabled) throw new WebToolError('NOT_CONFIGURED');
        const limit = s.limits.fetchPerRun;
        if (limit !== null && used >= limit) throw new WebToolError('LIMIT_REACHED');
        used += 1;
        return this.fetch(opts.userId, req, opts.sites, s);
      },
    };
  }

  /** One read for `userId`. Throws `WebToolError` only. */
  async fetch(userId: string, req: WebFetchRequest, sites: WebSites | null, settings?: ResolvedWebSearchSystemSettings): Promise<WebPage> {
    const s = settings ?? (await this.webSearch.system());
    const started = Date.now();
    return trace.getTracer('hexactra-console.web-fetch').startActiveSpan('web_fetch', async (span) => {
      let code: WebToolErrorCode | null = null;
      try {
        span.setAttribute('server.address', hostOf(req.url));
        const out = await this.read(userId, req, sites, s);
        span.setAttribute('web_fetch.content_class', out.contentClass);
        span.setAttribute('web_fetch.size_class', sizeClassOf(out.bytes));
        span.setAttribute('web_fetch.redirects', out.redirects);
        span.setAttribute('web_fetch.cache_hit', out.cacheHit);
        const max = Math.max(1, Math.min(req.maxChars, TEXT_KEEP));
        const cut = out.page.text.length > max;
        return { finalUrl: out.page.finalUrl, title: out.page.title, text: cut ? out.page.text.slice(0, max) : out.page.text, truncated: cut || out.page.cut, contentType: out.page.contentType };
      } catch (e) {
        const err = isWebToolError(e) ? e : new WebToolError('UNAVAILABLE');
        if (!isWebToolError(e)) this.log.warn(`web_fetch: unexpected failure (${e instanceof Error ? e.name : 'error'})`);
        code = err.code;
        span.setAttribute('error.code', code);
        span.setStatus({ code: SpanStatusCode.ERROR });
        throw err;
      } finally {
        span.setAttribute('web_fetch.outcome', fetchOutcomeOf(code));
        if (code !== 'ABORTED') {
          this.metrics?.add('webFetchCalls', 1, { outcome: fetchOutcomeOf(code) });
          this.metrics?.record('webFetchDuration', (Date.now() - started) / 1000, {});
        }
        span.end();
      }
    });
  }

  private async read(userId: string, req: WebFetchRequest, sites: WebSites | null, s: ResolvedWebSearchSystemSettings): Promise<Outcome> {
    if (req.signal.aborted) throw new WebToolError('ABORTED');
    const first = hopRefusal(req.url, s.fetch.blockedHosts, sites);
    if (first) throw new WebToolError(first);
    const href = new URL(req.url).href;

    const hit = this.cache.get(userId, href);
    if (hit) {
      // Checked again as a fresh read would be: this run's sites and the blocked hosts, at every hop that led to it.
      for (const hop of hit.hops) {
        const refused = hopRefusal(hop, s.fetch.blockedHosts, sites);
        if (refused) throw new WebToolError(refused);
      }
      return { page: hit, contentClass: 'other', bytes: 0, redirects: hit.hops.length - 1, cacheHit: true };
    }

    // One deadline for the whole call; the run's Stop cancels it too.
    const deadline = new AbortController();
    const timer = setTimeout(() => deadline.abort(), this.deadlineMs);
    timer.unref?.();
    const signal = AbortSignal.any([req.signal, deadline.signal]);
    const endsAt = Date.now() + this.deadlineMs;
    const fail = (): never => {
      throw new WebToolError(req.signal.aborted ? 'ABORTED' : 'UNAVAILABLE');
    };
    try {
      const hops: string[] = [href];
      let url = href;
      for (;;) {
        const res = await this.send(url, signal, Math.max(1, endsAt - Date.now()), () => req.signal.aborted);
        if (signal.aborted) fail();
        if (REDIRECTS.has(res.status)) {
          const location = res.headers.location;
          if (!location) throw new WebToolError('UNAVAILABLE');
          if (hops.length > WEB_FETCH_MAX_REDIRECTS) throw new WebToolError('BLOCKED');
          let next: string;
          try {
            next = new URL(location, url).href;
          } catch {
            throw new WebToolError('BLOCKED');
          }
          const refused = hopRefusal(next, s.fetch.blockedHosts, sites);
          if (refused) throw new WebToolError(refused);
          hops.push(next);
          url = next;
          continue;
        }
        const bytes = res.bytes ?? Buffer.from(res.body, 'utf8');
        const mediaType = mediaTypeOf(res.headers['content-type']);
        const contentClass = classify(mediaType, bytes);
        if (REFUSED_STATUSES.has(res.status)) throw new WebToolError('BLOCKED');
        if (res.status < 200 || res.status > 299) {
          if (contentClass === 'html' && challengeOf(decode(bytes, res.headers['content-type'], true))) throw new WebToolError('BLOCKED');
          throw new WebToolError('UNAVAILABLE');
        }
        const extracted = await this.extract(contentClass, bytes, res.headers['content-type'], url, signal);
        if (signal.aborted) fail();
        const clean = cleanPageText(extracted.text, TEXT_KEEP);
        const page: CachedPage = { hops, finalUrl: url, title: extracted.title, text: clean.text, cut: clean.cut, contentType: contentTypeOf(contentClass, mediaType) };
        this.cache.put(userId, page);
        return { page, contentClass, bytes: bytes.length, redirects: hops.length - 1, cacheHit: false };
      }
    } finally {
      clearTimeout(timer);
    }
  }

  /** One request, no redirect followed: no cookie, no Authorization, no referrer. Rejects with `WebToolError` only. */
  private async send(url: string, signal: AbortSignal, timeoutMs: number, stopped: () => boolean): Promise<OutboundResponse> {
    const request = this.http.send({
      method: 'GET',
      url,
      headers: { 'user-agent': webFetchUserAgent(apiVersion()), accept: WEB_FETCH_ACCEPT, 'accept-encoding': 'identity' },
      timeoutMs,
      maxBytes: WEB_FETCH_MAX_BYTES,
      signal,
    });
    // The name's lookup is not cancellable: the race makes a Stop take effect at once all the same.
    const aborted = new Promise<never>((_, reject) => {
      const onAbort = () => reject(new OutboundHttpError('aborted', 'The request was cancelled.'));
      if (signal.aborted) onAbort();
      else signal.addEventListener('abort', onAbort, { once: true });
      void request.finally(() => signal.removeEventListener('abort', onAbort)).catch(() => undefined);
    });
    try {
      return await Promise.race([request, aborted]);
    } catch (e) {
      if (e instanceof OutboundHttpError) throw new WebToolError(codeOfOutbound(e, stopped()));
      throw new WebToolError(stopped() ? 'ABORTED' : 'UNAVAILABLE');
    } finally {
      request.catch(() => undefined);
    }
  }

  private async extract(contentClass: ContentClass, bytes: Buffer, contentType: string | undefined, url: string, signal: AbortSignal): Promise<Extracted> {
    switch (contentClass) {
      case 'html': {
        const html = decode(bytes, contentType, true);
        if (challengeOf(html)) throw new WebToolError('BLOCKED');
        return extractHtml(html, url);
      }
      case 'text':
      case 'json':
        return { title: null, text: decode(bytes, contentType, false) };
      case 'pdf':
        return extractPdf(bytes, signal);
      default:
        throw new WebToolError('UNSUPPORTED_TYPE');
    }
  }
}

function contentTypeOf(c: ContentClass, mediaType: string): string {
  if (mediaType) return mediaType;
  return c === 'pdf' ? 'application/pdf' : c === 'html' ? 'text/html' : 'application/octet-stream';
}

function hostOf(raw: string): string {
  try {
    return new URL(raw).host;
  } catch {
    return 'invalid';
  }
}
