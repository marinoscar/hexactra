// SearXNG (E50.8, #978): the search provider contract against an in-process fake instance (public over https, and private over http
// with the administrator's tick), the request (`format=json`, `site:` in `q`, the time range, a path prefix), the 403 of an instance
// whose JSON format is off (`FORMAT_DISABLED` in the report), and the private-address rule: a private address or http only with
// `allowPrivate`, and then only for the configured host, through the real address check of the console's transport.
import { isWebToolError } from '@marinoscar/hexactra-web-agent';

import { ServiceCredentialRegistry } from '../src/service-credentials/service-credential.registry';
import { SearxngSearchProvider, searxngTransport, searxngUrl } from '../src/web-search/providers/searxng.provider';
import { SearchProviderRegistry, type ProviderAuth, type SearchRequest } from '../src/web-search/search-provider';
import { FakeSearxng, searxngResponse } from '../src/web-search/testing/fake-searxng';
import { httpContractHarness, searchProviderContract, type ContractHitInput } from './support/search-provider-contract';

const req = (over: Partial<SearchRequest> = {}): SearchRequest => ({ query: 'example widgets', count: 5, freshness: null, site: null, signal: new AbortController().signal, ...over });
const codeOf = async (p: Promise<unknown>) => p.then(() => 'none', (e: unknown) => (isWebToolError(e) ? e.code : 'thrown'));
const render = (hits: ContractHitInput[]) => searxngResponse('invented', hits.map((h) => ({ title: h.title, url: h.url, content: h.snippet, publishedDate: h.publishedAt })));
const harness = (baseUrl: string, allowPrivate: boolean, setup: (f: FakeSearxng) => void = () => {}) => () => {
  const fake = new FakeSearxng(baseUrl);
  setup(fake);
  return httpContractHarness({
    fake,
    provider: (http) => new SearxngSearchProvider(new SearchProviderRegistry(new ServiceCredentialRegistry()), http),
    auth: () => ({ kind: 'none', baseUrl, allowPrivate }),
    secret: null,
    secretHeader: null,
    hosts: [new URL(baseUrl).hostname],
    results: render,
    expectFilters: (r, f) => {
      const q = new URL(r.url).searchParams;
      expect(q.get('q')).toMatch(new RegExp(`site:${f.site.replace(/\./g, '\\.')}$`));
      expect(q.get('time_range')).toBe(f.freshness);
      expect(q.get('format')).toBe('json');
    },
  });
};
const own = [{ status: 403, code: 'UNAVAILABLE' as const, diagnosticCode: 'FORMAT_DISABLED' }];

searchProviderContract('SearXNG (public, https)', harness('https://search.example.test/searx', false), { kind: 'results', quota: false, authRefusedStatuses: [401], ownStatuses: own });
searchProviderContract('SearXNG (private network, http, ticked)', harness('http://10.0.0.5:8080', true), { kind: 'results', quota: false, authRefusedStatuses: [401], ownStatuses: own });

describe('SearXNG', () => {
  const setup = (baseUrl: string) => {
    const http = new FakeSearxng(baseUrl);
    const creds = new ServiceCredentialRegistry();
    const registry = new SearchProviderRegistry(creds);
    const searxng = new SearxngSearchProvider(registry, http);
    searxng.onModuleInit();
    return { http, searxng, registry, creds };
  };
  const none = (baseUrl: string, allowPrivate = false): ProviderAuth => ({ kind: 'none', baseUrl, allowPrivate });

  it('registers itself without a key, with no host of its own and no cost', () => {
    const { registry, searxng, creds } = setup('https://search.example.test');
    expect(registry.get('searxng')).toBe(searxng);
    expect(searxng).toMatchObject({ label: 'SearXNG (self-hosted)', kind: 'results', credential: 'none', hosts: [], estimatedCostPerCallUsd: 0, diagnosticCodes: ['FORMAT_DISABLED'] });
    expect(creds.get({ service: 'web_search', name: 'searxng' })).toBeNull();
  });

  it('sends the JSON search under the configured address (a path prefix kept), and maps the documented answer', async () => {
    const { http, searxng } = setup('https://search.example.test/searx/');
    const r = await searxng.search(req({ count: 1, freshness: 'year', site: 'docs.example.test' }), none('https://search.example.test/searx/'));
    expect(http.requests).toEqual([
      expect.objectContaining({ method: 'GET', url: 'https://search.example.test/searx/search', query: { q: 'example widgets site:docs.example.test', format: 'json', categories: 'general', pageno: '1', time_range: 'year' }, body: null }),
    ]);
    expect(r).toEqual({ provider: 'searxng', answer: null, hits: [{ title: 'Example widgets & parts', url: 'https://docs.example.test/widgets', snippet: 'An invented page about widgets.', publishedAt: '2026-10-01T00:00:00' }] });
    expect(searxngUrl('https://search.example.test', { query: 'q', freshness: null, site: null })).toBe('https://search.example.test/search?q=q&format=json&categories=general&pageno=1');
    expect(searxngUrl('ftp://search.example.test', { query: 'q', freshness: null, site: null })).toBeNull();
    expect(await codeOf(searxng.search(req(), { kind: 'none', baseUrl: 'not a url', allowPrivate: false }))).toBe('NOT_CONFIGURED');
    expect(await codeOf(searxng.search(req(), { kind: 'ai_service', userId: 'u', orgId: null }))).toBe('NOT_CONFIGURED');
  });

  it('JSON switched off: a search is UNAVAILABLE (the next provider is tried); the report says FORMAT_DISABLED with its remedy', async () => {
    const { http, searxng } = setup('https://search.example.test');
    http.jsonEnabled = false;
    expect(await codeOf(searxng.search(req(), none('https://search.example.test')))).toBe('UNAVAILABLE');
    const stages = await searxng.diagnose(none('https://search.example.test'), new AbortController().signal);
    expect(stages).toEqual([
      expect.objectContaining({ id: 'network', status: 'pass', data: { host: 'search.example.test' } }),
      expect.objectContaining({ id: 'live_query', status: 'fail', code: 'FORMAT_DISABLED', remedy: 'FORMAT_DISABLED' }),
    ]);
    http.jsonEnabled = true;
    expect((await searxng.diagnose(none('https://search.example.test'), new AbortController().signal))[1]).toMatchObject({ status: 'pass', code: null });
  });

  it('a private address: refused without the tick; with it, accepted for the configured host only', async () => {
    const base = 'https://searx.home.test';
    const { http, searxng } = setup(base);
    http.resolve('searx.home.test', '192.168.1.20').resolve('other.home.test', '192.168.1.21');
    // Without the tick: never reached; the report names the private target.
    expect(await codeOf(searxng.search(req(), none(base)))).toBe('UNAVAILABLE');
    expect(http.requests).toHaveLength(0);
    expect((await searxng.diagnose(none(base), new AbortController().signal))[0]).toMatchObject({ id: 'network', status: 'fail', code: 'PRIVATE_TARGET', remedy: 'SEARCH_PRIVATE_TARGET' });
    // With the tick: reached, at the private address.
    expect((await searxng.search(req(), none(base, true))).hits.length).toBeGreaterThan(0);
    expect(http.requests[http.requests.length - 1]).toMatchObject({ url: 'https://searx.home.test/search', address: '192.168.1.20' });
    // The exemption names the configured host and no other: another private host is still refused with it.
    const transport = searxngTransport({ kind: 'none', baseUrl: base, allowPrivate: true });
    expect(transport).toEqual({ allowedHosts: ['searx.home.test'], allowInsecureHttp: true });
    await expect(http.check('https://other.home.test/search', transport.allowedHosts, transport.allowInsecureHttp)).rejects.toMatchObject({ code: 'private_target' });
    await expect(http.check('http://other.example.test/search', transport.allowedHosts, transport.allowInsecureHttp)).rejects.toMatchObject({ code: 'scheme_not_allowed' });
    expect(searxngTransport({ kind: 'none', baseUrl: base, allowPrivate: false })).toEqual({ allowedHosts: [], allowInsecureHttp: false });
  });

  it('http: refused without the tick, accepted with it; a private literal address likewise', async () => {
    const base = 'http://10.0.0.5:8080';
    const { http, searxng } = setup(base);
    expect(await codeOf(searxng.search(req(), none(base)))).toBe('UNAVAILABLE');
    expect(http.requests).toHaveLength(0);
    expect((await searxng.search(req(), none(base, true))).provider).toBe('searxng');
    expect(http.requests[0]).toMatchObject({ url: 'http://10.0.0.5:8080/search', address: '10.0.0.5' });
    // A public host over http is refused without the tick too: http is accepted only with the exemption of the configured host.
    const pub = setup('http://search.example.test');
    expect(await codeOf(pub.searxng.search(req(), none('http://search.example.test')))).toBe('UNAVAILABLE');
  });

  it('the cloud metadata address is refused without the tick', async () => {
    const base = 'https://169.254.169.254';
    const { http, searxng } = setup(base);
    expect(await codeOf(searxng.search(req(), none(base)))).toBe('UNAVAILABLE');
    expect(http.requests).toHaveLength(0);
  });
});
