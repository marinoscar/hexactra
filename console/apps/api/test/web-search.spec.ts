// Search providers in the host (E50.5, #975), with in-memory stores: the registry, the Brave adapter against an in-process fake of
// its endpoint (the request shape, the mapping, every error code, the key only in the header), the settings, and the service (the
// tiers, the fallback, the limits per day and per run, the key wiped after each call, the usage count).
import { WebToolError, isWebToolError } from '@marinoscar/hexactra-web-agent';
import type { CredentialsService, OrgCredentialsService, UserCredentialsService } from '@marinoscar/platform-api/credentials';

import { SecretBytes } from '../src/secrets/secrets-provider.port';
import { CredentialStoreServiceCredentials } from '../src/service-credentials/credential-store.binding';
import type { Who } from '../src/service-credentials/service-credential.port';
import { ServiceCredentialRegistry } from '../src/service-credentials/service-credential.registry';
import { BRAVE_ENDPOINT, BraveSearchProvider, braveUrl, plainText, siteOperand } from '../src/web-search/providers/brave.provider';
import { SearchProviderRegistry, type SearchRequest } from '../src/web-search/search-provider';
import { FakeBrave } from '../src/web-search/testing/fake-brave';
import { FakeSearchProvider } from '../src/web-search/testing/fake-search-provider';
import { webSearchHttpError } from '../src/web-search/web-search.errors';
import { outcomeOf } from '../src/web-search/web-search.metrics';
import { mergeWebSearchSystemSettings, resolveWebSearchSystemSettings, webSearchSystemSettingsSchema, webSearchUserOf, type WebSearchSystemSettings } from '../src/web-search/web-search.settings';
import { WebSearchService, allowedTiers } from '../src/web-search/web-search.service';
import type { WebSearchUsage } from '../src/web-search/web-search.usage';

const KEY = 'BSAinventedkey0123456789abcdef';
const req = (over: Partial<SearchRequest> = {}): SearchRequest => ({ query: 'example widgets', count: 5, freshness: null, site: null, signal: new AbortController().signal, ...over });
const ALICE: Who = { userId: 'u-alice', orgId: 'o-acme' };

async function codeOf(p: Promise<unknown>): Promise<string> {
  try {
    await p;
    return 'none';
  } catch (e) {
    expect(isWebToolError(e)).toBe(true);
    expect((e as Error).message).toBe((e as WebToolError).code); // never a provider's text
    return (e as WebToolError).code;
  }
}

describe('the registry', () => {
  it('refuses a malformed id and a second provider with the same id, and registers the key of a provider that has one', () => {
    const creds = new ServiceCredentialRegistry();
    const r = new SearchProviderRegistry(creds);
    r.register(new FakeSearchProvider('alpha'));
    r.register(new FakeSearchProvider('open', 'Open', 'none'));
    expect(() => r.register(new FakeSearchProvider('alpha'))).toThrow(/already registered/);
    expect(() => r.register(new FakeSearchProvider('Bad-Id'))).toThrow(/malformed/);
    expect(r.ids()).toEqual(['alpha', 'open']);
    expect(r.get('alpha')?.label).toBe('Fake alpha');
    expect(r.get('nope')).toBeNull();
    expect(creds.get({ service: 'web_search', name: 'alpha' })).toMatchObject({ label: 'Fake alpha API key', tiers: ['user', 'organization', 'system'] });
    expect(creds.get({ service: 'web_search', name: 'open' })).toBeNull();
    expect(creds.get({ service: 'web_search', name: 'alpha' })!.validate('short')).toBe('too_short');
  });
});

describe('Brave Search', () => {
  const setup = () => {
    const http = new FakeBrave([KEY]);
    const registry = new SearchProviderRegistry(new ServiceCredentialRegistry());
    const brave = new BraveSearchProvider(registry, http);
    brave.onModuleInit();
    return { http, brave, registry };
  };
  const auth = () => ({ kind: 'api_key' as const, key: SecretBytes.from(KEY) });

  it('registers itself with its label, host and cost estimate', () => {
    const { registry, brave } = setup();
    expect(registry.get('brave')).toBe(brave);
    expect(brave).toMatchObject({ label: 'Brave Search', kind: 'results', credential: 'api_key', hosts: ['api.search.brave.com'], estimatedCostPerCallUsd: 0.005 });
  });

  it('sends the documented request, the key in the header only, with the deadline and the response cap', async () => {
    const { http, brave } = setup();
    const r = await brave.search(req({ count: 50, freshness: 'week', site: 'Docs.Example.test' }), auth());
    expect(http.requests).toEqual([{ method: 'GET', url: BRAVE_ENDPOINT, query: { q: 'example widgets site:docs.example.test', count: '20', freshness: 'pw' }, tokenPresent: true, timeoutMs: 10_000, maxBytes: 512 * 1024 }]);
    expect(JSON.stringify(http.requests)).not.toContain(KEY);
    expect(r.provider).toBe('brave');
    expect(r.answer).toBeNull();
    // Tags and entities stripped; a non-web address dropped; an empty description is an empty snippet.
    expect(r.hits).toEqual([
      { title: 'Example widgets & parts', url: 'https://docs.example.test/widgets', snippet: 'An invented page about widgets.', publishedAt: '2026-10-01T00:00:00' },
      { title: 'Widget catalogue', url: 'http://shop.example.test/catalogue', snippet: '', publishedAt: null },
    ]);
  });

  it('maps freshness, clamps the count and leaves out a site that is not a host name', () => {
    for (const [f, p] of [['day', 'pd'], ['week', 'pw'], ['month', 'pm'], ['year', 'py']] as const) expect(new URL(braveUrl({ query: 'q', count: 3, freshness: f, site: null })).searchParams.get('freshness')).toBe(p);
    expect(new URL(braveUrl({ query: 'q', count: 0, freshness: null, site: null })).searchParams.get('count')).toBe('1');
    expect(siteOperand('https://docs.example.test/path')).toBe('docs.example.test');
    expect(siteOperand('a b OR c')).toBeNull();
    expect(new URL(braveUrl({ query: 'q', count: 3, freshness: null, site: 'x OR y' })).searchParams.get('q')).toBe('q');
    expect(plainText('<b>a</b> &lt;b&gt;')).toBe('a <b>');
  });

  it('turns every failure into a closed code, never the provider text', async () => {
    const { http, brave } = setup();
    expect(await codeOf(brave.search(req(), { kind: 'api_key', key: SecretBytes.from('BSAwrongkey000000') }))).toBe('AUTH_REFUSED');
    http.stub({ status: 403 });
    expect(await codeOf(brave.search(req(), auth()))).toBe('AUTH_REFUSED');
    http.stub({ status: 429, headers: { 'retry-after': '2' }, body: { error: { code: 'RATE_LIMITED' } } });
    let e: unknown;
    try {
      await brave.search(req(), auth());
    } catch (err) {
      e = err;
    }
    expect(e).toMatchObject({ code: 'RATE_LIMITED', retryAfterMs: 2000 });
    http.stub({ status: 429, headers: { 'x-ratelimit-remaining': '1, 0', 'x-ratelimit-reset': '1, 86000' } });
    expect(await codeOf(brave.search(req(), auth()))).toBe('QUOTA_EXCEEDED');
    http.stub({ status: 429, body: { error: { code: 'QUOTA_LIMITED' } } });
    expect(await codeOf(brave.search(req(), auth()))).toBe('QUOTA_EXCEEDED');
    http.stub({ status: 402 });
    expect(await codeOf(brave.search(req(), auth()))).toBe('QUOTA_EXCEEDED');
    for (const status of [500, 502, 503, 422]) {
      http.stub({ status });
      expect(await codeOf(brave.search(req(), auth()))).toBe('UNAVAILABLE');
    }
    for (const error of ['timeout', 'network', 'too_large', 'private_target'] as const) {
      http.stub({ status: 0, error });
      expect(await codeOf(brave.search(req(), auth()))).toBe('UNAVAILABLE');
    }
    http.stub({ status: 200, body: 'not json' });
    expect(await codeOf(brave.search(req(), auth()))).toBe('UNAVAILABLE');
    http.stub({ status: 200, body: { web: { results: 'nope' } } });
    expect(await codeOf(brave.search(req(), auth()))).toBe('UNAVAILABLE');
    http.stub({ status: 200, body: { type: 'search' } });
    expect((await brave.search(req(), auth())).hits).toEqual([]);
    const ac = new AbortController();
    ac.abort();
    expect(await codeOf(brave.search(req({ signal: ac.signal }), auth()))).toBe('ABORTED');
    expect(await codeOf(brave.search(req(), { kind: 'none', baseUrl: 'https://x.example.test', allowPrivate: false }))).toBe('NOT_CONFIGURED');
  });

  it('diagnoses: network then one live query of the fixed word, with codes only (E50.13)', async () => {
    const { brave, http } = setup();
    const signal = new AbortController().signal;
    const before = http.requests.length;
    const ok = await brave.diagnose(auth(), signal);
    expect(ok).toEqual([
      expect.objectContaining({ id: 'network', status: 'pass', code: null, data: { host: 'api.search.brave.com' } }),
      expect.objectContaining({ id: 'live_query', status: 'pass', code: null, data: expect.objectContaining({ hits: 1 }) }),
    ]);
    // The connect probe carries no key; the live query sends the fixed word with count 1, the key in the header.
    expect(http.requests.slice(before)).toEqual([
      expect.objectContaining({ url: 'https://api.search.brave.com/', tokenPresent: false }),
      expect.objectContaining({ url: BRAVE_ENDPOINT, query: { q: 'weather', count: '1' }, tokenPresent: true }),
    ]);
    expect((await brave.diagnose({ kind: 'api_key', key: SecretBytes.from('BSAwrongkey000000') }, signal))[1]).toMatchObject({ status: 'fail', code: 'AUTH_REFUSED', remedy: 'SEARCH_KEY_REFUSED' });
    http.stub({ status: 200 }).stub({ status: 429, headers: { 'x-ratelimit-remaining': '0, 10' } });
    expect((await brave.diagnose(auth(), signal))[1]).toMatchObject({ status: 'warn', code: 'RATE_LIMITED' });
    http.stub({ status: 200 }).stub({ status: 429, headers: { 'x-ratelimit-remaining': '1, 0' } });
    expect((await brave.diagnose(auth(), signal))[1]).toMatchObject({ status: 'fail', code: 'QUOTA_EXCEEDED' });
    http.stub({ status: 200 }).stub({ status: 200, body: { web: { results: [] } } });
    expect((await brave.diagnose(auth(), signal))[1]).toMatchObject({ status: 'warn', code: 'NO_RESULTS' });
    http.stub({ status: 0, error: 'unresolvable' });
    expect(await brave.diagnose(auth(), signal)).toEqual([expect.objectContaining({ id: 'network', status: 'fail', code: 'UNRESOLVABLE' }), expect.objectContaining({ id: 'live_query', status: 'skipped' })]);
    const n = http.requests.length;
    expect((await brave.diagnose(auth(), signal, { liveQuery: false }))[1]).toMatchObject({ id: 'live_query', status: 'skipped', code: 'LIMIT_REACHED' });
    expect(http.requests.length).toBe(n + 1); // the probe only
  });
});

describe('the settings', () => {
  it('defaults: on, Brave first, the deployment key shared, user keys allowed, 30 a run and 300 a day', () => {
    expect(resolveWebSearchSystemSettings(null)).toEqual({ enabled: true, providers: {}, order: ['brave'], shareDeploymentKey: true, allowUserKeys: true, limits: { perRun: 30, perUserPerDay: 300, fetchPerRun: 30 }, fetch: { enabled: true, blockedHosts: [] } });
    expect(webSearchUserOf(null)).toEqual({ enabled: true, provider: null });
    expect(webSearchUserOf({ webSearch: { enabled: false } })).toEqual({ enabled: false, provider: null });
    expect(webSearchUserOf({ webSearch: { enabled: 'yes' } })).toEqual({ enabled: true, provider: null });
  });

  it('merges a patch: fields left out kept, null limits unlimited, providers per id and field', () => {
    let s: WebSearchSystemSettings = mergeWebSearchSystemSettings(undefined, { providers: { brave: { costPerCallUsd: 0.004 } }, limits: { perUserPerDay: null } });
    s = mergeWebSearchSystemSettings(s, { providers: { brave: { enabled: false } }, order: ['brave', 'alpha', 'brave'] });
    expect(resolveWebSearchSystemSettings(s)).toEqual({ enabled: true, providers: { brave: { enabled: false, costPerCallUsd: 0.004, baseUrl: null, allowPrivate: false, model: null } }, order: ['brave', 'alpha'], shareDeploymentKey: true, allowUserKeys: true, limits: { perRun: 30, perUserPerDay: null, fetchPerRun: 30 }, fetch: { enabled: true, blockedHosts: [] } });
    expect(mergeWebSearchSystemSettings(s, undefined)).toEqual(s);
  });

  it("a self-hosted provider's address and its private-network tick (E50.8): off by default, kept per field", () => {
    let s = mergeWebSearchSystemSettings(undefined, { providers: { searxng: { baseUrl: 'http://10.0.0.5:8080', allowPrivate: true } } });
    s = mergeWebSearchSystemSettings(s, { providers: { searxng: { enabled: true } } });
    expect(resolveWebSearchSystemSettings(s).providers.searxng).toEqual({ enabled: true, costPerCallUsd: null, baseUrl: 'http://10.0.0.5:8080', allowPrivate: true, model: null });
    expect(resolveWebSearchSystemSettings(mergeWebSearchSystemSettings(s, { providers: { searxng: { allowPrivate: false } } })).providers.searxng!.allowPrivate).toBe(false);
    // An answer-type provider's model (E50.9): no default, kept per field, cleared with null, an id of the AI catalogue only.
    let m = mergeWebSearchSystemSettings(undefined, { providers: { openai: { model: 'invented-model-1' } } });
    m = mergeWebSearchSystemSettings(m, { providers: { openai: { enabled: true } } });
    expect(resolveWebSearchSystemSettings(m).providers.openai!.model).toBe('invented-model-1');
    expect(resolveWebSearchSystemSettings(mergeWebSearchSystemSettings(m, { providers: { openai: { model: null } } })).providers.openai!.model).toBeNull();
    expect(resolveWebSearchSystemSettings(null).providers.openai).toBeUndefined();
    expect(webSearchSystemSettingsSchema.safeParse({ providers: { openai: { model: 'has spaces' } } }).success).toBe(false);
    const shape = webSearchSystemSettingsSchema.shape.providers;
    for (const bad of ['ftp://search.example.test', 'https://user:pw@search.example.test', 'https://search.example.test/?q=x', 'https://search.example.test/#a', 'not a url']) {
      expect({ bad, ok: shape.safeParse({ searxng: { baseUrl: bad } }).success }).toEqual({ bad, ok: false });
    }
    expect(shape.safeParse({ searxng: { baseUrl: 'https://search.example.test/searx', allowPrivate: false } }).success).toBe(true);
  });

  it('allows the system tier only when shared and the user tier only when allowed', () => {
    expect(allowedTiers({ allowUserKeys: true, shareDeploymentKey: true })).toEqual(['user', 'organization', 'system']);
    expect(allowedTiers({ allowUserKeys: false, shareDeploymentKey: false })).toEqual(['organization']);
  });
});

// ---- the service ----

function fakeStores() {
  const rows = new Map<string, string>();
  const info = (k: string) => (rows.has(k) ? { updatedAt: new Date() } : null);
  const users = { getSecret: async (u: string, p: string, n: string) => rows.get(`user:${u}:${p}:${n}`) ?? null, describe: async (u: string, p: string, n: string) => info(`user:${u}:${p}:${n}`), setSecret: async (u: string, p: string, n: string, s: string) => void rows.set(`user:${u}:${p}:${n}`, s), deleteSecret: async () => undefined };
  const orgs = { getSecret: async (o: string, p: string, n: string) => rows.get(`org:${o}:${p}:${n}`) ?? null, describe: async (o: string, p: string, n: string) => info(`org:${o}:${p}:${n}`), setSecret: async (o: string, p: string, n: string, s: string) => void rows.set(`org:${o}:${p}:${n}`, s), deleteSecret: async () => undefined };
  const system = { getSecret: async (p: string, n: string) => rows.get(`system:${p}:${n}`) ?? null, describe: async (p: string, n: string) => info(`system:${p}:${n}`), setSecret: async (p: string, n: string, s: string) => void rows.set(`system:${p}:${n}`, s), deleteSecret: async () => undefined };
  return { users, orgs, system };
}

class MemoryUsage {
  rows: { userId: string; provider: string; failed: boolean; costUsd: number | null }[] = [];
  async record(userId: string, provider: string, _at: Date, o: { failed: boolean; costUsd: number | null; calls?: number }) {
    const { calls: _calls, ...rest } = o;
    this.rows.push({ userId, provider, ...rest });
  }
  async callsOn(userId: string) {
    return this.rows.filter((r) => r.userId === userId).length;
  }
}

function service(opts: { settings?: WebSearchSystemSettings; user?: unknown; providers?: FakeSearchProvider[] } = {}) {
  const creds = new ServiceCredentialRegistry();
  const registry = new SearchProviderRegistry(creds);
  const providers = opts.providers ?? [new FakeSearchProvider('alpha'), new FakeSearchProvider('beta')];
  for (const p of providers) registry.register(p);
  const s = fakeStores();
  const port = new CredentialStoreServiceCredentials(creds, s.users as unknown as UserCredentialsService, s.orgs as unknown as OrgCredentialsService, s.system as unknown as CredentialsService);
  const usage = new MemoryUsage();
  const prisma = { userSettings: { findUnique: async () => (opts.user === undefined ? null : { value: opts.user }) } };
  const settings = { getNamespace: async () => opts.settings ?? { order: providers.map((p) => p.id) } };
  const metrics = { add: jest.fn(), record: jest.fn() };
  const svc = new WebSearchService(registry, port, usage as unknown as WebSearchUsage, prisma as never, settings as never, metrics as never);
  const setKey = (tier: 'user' | 'organization' | 'system', provider: string, value: string) => port.set({ service: 'web_search', name: provider }, tier, ALICE, SecretBytes.from(value));
  return { svc, usage, metrics, setKey, providers, port };
}

describe('the service: tiers', () => {
  it('no key: forUser is null and status says why', async () => {
    const { svc } = service();
    expect(await svc.forUser(ALICE.userId, ALICE.orgId)).toBeNull();
    expect(await svc.status(ALICE.userId, ALICE.orgId)).toEqual({ enabled: false, reason: 'no_key', provider: null, today: { calls: 0, limit: 300, remaining: 300 }, perRunLimit: 30 });
    expect(await codeOf(svc.search(ALICE, req()))).toBe('NOT_CONFIGURED');
  });

  it("the user's own key wins over the organization's and the deployment's", async () => {
    const { svc, setKey, providers } = service();
    await setKey('system', 'alpha', 'system-key-000000');
    await setKey('user', 'alpha', 'user-key-0000000');
    expect((await svc.status(ALICE.userId, ALICE.orgId)).provider).toEqual({ id: 'alpha', label: 'Fake alpha', tier: 'user' });
    const port = (await svc.forUser(ALICE.userId, ALICE.orgId))!;
    const r = await port.search(req());
    expect(r.provider).toBe('alpha');
    expect(providers[0]!.log[0]).toMatchObject({ query: 'example widgets', authKind: 'api_key', keyPresent: true });
    expect(providers[0]!.seenKeys.every((k) => k.wiped)).toBe(true);
    expect(JSON.stringify(providers[0]!.log)).not.toContain('key-0000');
  });

  it('the deployment key is used only while shared; user keys only while allowed', async () => {
    const shared = service({ settings: { order: ['alpha'], shareDeploymentKey: false } });
    await shared.setKey('system', 'alpha', 'system-key-000000');
    expect((await shared.svc.status(ALICE.userId, ALICE.orgId)).reason).toBe('no_key');
    expect(await shared.svc.forUser(ALICE.userId, ALICE.orgId)).toBeNull();
    const on = service({ settings: { order: ['alpha'] } });
    await on.setKey('system', 'alpha', 'system-key-000000');
    expect((await on.svc.status(ALICE.userId, ALICE.orgId)).provider?.tier).toBe('system');

    const noUser = service({ settings: { order: ['alpha'], allowUserKeys: false } });
    await noUser.setKey('user', 'alpha', 'user-key-0000000');
    await noUser.setKey('organization', 'alpha', 'org-key-00000000');
    expect((await noUser.svc.status(ALICE.userId, ALICE.orgId)).provider?.tier).toBe('organization');
  });

  it('the switches: the deployment off, the user off, no provider listed or switched on', async () => {
    const a = service({ settings: { enabled: false } });
    await a.setKey('user', 'alpha', 'user-key-0000000');
    expect((await a.svc.status(ALICE.userId, ALICE.orgId)).reason).toBe('disabled_by_admin');
    const b = service({ user: { webSearch: { enabled: false } } });
    await b.setKey('user', 'alpha', 'user-key-0000000');
    expect((await b.svc.status(ALICE.userId, ALICE.orgId)).reason).toBe('disabled_by_you');
    expect(await b.svc.forUser(ALICE.userId, ALICE.orgId)).toBeNull();
    const c = service({ settings: { order: ['alpha'], providers: { alpha: { enabled: false } } } });
    expect((await c.svc.status(ALICE.userId, ALICE.orgId)).reason).toBe('no_provider');
    const d = service({ settings: { order: ['missing'] } });
    expect((await d.svc.status(ALICE.userId, ALICE.orgId)).reason).toBe('no_provider');
  });

  it("the user's preferred provider goes first among the usable ones", async () => {
    const { svc, setKey } = service({ user: { webSearch: { provider: 'beta' } } });
    await setKey('user', 'alpha', 'user-key-0000000');
    await setKey('user', 'beta', 'user-key-1111111');
    expect((await svc.status(ALICE.userId, ALICE.orgId)).provider?.id).toBe('beta');
  });
});

describe('the service: fallback and errors', () => {
  it('QUOTA_EXCEEDED from the first provider: the second answers and the result names it; both calls counted', async () => {
    const { svc, setKey, providers, usage, metrics } = service();
    await setKey('user', 'alpha', 'user-key-0000000');
    await setKey('system', 'beta', 'system-key-000000');
    providers[0]!.failNext('QUOTA_EXCEEDED');
    const r = await svc.search(ALICE, req());
    expect(r.provider).toBe('beta');
    expect(usage.rows).toEqual([
      { userId: 'u-alice', provider: 'alpha', failed: true, costUsd: 0.001 },
      { userId: 'u-alice', provider: 'beta', failed: false, costUsd: 0.001 },
    ]);
    expect(metrics.add.mock.calls).toEqual([
      ['webSearchCalls', 1, { provider: 'alpha', outcome: 'quota' }],
      ['webSearchCalls', 1, { provider: 'beta', outcome: 'ok' }],
    ]);
    expect([...providers[0]!.seenKeys, ...providers[1]!.seenKeys].every((k) => k.wiped)).toBe(true);
  });

  it('falls back once only, and never after RATE_LIMITED', async () => {
    const third = new FakeSearchProvider('gamma');
    const { svc, setKey, providers } = service({ providers: [new FakeSearchProvider('alpha'), new FakeSearchProvider('beta'), third] });
    for (const id of ['alpha', 'beta', 'gamma']) await setKey('user', id, 'user-key-0000000');
    providers[0]!.failNext('UNAVAILABLE');
    providers[1]!.failNext('AUTH_REFUSED');
    expect(await codeOf(svc.search(ALICE, req()))).toBe('AUTH_REFUSED');
    expect(third.log).toHaveLength(0);
    providers[0]!.failNext('RATE_LIMITED', 1500);
    expect(await codeOf(svc.search(ALICE, req()))).toBe('RATE_LIMITED');
    expect(providers[1]!.log).toHaveLength(1);
  });

  it('a provider that throws something else becomes UNAVAILABLE', async () => {
    const odd = new FakeSearchProvider('alpha');
    odd.search = async () => {
      throw new Error('provider text with secret details');
    };
    const { svc, setKey } = service({ providers: [odd] });
    await setKey('user', 'alpha', 'user-key-0000000');
    expect(await codeOf(svc.search(ALICE, req()))).toBe('UNAVAILABLE');
  });
});

describe('the service: limits', () => {
  it('the per-day limit reached gives LIMIT_REACHED before any call', async () => {
    const { svc, setKey, providers, usage, metrics } = service({ settings: { order: ['alpha'], limits: { perUserPerDay: 2 } } });
    await setKey('user', 'alpha', 'user-key-0000000');
    await svc.search(ALICE, req());
    await svc.search(ALICE, req());
    expect(await codeOf(svc.search(ALICE, req()))).toBe('LIMIT_REACHED');
    expect(providers[0]!.log).toHaveLength(2);
    expect(usage.rows).toHaveLength(2);
    expect(metrics.add).toHaveBeenLastCalledWith('webSearchCalls', 1, { provider: 'alpha', outcome: 'limit' });
    expect(await svc.status(ALICE.userId, ALICE.orgId)).toMatchObject({ today: { calls: 2, limit: 2, remaining: 0 } });
  });

  it('null is unlimited, per day and per run', async () => {
    const { svc, setKey } = service({ settings: { order: ['alpha'], limits: { perUserPerDay: null, perRun: null } } });
    await setKey('user', 'alpha', 'user-key-0000000');
    const port = (await svc.forUser(ALICE.userId, ALICE.orgId))!;
    for (let i = 0; i < 40; i++) await port.search(req());
    expect(await svc.status(ALICE.userId, ALICE.orgId)).toMatchObject({ today: { calls: 40, limit: null, remaining: null }, perRunLimit: null });
  });

  it('the per-run limit counts the calls of one port', async () => {
    const { svc, setKey } = service({ settings: { order: ['alpha'], limits: { perRun: 2 } } });
    await setKey('user', 'alpha', 'user-key-0000000');
    const port = (await svc.forUser(ALICE.userId, ALICE.orgId))!;
    await port.search(req());
    await port.search(req());
    expect(await codeOf(port.search(req()))).toBe('LIMIT_REACHED');
    // A new run's port starts again.
    await (await svc.forUser(ALICE.userId, ALICE.orgId))!.search(req());
  });
});

describe('the providers view and the cost estimate', () => {
  it('lists installed providers with the key tier and the estimate (the override when set); never a key', async () => {
    const { svc, setKey } = service({ settings: { order: ['alpha'], providers: { beta: { costPerCallUsd: 0.02, enabled: false } } } });
    await setKey('organization', 'alpha', 'org-key-SECRET00');
    const view = await svc.providers(ALICE.userId, ALICE.orgId);
    expect(view).toEqual([
      { id: 'alpha', label: 'Fake alpha', kind: 'results', credential: 'api_key', needsKey: true, enabled: true, listed: true, keyTier: 'organization', keys: { user: false, organization: true, system: false }, estimatedCostPerCallUsd: 0.001 },
      { id: 'beta', label: 'Fake beta', kind: 'results', credential: 'api_key', needsKey: true, enabled: false, listed: false, keyTier: null, keys: { user: false, organization: false, system: false }, estimatedCostPerCallUsd: 0.02 },
    ]);
    expect(JSON.stringify(view)).not.toContain('SECRET');
  });
});

describe('errors and metrics', () => {
  it('maps codes to HTTP with a fixed sentence', () => {
    expect(webSearchHttpError(new WebToolError('LIMIT_REACHED')).getStatus()).toBe(429);
    expect(webSearchHttpError(new WebToolError('NOT_CONFIGURED')).getResponse()).toMatchObject({ code: 'WEB_SEARCH_NOT_CONFIGURED' });
    expect(webSearchHttpError(new WebToolError('RATE_LIMITED', { retryAfterMs: 900 })).getResponse()).toMatchObject({ code: 'WEB_SEARCH_RATE_LIMITED', details: { retryAfterMs: 900 } });
    expect(webSearchHttpError(new WebToolError('BLOCKED')).getResponse()).toMatchObject({ code: 'WEB_SEARCH_UNAVAILABLE' });
    expect([null, 'AUTH_REFUSED', 'RATE_LIMITED', 'QUOTA_EXCEEDED', 'LIMIT_REACHED', 'UNAVAILABLE', 'BLOCKED'].map(outcomeOf)).toEqual(['ok', 'auth', 'rate_limited', 'quota', 'limit', 'unavailable', 'unavailable']);
  });
});
