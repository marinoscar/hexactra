// Fakes of the two web ports and a web context over the harness fakes (E50.4): what the web tools' unit tests, and a host's, run on. They
// answer from tables the test fills, keep every call, and never touch a network.
import type { ControlPort } from '@marinoscar/hexactra-agent';
import { fakePolicy, fakeRun, type FakeRun, type FakeRunOptions } from '@marinoscar/hexactra-agent/testing';
import type { WebContext, WebExt, WebHostExt } from '../context';
import { webSiteGate } from '../gates/web-site-gate';
import { WebToolError, type WebFetchPort, type WebFetchRequest, type WebPage, type WebSearchHit, type WebSearchPort, type WebSearchRequest, type WebSearchResult, type WebToolErrorCode } from '../ports';

/** Waits `ms`, or rejects with `ABORTED` when the signal fires first. */
function wait(ms: number, signal: AbortSignal): Promise<void> {
  if (signal.aborted) return Promise.reject(new WebToolError('ABORTED'));
  if (ms <= 0) return Promise.resolve();
  return new Promise((resolve, reject) => {
    const t = setTimeout(() => {
      signal.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(t);
      reject(new WebToolError('ABORTED'));
    };
    signal.addEventListener('abort', onAbort, { once: true });
  });
}

/** A search provider over canned results: by exact query, else `fallback` (no hits). */
export class FakeWebSearch implements WebSearchPort {
  provider = 'fake';
  /** What a query answers: hits (a result-type provider) or a whole result (an answer-type one). */
  results = new Map<string, WebSearchHit[] | WebSearchResult>();
  /** Every request, oldest first (without its signal). */
  calls: Omit<WebSearchRequest, 'signal'>[] = [];
  /** How long each search takes, in ms: an abort test sets it. */
  latencyMs = 0;
  private failures: { code: WebToolErrorCode; retryAfterMs?: number }[] = [];

  /** The next search throws this code. */
  failNext(code: WebToolErrorCode, retryAfterMs?: number): this {
    this.failures.push(retryAfterMs === undefined ? { code } : { code, retryAfterMs });
    return this;
  }

  async search(req: WebSearchRequest): Promise<WebSearchResult> {
    const { signal, ...rest } = req;
    this.calls.push(rest);
    await wait(this.latencyMs, signal);
    const fail = this.failures.shift();
    if (fail) throw new WebToolError(fail.code, fail.retryAfterMs === undefined ? {} : { retryAfterMs: fail.retryAfterMs });
    const canned = this.results.get(req.query);
    if (!canned) return { provider: this.provider, hits: [], answer: null };
    if (Array.isArray(canned)) return { provider: this.provider, hits: canned, answer: null };
    return canned;
  }
}

/** A page reader over a table of pages by address, with redirects and failures. An unknown address is `UNAVAILABLE`. */
export class FakeWebFetch implements WebFetchPort {
  pages = new Map<string, { title: string | null; text: string; contentType?: string }>();
  /** From one address to another, followed until a page is found. */
  redirects = new Map<string, string>();
  /** An address that fails with a code. */
  failures = new Map<string, WebToolErrorCode>();
  calls: Omit<WebFetchRequest, 'signal'>[] = [];
  latencyMs = 0;
  private next: WebToolErrorCode[] = [];

  failNext(code: WebToolErrorCode): this {
    this.next.push(code);
    return this;
  }

  async fetch(req: WebFetchRequest): Promise<WebPage> {
    const { signal, ...rest } = req;
    this.calls.push(rest);
    await wait(this.latencyMs, signal);
    const fail = this.next.shift();
    if (fail) throw new WebToolError(fail);
    let url = req.url;
    for (let hops = 0; this.redirects.has(url); hops++) {
      if (hops >= 10) throw new WebToolError('BLOCKED');
      url = this.redirects.get(url)!;
    }
    const code = this.failures.get(url);
    if (code) throw new WebToolError(code);
    const page = this.pages.get(url);
    if (!page) throw new WebToolError('UNAVAILABLE');
    const truncated = page.text.length > req.maxChars;
    return { finalUrl: url, title: page.title, text: truncated ? page.text.slice(0, req.maxChars) : page.text, truncated, contentType: page.contentType ?? 'text/html' };
  }
}

/** A Stop the test can press while a call is in flight: `abortSignal` fires when `stop()` is called. */
export class AbortableControl implements ControlPort {
  requested = false;
  pauseRequested = false;
  private readonly abort = new AbortController();
  private readonly halt = new AbortController();
  get abortSignal() {
    return this.abort.signal;
  }
  get haltSignal() {
    return this.halt.signal;
  }
  stop(): void {
    this.requested = true;
    this.abort.abort();
    this.halt.abort();
  }
  async readFlags() {
    return { cancelRequested: this.requested, pauseRequested: this.pauseRequested };
  }
}

/** A host or a subdomain of it, as the console's allowed-sites rule matches (exact host, or `*.` for subdomains). */
export function fakeSites(hosts: readonly string[]): WebExt['sites'] {
  const allowed = (raw: string): boolean => {
    let host: string;
    try {
      host = new URL(raw).hostname.toLowerCase();
    } catch {
      return false;
    }
    return hosts.some((h) => {
      const bare = h.replace(/^\*\./, '').toLowerCase();
      return host === bare || host.endsWith(`.${bare}`);
    });
  };
  return { allowed, hosts: () => hosts };
}

/**
 * A stand-in for the host's sensitive patterns (the console binds its pattern table to `PolicyPort.mask`): token-like strings
 * (`sk-…`, `ghp_…`) and runs of 13 to 19 digits are masked.
 */
export const FAKE_MASK = (text: string): string => text.replace(/\b(?:sk-|ghp_)[A-Za-z0-9_-]{8,}/g, '[masked]').replace(/\b\d(?:[ -]?\d){12,18}\b/g, '[masked]');

export interface FakeWebRunOptions extends FakeRunOptions<WebHostExt> {
  search?: FakeWebSearch | null;
  fetch?: FakeWebFetch | null;
  /** The run's allowed sites. Absent or null: no list. */
  allowedHosts?: readonly string[] | null;
  limits?: Partial<WebExt['limits']>;
  /** The sensitive-pattern mask. Default: `FAKE_MASK`. */
  mask?: (text: string) => string;
}

/** A web context over the harness fakes: a fake search and page reader, the site list, an abortable Stop and the web site gate ready. */
export function fakeWebRun(options: FakeWebRunOptions = {}): FakeRun<WebHostExt> & { ctx: WebContext; search: FakeWebSearch; fetch: FakeWebFetch; stop: AbortableControl; gates: [typeof webSiteGate] } {
  const search = options.search === undefined ? new FakeWebSearch() : options.search;
  const fetch = options.fetch === undefined ? new FakeWebFetch() : options.fetch;
  const web: WebExt = {
    search,
    fetch,
    sites: options.allowedHosts ? fakeSites(options.allowedHosts) : null,
    limits: { maxResults: 10, maxFetchChars: 50_000, ...options.limits },
  };
  const stop = new AbortableControl();
  const policy = { ...fakePolicy(options.policy), mask: options.mask ?? FAKE_MASK };
  const run = fakeRun<WebHostExt>({ ...options, ext: { web }, ports: { control: stop, policy, ...options.ports } });
  return { ...run, ctx: run.ctx as WebContext, search: search ?? new FakeWebSearch(), fetch: fetch ?? new FakeWebFetch(), stop, gates: [webSiteGate] };
}
