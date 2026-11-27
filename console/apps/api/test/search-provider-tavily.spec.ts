// Tavily (E50.8, #978): the search provider contract over an in-process fake of Tavily's endpoint, and Tavily's own request: the
// documented body (basic depth, no answer, no page text), the key in `Authorization: Bearer` only, the quota statuses 432 and 433.
import { isWebToolError } from '@marinoscar/hexactra-web-agent';

import { SecretBytes } from '../src/secrets/secrets-provider.port';
import { ServiceCredentialRegistry } from '../src/service-credentials/service-credential.registry';
import { TAVILY_ENDPOINT, TavilySearchProvider, tavilyBody } from '../src/web-search/providers/tavily.provider';
import { SearchProviderRegistry, type SearchRequest } from '../src/web-search/search-provider';
import { FakeTavily, tavilyResponse } from '../src/web-search/testing/fake-tavily';
import { httpContractHarness, jsonOf, searchProviderContract } from './support/search-provider-contract';

const KEY = 'tvly-contractkey0123456789abcdef';
const req = (over: Partial<SearchRequest> = {}): SearchRequest => ({ query: 'example widgets', count: 5, freshness: null, site: null, signal: new AbortController().signal, ...over });
const codeOf = async (p: Promise<unknown>) => p.then(() => 'none', (e: unknown) => (isWebToolError(e) ? e.code : 'thrown'));

searchProviderContract(
  'Tavily',
  () =>
    httpContractHarness({
      fake: new FakeTavily([KEY]),
      provider: (http) => new TavilySearchProvider(new SearchProviderRegistry(new ServiceCredentialRegistry()), http),
      auth: () => ({ kind: 'api_key', key: SecretBytes.from(KEY) }),
      secret: KEY,
      secretHeader: 'authorization',
      hosts: ['api.tavily.com'],
      results: (hits) => tavilyResponse('invented', hits.map((h) => ({ title: h.title, url: h.url, content: h.snippet, ...(h.publishedAt ? { published_date: h.publishedAt } : {}) }))),
      quota: { status: 432, body: { detail: { error: 'invented plan limit text' } } },
      expectFilters: (r, f) => expect(jsonOf(r)).toMatchObject({ include_domains: [f.site], time_range: f.freshness }),
    }),
  { kind: 'results' },
);

describe('Tavily', () => {
  const setup = () => {
    const http = new FakeTavily([KEY]);
    const registry = new SearchProviderRegistry(new ServiceCredentialRegistry());
    const tavily = new TavilySearchProvider(registry, http);
    tavily.onModuleInit();
    return { http, tavily, registry };
  };
  const auth = () => ({ kind: 'api_key' as const, key: SecretBytes.from(KEY) });

  it('registers itself with its label, host, key reference and cost estimate', () => {
    const creds = new ServiceCredentialRegistry();
    const registry = new SearchProviderRegistry(creds);
    const tavily = new TavilySearchProvider(registry, new FakeTavily());
    tavily.onModuleInit();
    expect(registry.get('tavily')).toBe(tavily);
    expect(tavily).toMatchObject({ label: 'Tavily', kind: 'results', credential: 'api_key', hosts: ['api.tavily.com'], estimatedCostPerCallUsd: 0.008 });
    expect(creds.get({ service: 'web_search', name: 'tavily' })).toMatchObject({ label: 'Tavily API key', tiers: ['user', 'organization', 'system'] });
  });

  it('sends the documented body: basic depth, no answer, no page text, the count clamped, the key in the header only', async () => {
    const { http, tavily } = setup();
    const r = await tavily.search(req({ count: 50, freshness: 'month', site: 'Docs.Example.test' }), auth());
    expect(http.requests).toEqual([
      {
        method: 'POST',
        url: TAVILY_ENDPOINT,
        query: {},
        body: { query: 'example widgets', max_results: 20, search_depth: 'basic', topic: 'general', include_answer: false, include_raw_content: false, include_images: false, time_range: 'month', include_domains: ['docs.example.test'] },
        keyPresent: true,
        address: expect.any(String),
        timeoutMs: 10_000,
        maxBytes: 512 * 1024,
      },
    ]);
    expect(JSON.stringify(http.requests)).not.toContain(KEY);
    expect(r).toEqual({ provider: 'tavily', answer: null, hits: [{ title: 'Example widgets & parts', url: 'https://docs.example.test/widgets', snippet: 'An invented page about widgets.', publishedAt: '2026-10-01T00:00:00Z' }] });
    expect(tavilyBody({ query: 'q', count: 0, freshness: null, site: 'a b' })).toEqual({ query: 'q', max_results: 1, search_depth: 'basic', topic: 'general', include_answer: false, include_raw_content: false, include_images: false });
  });

  it('an unknown key is AUTH_REFUSED; 432 and 433 are QUOTA_EXCEEDED', async () => {
    const { http, tavily } = setup();
    expect(await codeOf(tavily.search(req(), { kind: 'api_key', key: SecretBytes.from('tvly-wrongkey0000000') }))).toBe('AUTH_REFUSED');
    for (const status of [432, 433]) {
      http.stub({ status, body: { detail: { error: 'invented' } } });
      expect(await codeOf(tavily.search(req(), auth()))).toBe('QUOTA_EXCEEDED');
    }
    expect(await codeOf(tavily.search(req(), { kind: 'none', baseUrl: 'https://x.example.test', allowPrivate: false }))).toBe('NOT_CONFIGURED');
  });
});
