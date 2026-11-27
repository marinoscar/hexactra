// Brave Search on the search provider contract (E50.8, #978): the same suite every provider passes, over the in-process fake of
// Brave's endpoint (test/support/search-provider-contract.ts). Brave's own request details are in test/web-search.spec.ts.
import { SecretBytes } from '../src/secrets/secrets-provider.port';
import { ServiceCredentialRegistry } from '../src/service-credentials/service-credential.registry';
import { BraveSearchProvider } from '../src/web-search/providers/brave.provider';
import { SearchProviderRegistry } from '../src/web-search/search-provider';
import { braveBody, FakeBrave } from '../src/web-search/testing/fake-brave';
import { httpContractHarness, searchProviderContract } from './support/search-provider-contract';

const KEY = 'BSAcontractkey0123456789abcdef';
const FRESHNESS = { day: 'pd', week: 'pw', month: 'pm', year: 'py' } as const;

searchProviderContract(
  'Brave Search',
  () =>
    httpContractHarness({
      fake: new FakeBrave([KEY]),
      provider: (http) => new BraveSearchProvider(new SearchProviderRegistry(new ServiceCredentialRegistry()), http),
      auth: () => ({ kind: 'api_key', key: SecretBytes.from(KEY) }),
      secret: KEY,
      secretHeader: 'x-subscription-token',
      hosts: ['api.search.brave.com'],
      results: (hits) => braveBody(hits.map((h) => ({ title: h.title, url: h.url, description: h.snippet, ...(h.publishedAt ? { page_age: h.publishedAt } : {}) }))),
      quota: { status: 429, headers: { 'x-ratelimit-remaining': '1, 0' }, body: { error: { code: 'RATE_LIMITED' } } },
      expectFilters: (r, f) => {
        const q = new URL(r.url).searchParams;
        expect(q.get('q')).toMatch(new RegExp(`site:${f.site.replace(/\./g, '\\.')}$`));
        expect(q.get('freshness')).toBe(FRESHNESS[f.freshness]);
      },
    }),
  { kind: 'results' },
);
