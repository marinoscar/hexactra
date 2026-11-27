// An in-process fake of a self-hosted SearXNG instance (E50.8, #978), from the documented search API with INVENTED data. It answers
// `GET <base>/search?format=json&q=…` at the base it was given (a path prefix allowed); `jsonEnabled = false` answers 403 as an instance
// whose `search.formats` lacks `json`. Every request passes the real address check first (see `FakeJsonEndpoint`), so an instance on
// a private address is reached only with the provider's per-host exemption.
import type { OutboundResponse } from '../../oauth-client/outbound-http';
import { FakeJsonEndpoint } from './fake-json-endpoint';

export interface SearxngResult {
  title: string;
  url: string;
  content: string;
  publishedDate?: string | null;
}

export function searxngResponse(query: string, results: SearxngResult[]): unknown {
  return {
    query,
    number_of_results: 0,
    results: results.map((r, i) => ({ engine: 'invented', engines: ['invented'], score: 1 - i / 10, category: 'general', positions: [i + 1], publishedDate: null, ...r })),
    answers: [],
    corrections: [],
    infoboxes: [],
    suggestions: [],
    unresponsive_engines: [],
  };
}

export const FAKE_SEARXNG_RESULTS: SearxngResult[] = [
  { title: 'Example widgets &amp; parts', url: 'https://docs.example.test/widgets', content: 'An <b>invented</b> page about widgets.', publishedDate: '2026-10-01T00:00:00' },
  { title: 'Not a web address', url: 'ftp://files.example.test/widgets', content: 'Dropped: not http or https.' },
  { title: 'Widget catalogue', url: 'http://shop.example.test/catalogue', content: '' },
];

export class FakeSearxng extends FakeJsonEndpoint {
  results = [...FAKE_SEARXNG_RESULTS];
  /** False: the instance answers 403 to `format=json` (its `search.formats` lacks it). */
  jsonEnabled = true;

  constructor(readonly baseUrl: string) {
    super();
  }

  protected keyOf(): string | undefined {
    return undefined;
  }

  protected answer({ method, url }: { method: string; url: URL; body: unknown; key: string | undefined }): OutboundResponse {
    const base = new URL(this.baseUrl);
    const prefix = base.pathname.replace(/\/+$/, '');
    if (url.origin !== base.origin) return this.json(404, {});
    if (url.pathname === `${prefix}/` || url.pathname === prefix || url.pathname === '/') return { status: 200, headers: { 'content-type': 'text/html' }, body: '<html>SearXNG</html>' };
    if (url.pathname !== `${prefix}/search` || method !== 'GET') return this.json(404, {});
    const format = url.searchParams.get('format');
    if (format !== 'json') return { status: 200, headers: { 'content-type': 'text/html' }, body: '<html>results</html>' };
    if (!this.jsonEnabled) return { status: 403, headers: { 'content-type': 'text/html' }, body: '<html>403 Forbidden</html>' };
    const q = url.searchParams.get('q') ?? '';
    const tr = url.searchParams.get('time_range');
    if (!q || (tr !== null && !['day', 'week', 'month', 'year'].includes(tr))) return { status: 400, headers: { 'content-type': 'text/html' }, body: '<html>Bad request</html>' };
    const site = /site:(\S+)/.exec(q)?.[1];
    return this.json(200, searxngResponse(q, this.results.filter((r) => !site || r.url.includes(site))));
  }
}
