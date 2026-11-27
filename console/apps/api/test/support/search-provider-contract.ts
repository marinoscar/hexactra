// THE SEARCH PROVIDER CONTRACT (E50.8, #978): what every search adapter must do, present and future. One spec per provider calls
// `searchProviderContract(name, makeHarness, options)`; the suite is the same for all of them. It asserts, through the
// `SearchProvider` interface only:
//
//   * mapping   a success maps to hits with `https`/`http` URLs only, plain text without control characters, capped like the tool
//               caps what the model reads (title 200, snippet 400), at most `count` hits; an answer-type provider (E50.9) also caps
//               `answer.text` (4,000) and cites only the hits' URLs;
//   * filters   `site` and `freshness` reach the request;
//   * errors    401/403 → AUTH_REFUSED, 429 → RATE_LIMITED (with `retryAfterMs` from `Retry-After`), the provider's quota signal →
//               QUOTA_EXCEEDED, 5xx / timeout / network / too large / a refused address → UNAVAILABLE, Stop → ABORTED (before the
//               request and while it is in flight);
//   * leaks     no thrown error carries the provider's text, the query or the key (its message is its code); the key appears in
//               exactly one place of each request that carries it (its documented header) and nowhere else in the request log;
//   * diagnose  returns the stages of E50.13 (`network`, `live_query`), with known codes only, and never throws;
//   * hosts     every request went to a host the provider declares (a self-hosted provider: its configured host).
//
// The harness is transport-neutral: a result-type provider over `OutboundHttp` uses `httpContractHarness`; an answer-type provider
// that calls the AI service (E50.9) supplies its own `script` and `requests`.
import { WEB_CAPS, WebToolError, isWebToolError, type WebSearchHit, type WebToolErrorCode } from '@marinoscar/hexactra-web-agent';

import { OutboundHttp, OutboundHttpError, type OutboundRequest, type OutboundResponse } from '../../src/oauth-client/outbound-http';
import type { ProviderAuth, SearchProvider, SearchRequest } from '../../src/web-search/search-provider';
import type { FakeEndpointStub } from '../../src/web-search/testing/fake-json-endpoint';
import { PROVIDER_TEXT } from '../../src/web-search/testing/fake-json-endpoint';
import { SEARCH_DIAGNOSTIC_CODES } from '../../src/web-search/web-search-diagnostics';

/** A hit as the contract asks a provider's fake to return it (the harness renders it in the provider's own shape). */
export interface ContractHitInput {
  title: string;
  url: string;
  snippet: string;
  publishedAt: string | null;
}

/** What the next exchange with the provider does. */
export type ContractScript =
  | { kind: 'results'; hits: ContractHitInput[]; answer?: string }
  | { kind: 'auth_refused'; status: number }
  | { kind: 'rate_limited'; retryAfterS?: number }
  | { kind: 'quota' }
  | { kind: 'server_error'; status: number }
  | { kind: 'malformed' }
  | { kind: 'transport'; error: 'timeout' | 'network' | 'too_large' | 'private_target' | 'unresolvable' }
  /** A plain `Error` from below the adapter (a bug, an unexpected library error). */
  | { kind: 'throw' }
  /** No answer until the request is aborted. */
  | { kind: 'hang' };

/** One request as it left the adapter, raw (test memory only: it may hold the key, which is what the leak check looks for). */
export interface ContractRequest {
  host: string;
  url: string;
  headers: Record<string, string>;
  body: string;
}

export interface ProviderContractHarness {
  provider: SearchProvider;
  /** What the service would hand the provider (a fresh key each call: the service wipes it after). */
  auth(): ProviderAuth;
  /** The key's value, or null for a provider without one. */
  secret: string | null;
  /** The one header that carries the key (lower case), or null. */
  secretHeader: string | null;
  /** Queue what the next exchange does. Several scripts answer the next requests in order. */
  script(s: ContractScript): void;
  /** Every request so far. */
  requests(): ContractRequest[];
  /** The hosts a request may go to. */
  hosts(): string[];
  /** Asserts the request carried `site` and `freshness` in the provider's own form. */
  expectFilters(r: ContractRequest, f: { site: string; freshness: NonNullable<SearchRequest['freshness']> }): void;
}

export interface ProviderContractOptions {
  kind: 'results' | 'answer';
  /** The provider has a quota signal (a self-hosted provider has none). Default true. */
  quota?: boolean;
  /** Statuses that mean the key is refused. Default [401, 403]. */
  authRefusedStatuses?: readonly number[];
  /** A status of its own that is not AUTH_REFUSED, with the code a search reads it as (SearXNG: 403 → UNAVAILABLE, FORMAT_DISABLED). */
  ownStatuses?: readonly { status: number; code: WebToolErrorCode; diagnosticCode?: string }[];
}

const QUERY = 'contract widgets query';
const CONTROL = new RegExp('[\\u0000-\\u001f\\u007f-\\u009f\\u200b-\\u200f\\u2028-\\u202e\\u2060-\\u2064\\ufeff]');
const STAGE_STATUSES = new Set(['pass', 'warn', 'fail', 'skipped']);

const req = (over: Partial<SearchRequest> = {}): SearchRequest => ({ query: QUERY, count: 5, freshness: null, site: null, signal: new AbortController().signal, ...over });

/** A documented-shape result list with INVENTED pages and every kind of junk a provider may return. */
export function contractHits(n: number): ContractHitInput[] {
  const junk: ContractHitInput[] = [
    { title: 'Example <strong>widgets</strong> &amp; parts', url: 'https://docs.example.test/widgets', snippet: 'An <em>invented</em> page\u0000 about​ widgets.\nSecond line.', publishedAt: '2026-10-01T00:00:00Z' },
    { title: 'Not a web address', url: 'ftp://files.example.test/widgets', snippet: 'Dropped.', publishedAt: null },
    { title: 'A script address', url: 'javascript:alert(1)', snippet: 'Dropped.', publishedAt: null },
    { title: 'x'.repeat(500), url: 'http://shop.example.test/catalogue', snippet: 'y'.repeat(2_000), publishedAt: 'not a date' },
    { title: 'With a password', url: 'https://user:pass@private.example.test/', snippet: 'Dropped.', publishedAt: null },
  ];
  const out = [...junk];
  for (let i = 0; out.length < n; i++) out.push({ title: `Invented page ${i}`, url: `https://page${i}.example.test/`, snippet: `Invented snippet ${i}.`, publishedAt: null });
  return out.slice(0, n);
}

async function failure(p: Promise<unknown>): Promise<WebToolError> {
  try {
    await p;
  } catch (e) {
    expect(isWebToolError(e)).toBe(true);
    return e as WebToolError;
  }
  throw new Error('expected the search to fail');
}

function expectClean(e: WebToolError, h: ProviderContractHarness): void {
  expect(e.message).toBe(e.code);
  const text = JSON.stringify({ ...e, message: e.message, stack: e.stack });
  expect(text).not.toContain(PROVIDER_TEXT);
  expect(text).not.toContain(QUERY);
  if (h.secret) expect(text).not.toContain(h.secret);
}

const occurrences = (hay: string, needle: string): number => (needle ? hay.split(needle).length - 1 : 0);

function expectHit(hit: WebSearchHit): void {
  expect(['https:', 'http:']).toContain(new URL(hit.url).protocol);
  expect(new URL(hit.url).username).toBe('');
  expect(hit.url.length).toBeLessThanOrEqual(WEB_CAPS.url);
  expect([...hit.title].length).toBeLessThanOrEqual(WEB_CAPS.title);
  expect([...hit.snippet].length).toBeLessThanOrEqual(WEB_CAPS.snippet);
  for (const t of [hit.title, hit.snippet]) {
    expect(CONTROL.test(t)).toBe(false);
    expect(t).not.toMatch(/<\/?(strong|em|b)>/);
  }
  if (hit.publishedAt !== null) expect(Number.isNaN(Date.parse(hit.publishedAt))).toBe(false);
}

/** Runs the contract for one provider. `make` builds a fresh harness per test. */
export function searchProviderContract(name: string, make: () => ProviderContractHarness, options: ProviderContractOptions): void {
  const quota = options.quota ?? true;
  const authStatuses = options.authRefusedStatuses ?? [401, 403];

  describe(`the search provider contract: ${name}`, () => {
    it('declares what the registry and the settings need', () => {
      const { provider } = make();
      expect(provider.id).toMatch(/^[a-z][a-z0-9_]{0,31}$/);
      expect(provider.label.length).toBeGreaterThan(0);
      expect(provider.kind).toBe(options.kind);
      expect(['api_key', 'none', 'ai_service']).toContain(provider.credential);
      expect(provider.estimatedCostPerCallUsd === null || provider.estimatedCostPerCallUsd >= 0).toBe(true);
      for (const code of provider.diagnosticCodes ?? []) expect(code).toMatch(/^[A-Z][A-Z0-9_]+$/);
    });

    it('maps a success to cleaned, capped hits with web addresses only, at most `count`', async () => {
      const h = make();
      h.script({ kind: 'results', hits: contractHits(25), answer: 'A'.repeat(10_000) });
      const r = await h.provider.search(req({ count: 3 }), h.auth());
      expect(r.provider).toBe(h.provider.id);
      expect(r.hits.length).toBeGreaterThan(0);
      expect(r.hits.length).toBeLessThanOrEqual(3);
      r.hits.forEach(expectHit);
      expect(r.hits[0]).toMatchObject({ title: 'Example widgets & parts', url: 'https://docs.example.test/widgets', publishedAt: '2026-10-01T00:00:00Z' });
      expect(r.hits[0]!.snippet).toMatch(/^An invented page about widgets\./);
      expect(r.hits.map((x) => x.url)).not.toContain('ftp://files.example.test/widgets');
      if (options.kind === 'results') {
        expect(r.answer).toBeNull();
      } else {
        expect(r.answer).not.toBeNull();
        expect([...r.answer!.text].length).toBeLessThanOrEqual(WEB_CAPS.answer);
        for (const c of r.answer!.citations) expect(r.hits.map((x) => x.url)).toContain(c);
      }

      h.script({ kind: 'results', hits: contractHits(25) });
      const many = await h.provider.search(req({ count: 20 }), h.auth());
      expect(many.hits.length).toBeLessThanOrEqual(20);
      many.hits.forEach(expectHit);
      expect(many.hits.find((x) => x.url === 'http://shop.example.test/catalogue')).toMatchObject({ publishedAt: null });

      h.script({ kind: 'results', hits: [] });
      expect((await h.provider.search(req(), h.auth())).hits).toEqual([]);
    });

    it('sends `site` and `freshness`', async () => {
      const h = make();
      for (const freshness of ['day', 'week', 'month', 'year'] as const) {
        h.script({ kind: 'results', hits: contractHits(2) });
        await h.provider.search(req({ site: 'docs.example.test', freshness }), h.auth());
        const last = h.requests()[h.requests().length - 1]!;
        h.expectFilters(last, { site: 'docs.example.test', freshness });
      }
    });

    it('turns every failure into a closed code that carries no provider text, query or key', async () => {
      const h = make();
      const cases: [ContractScript, WebToolErrorCode][] = [
        ...authStatuses.map((status): [ContractScript, WebToolErrorCode] => [{ kind: 'auth_refused', status }, 'AUTH_REFUSED']),
        [{ kind: 'rate_limited' }, 'RATE_LIMITED'],
        ...(quota ? [[{ kind: 'quota' }, 'QUOTA_EXCEEDED'] as [ContractScript, WebToolErrorCode]] : []),
        ...[500, 502, 503, 504].map((status): [ContractScript, WebToolErrorCode] => [{ kind: 'server_error', status }, 'UNAVAILABLE']),
        [{ kind: 'malformed' }, 'UNAVAILABLE'],
        ...(['timeout', 'network', 'too_large', 'private_target', 'unresolvable'] as const).map((error): [ContractScript, WebToolErrorCode] => [{ kind: 'transport', error }, 'UNAVAILABLE']),
        [{ kind: 'throw' }, 'UNAVAILABLE'],
      ];
      for (const [script, code] of cases) {
        h.script(script);
        const e = await failure(h.provider.search(req(), h.auth()));
        expect({ script, code: e.code }).toEqual({ script, code });
        expectClean(e, h);
      }
      for (const own of options.ownStatuses ?? []) {
        h.script({ kind: 'server_error', status: own.status });
        const e = await failure(h.provider.search(req(), h.auth()));
        expect(e.code).toBe(own.code);
        expectClean(e, h);
      }
      h.script({ kind: 'rate_limited', retryAfterS: 3 });
      const rate = await failure(h.provider.search(req(), h.auth()));
      expect(rate).toMatchObject({ code: 'RATE_LIMITED', retryAfterMs: 3000 });
    });

    it('Stop: ABORTED before the request is sent and while it is in flight', async () => {
      const h = make();
      const before = h.requests().length;
      const ac = new AbortController();
      ac.abort();
      expect((await failure(h.provider.search(req({ signal: ac.signal }), h.auth()))).code).toBe('ABORTED');
      expect(h.requests().length).toBe(before);
      const live = new AbortController();
      h.script({ kind: 'hang' });
      const pending = h.provider.search(req({ signal: live.signal }), h.auth());
      setTimeout(() => live.abort(), 5);
      const e = await failure(pending);
      expect(e.code).toBe('ABORTED');
      expectClean(e, h);
    });

    it('the key is in exactly one header of each search and nowhere else; every request went to a declared host', async () => {
      const h = make();
      h.script({ kind: 'results', hits: contractHits(3) });
      await h.provider.search(req({ site: 'docs.example.test', freshness: 'week' }), h.auth());
      h.script({ kind: 'auth_refused', status: authStatuses[0]! });
      await failure(h.provider.search(req(), h.auth()));
      await h.provider.diagnose(h.auth(), new AbortController().signal);
      const all = h.requests();
      expect(all.length).toBeGreaterThanOrEqual(3);
      for (const r of all) {
        expect(h.hosts()).toContain(r.host);
        if (!h.secret) continue;
        const where = Object.entries(r.headers).filter(([, v]) => v.includes(h.secret!));
        expect(occurrences(r.url, h.secret)).toBe(0);
        expect(occurrences(r.body, h.secret)).toBe(0);
        expect(where.length).toBeLessThanOrEqual(1);
        if (where.length === 1) {
          expect(where[0]![0]).toBe(h.secretHeader);
          expect(occurrences(where[0]![1], h.secret)).toBe(1);
        }
      }
      if (h.secret) {
        // Each search carried the key; the connect probe of the diagnostics did not.
        const carrying = all.filter((r) => Object.values(r.headers).some((v) => v.includes(h.secret!)));
        expect(carrying.length).toBe(3);
      }
    });

    it('diagnose: the stages of E50.13, known codes only, never throws', async () => {
      const h = make();
      const known = new Set([...SEARCH_DIAGNOSTIC_CODES, ...(h.provider.diagnosticCodes ?? [])]);
      const check = async (expectLive: string | null) => {
        const stages = await h.provider.diagnose(h.auth(), new AbortController().signal);
        expect(stages.map((s) => s.id)).toEqual(['network', 'live_query']);
        for (const s of stages) {
          expect(STAGE_STATUSES.has(s.status)).toBe(true);
          if (s.code !== null) expect(known.has(s.code)).toBe(true);
        }
        const text = JSON.stringify(stages);
        expect(text).not.toContain(PROVIDER_TEXT);
        if (h.secret) expect(text).not.toContain(h.secret);
        if (expectLive) expect(stages[1]!.status).toBe(expectLive);
        return stages;
      };
      // A pass: the probe answers, then the fixed word returns one hit.
      h.script({ kind: 'server_error', status: 404 });
      h.script({ kind: 'results', hits: contractHits(3) });
      expect((await check('pass'))[1]!.data).toMatchObject({ hits: 1 });
      // The probe cannot connect: the query is skipped.
      h.script({ kind: 'transport', error: 'unresolvable' });
      expect((await check('skipped'))[0]).toMatchObject({ status: 'fail', code: 'UNRESOLVABLE' });
      // The key refused, rate limited, a server error, an error from below the adapter: stages, never a throw.
      for (const [live, status] of [
        [{ kind: 'auth_refused', status: authStatuses[0]! }, 'fail'],
        [{ kind: 'rate_limited' }, 'warn'],
        [{ kind: 'server_error', status: 503 }, 'fail'],
        [{ kind: 'throw' }, 'fail'],
        [{ kind: 'results', hits: [] }, 'warn'],
      ] as [ContractScript, string][]) {
        h.script({ kind: 'server_error', status: 404 });
        h.script(live);
        await check(status);
      }
      for (const own of options.ownStatuses ?? []) {
        h.script({ kind: 'server_error', status: 404 });
        h.script({ kind: 'server_error', status: own.status });
        const stages = await check('fail');
        if (own.diagnosticCode) expect(stages[1]).toMatchObject({ code: own.diagnosticCode, remedy: own.diagnosticCode });
      }
      // The probe itself throws something unexpected.
      h.script({ kind: 'throw' });
      await check(null);
      // Today's limit reached: no query is sent.
      const n = h.requests().length;
      h.script({ kind: 'server_error', status: 404 });
      const limited = await h.provider.diagnose(h.auth(), new AbortController().signal, { liveQuery: false });
      expect(limited[1]).toMatchObject({ id: 'live_query', status: 'skipped', code: 'LIMIT_REACHED' });
      expect(h.requests().length).toBe(n + 1);
    });
  });
}

// ---- a harness for a provider over `OutboundHttp` ----

/**
 * Wraps a provider's fake endpoint: records every request raw, answers the scripted exchanges, and hands the rest to the fake (which
 * checks the documented request shape and the real address rule).
 */
export class ContractHttp extends OutboundHttp {
  readonly log: ContractRequest[] = [];
  private readonly queue: ContractScript[] = [];

  constructor(
    private readonly inner: OutboundHttp,
    private readonly render: (s: ContractScript) => FakeEndpointStub,
  ) {
    super();
  }

  enqueue(s: ContractScript): void {
    this.queue.push(s);
  }

  check(url: string, allowedHosts?: readonly string[], allowInsecureHttp?: boolean): Promise<void> {
    return this.inner.check(url, allowedHosts, allowInsecureHttp);
  }

  async send(req: OutboundRequest): Promise<OutboundResponse> {
    const u = new URL(req.url);
    this.log.push({ host: u.hostname.replace(/^\[|\]$/g, ''), url: req.url, headers: { ...(req.headers ?? {}) }, body: req.body ?? '' });
    const s = this.queue.shift();
    if (!s) return this.inner.send(req);
    if (s.kind === 'throw') throw new Error(`boom ${PROVIDER_TEXT}`);
    if (s.kind === 'transport') throw new OutboundHttpError(s.error, `scripted ${PROVIDER_TEXT}`);
    if (s.kind === 'hang') {
      return new Promise((_resolve, reject) => {
        const fail = () => reject(new OutboundHttpError('aborted', 'The request was cancelled.'));
        if (req.signal?.aborted) fail();
        else req.signal?.addEventListener('abort', fail, { once: true });
      });
    }
    if (s.kind === 'results') {
      // Through the fake, so the request shape is still checked, with the scripted results.
      const stub = this.render(s);
      const real = await this.inner.send(req);
      if (real.status < 200 || real.status >= 300) return real;
      return { status: stub.status, headers: stub.headers ?? {}, body: typeof stub.body === 'string' ? stub.body : JSON.stringify(stub.body) };
    }
    const stub = this.render(s);
    return { status: stub.status, headers: stub.headers ?? {}, body: typeof stub.body === 'string' ? stub.body : JSON.stringify(stub.body ?? {}) };
  }
}

/** The usual rendering of the non-result scripts; `quota` and `results` are the provider's own. */
export function defaultStub(s: ContractScript, own: { results: (hits: ContractHitInput[], answer?: string) => unknown; quota?: FakeEndpointStub }): FakeEndpointStub {
  const err = { error: { code: 'INVENTED', message: `${PROVIDER_TEXT} ${QUERY}` }, detail: PROVIDER_TEXT };
  switch (s.kind) {
    case 'results':
      return { status: 200, headers: { 'content-type': 'application/json' }, body: own.results(s.hits, s.answer) };
    case 'auth_refused':
      return { status: s.status, body: err };
    case 'rate_limited':
      return { status: 429, headers: s.retryAfterS === undefined ? {} : { 'retry-after': String(s.retryAfterS) }, body: err };
    case 'quota':
      return own.quota ?? { status: 402, body: err };
    case 'server_error':
      return { status: s.status, body: err };
    case 'malformed':
      return { status: 200, body: `not json ${PROVIDER_TEXT}` };
    default:
      return { status: 500, body: err };
  }
}

export interface HttpHarnessInput<F extends OutboundHttp> {
  fake: F;
  provider: (http: OutboundHttp) => SearchProvider;
  auth: () => ProviderAuth;
  secret: string | null;
  secretHeader: string | null;
  hosts: string[];
  results: (hits: ContractHitInput[], answer?: string) => unknown;
  quota?: FakeEndpointStub;
  expectFilters: ProviderContractHarness['expectFilters'];
}

export function httpContractHarness<F extends OutboundHttp>(input: HttpHarnessInput<F>): ProviderContractHarness & { http: ContractHttp; fake: F } {
  const http = new ContractHttp(input.fake, (s) => defaultStub(s, { results: input.results, ...(input.quota ? { quota: input.quota } : {}) }));
  const provider = input.provider(http);
  return {
    http,
    fake: input.fake,
    provider,
    auth: input.auth,
    secret: input.secret,
    secretHeader: input.secretHeader,
    script: (s) => http.enqueue(s),
    requests: () => http.log,
    hosts: () => input.hosts,
    expectFilters: input.expectFilters,
  };
}

/** The request's parsed JSON body (a POST provider's filters). */
export const jsonOf = (r: ContractRequest): Record<string, unknown> => JSON.parse(r.body || '{}') as Record<string, unknown>;
