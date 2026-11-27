// Exa (E50.8, #978): the search provider contract over an in-process fake of Exa's endpoint, and Exa's own request: the documented
// body (`auto`, one highlight per result and never the page text, the start date of the freshness window), the key in `x-api-key` only.
import { isWebToolError } from '@marinoscar/hexactra-web-agent';

import type { OutboundHttp } from '../src/oauth-client/outbound-http';
import { SecretBytes } from '../src/secrets/secrets-provider.port';
import { ServiceCredentialRegistry } from '../src/service-credentials/service-credential.registry';
import { EXA_ENDPOINT, ExaSearchProvider, exaBody } from '../src/web-search/providers/exa.provider';
import { SearchProviderRegistry, type SearchRequest } from '../src/web-search/search-provider';
import { exaResponse, FakeExa } from '../src/web-search/testing/fake-exa';
import { httpContractHarness, jsonOf, searchProviderContract } from './support/search-provider-contract';

const KEY = 'exa-contractkey0123456789abcdef';
const NOW = new Date('2026-11-26T12:00:00.000Z');
const START = { day: '2026-11-25T12:00:00.000Z', week: '2026-11-19T12:00:00.000Z', month: '2026-10-26T12:00:00.000Z', year: '2025-11-25T12:00:00.000Z' } as const;
const req = (over: Partial<SearchRequest> = {}): SearchRequest => ({ query: 'example widgets', count: 5, freshness: null, site: null, signal: new AbortController().signal, ...over });
const codeOf = async (p: Promise<unknown>) => p.then(() => 'none', (e: unknown) => (isWebToolError(e) ? e.code : 'thrown'));

const make = (http: OutboundHttp, registry = new SearchProviderRegistry(new ServiceCredentialRegistry())) => {
  const exa = new ExaSearchProvider(registry, http);
  exa.clock = () => NOW;
  return exa;
};

searchProviderContract(
  'Exa',
  () =>
    httpContractHarness({
      fake: new FakeExa([KEY]),
      provider: (http) => make(http),
      auth: () => ({ kind: 'api_key', key: SecretBytes.from(KEY) }),
      secret: KEY,
      secretHeader: 'x-api-key',
      hosts: ['api.exa.ai'],
      results: (hits) => exaResponse(hits.map((h) => ({ title: h.title, url: h.url, highlights: [h.snippet], publishedDate: h.publishedAt }))),
      expectFilters: (r, f) => expect(jsonOf(r)).toMatchObject({ includeDomains: [f.site], startPublishedDate: START[f.freshness] }),
    }),
  { kind: 'results' },
);

describe('Exa', () => {
  const auth = () => ({ kind: 'api_key' as const, key: SecretBytes.from(KEY) });

  it('registers itself with its label, host, key reference and cost estimate', () => {
    const creds = new ServiceCredentialRegistry();
    const registry = new SearchProviderRegistry(creds);
    const exa = make(new FakeExa(), registry);
    exa.onModuleInit();
    expect(registry.get('exa')).toBe(exa);
    expect(exa).toMatchObject({ label: 'Exa', kind: 'results', credential: 'api_key', hosts: ['api.exa.ai'], estimatedCostPerCallUsd: 0.01 });
    expect(creds.get({ service: 'web_search', name: 'exa' })).toMatchObject({ label: 'Exa API key' });
  });

  it('sends the documented body: one highlight per result and never the page text; maps a null title and date', async () => {
    const http = new FakeExa([KEY]);
    const exa = make(http);
    const r = await exa.search(req({ count: 40, freshness: 'week' }), auth());
    expect(http.requests).toEqual([
      expect.objectContaining({ method: 'POST', url: EXA_ENDPOINT, keyPresent: true, body: { query: 'example widgets', numResults: 25, type: 'auto', startPublishedDate: START.week, contents: { highlights: { numSentences: 3, highlightsPerUrl: 1 } } } }),
    ]);
    expect(JSON.stringify(http.requests)).not.toContain(KEY);
    expect(r.hits).toEqual([
      { title: 'Example widgets & parts', url: 'https://docs.example.test/widgets', snippet: 'An invented page about widgets.', publishedAt: '2026-10-01T00:00:00.000Z' },
      { title: '', url: 'http://shop.example.test/catalogue', snippet: '', publishedAt: null },
    ]);
    expect(exaBody({ query: 'q', count: 2, freshness: null, site: 'docs.example.test' }, NOW)).toEqual({ query: 'q', numResults: 2, type: 'auto', includeDomains: ['docs.example.test'], contents: { highlights: { numSentences: 3, highlightsPerUrl: 1 } } });
  });

  it('an unknown key is AUTH_REFUSED; 402 is QUOTA_EXCEEDED', async () => {
    const http = new FakeExa([KEY]);
    const exa = make(http);
    expect(await codeOf(exa.search(req(), { kind: 'api_key', key: SecretBytes.from('exa-wrongkey00000000') }))).toBe('AUTH_REFUSED');
    http.stub({ status: 402, body: { error: 'invented' } });
    expect(await codeOf(exa.search(req(), auth()))).toBe('QUOTA_EXCEEDED');
  });
});
