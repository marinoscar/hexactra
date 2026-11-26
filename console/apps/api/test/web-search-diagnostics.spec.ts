// Diagnostics of web search (E50.13, #983), with in-memory stores and the fake provider: every stage and every code the report can
// carry (the fake can produce each one), the deployment tier never using a user's key, a user's report never revealing an unshared
// deployment key, the live query counted as one call, and no key in any report.
import { WebToolError } from '@marinoscar/hexactra-web-agent';
import type { CredentialsService, OrgCredentialsService, UserCredentialsService } from '@marinoscar/platform-api/credentials';

import { DIAGNOSTIC_REMEDIES } from '@app/shared';
import type { DiagnosticReport } from '../src/diagnostics/diagnostic-report';
import { SecretBytes } from '../src/secrets/secrets-provider.port';
import { CredentialStoreServiceCredentials } from '../src/service-credentials/credential-store.binding';
import type { Who } from '../src/service-credentials/service-credential.port';
import { ServiceCredentialRegistry } from '../src/service-credentials/service-credential.registry';
import { SearchProviderRegistry } from '../src/web-search/search-provider';
import { FakeSearchProvider } from '../src/web-search/testing/fake-search-provider';
import { DIAGNOSTIC_QUERY, FETCH_CHECK_URL, SEARCH_DIAGNOSTIC_CODES, SEARCH_REMEDIES, transportOutcome } from '../src/web-search/web-search-diagnostics';
import { WebSearchDiagnostics, type WebFetchDiagnosticHook } from '../src/web-search/web-search-diagnostics.service';
import { resolveWebSearchSystemSettings, type WebSearchSystemSettings } from '../src/web-search/web-search.settings';
import { DIAGNOSTIC_FETCH_CACHE_KEY, WebFetchDiagnosticBinding } from '../src/web-search/fetch/web-fetch.diagnostic';
import { WebFetchService } from '../src/web-search/fetch/web-fetch.service';
import { FakeWeb } from '../src/web-search/testing/fake-web';
import { WebSearchService } from '../src/web-search/web-search.service';
import type { WebSearchUsage } from '../src/web-search/web-search.usage';
import { OutboundHttpError } from '../src/oauth-client/outbound-http';

const ALICE: Who = { userId: 'u-alice', orgId: 'o-acme' };
const ADMIN = 'u-admin';
const MARKER = 'MARKERkey0123456789abcdefghij';

function stores() {
  const rows = new Map<string, string>();
  const info = (k: string) => (rows.has(k) ? { updatedAt: new Date() } : null);
  const users = { getSecret: async (u: string, p: string, n: string) => rows.get(`user:${u}:${p}:${n}`) ?? null, describe: async (u: string, p: string, n: string) => info(`user:${u}:${p}:${n}`), setSecret: async (u: string, p: string, n: string, s: string) => void rows.set(`user:${u}:${p}:${n}`, s), deleteSecret: async () => undefined };
  const orgs = { getSecret: async (o: string, p: string, n: string) => rows.get(`org:${o}:${p}:${n}`) ?? null, describe: async (o: string, p: string, n: string) => info(`org:${o}:${p}:${n}`), setSecret: async (o: string, p: string, n: string, s: string) => void rows.set(`org:${o}:${p}:${n}`, s), deleteSecret: async () => undefined };
  const system = { getSecret: async (p: string, n: string) => rows.get(`system:${p}:${n}`) ?? null, describe: async (p: string, n: string) => info(`system:${p}:${n}`), setSecret: async (p: string, n: string, s: string) => void rows.set(`system:${p}:${n}`, s), deleteSecret: async () => undefined };
  return { users, orgs, system };
}

class MemoryUsage {
  rows: { userId: string; provider: string; failed: boolean }[] = [];
  async record(userId: string, provider: string, _at: Date, o: { failed: boolean }) {
    this.rows.push({ userId, provider, failed: o.failed });
  }
  async callsOn(userId: string) {
    return this.rows.filter((r) => r.userId === userId).length;
  }
}

function setup(opts: { settings?: WebSearchSystemSettings; user?: unknown; fetch?: WebFetchDiagnosticHook | null; brokenStore?: boolean } = {}) {
  const creds = new ServiceCredentialRegistry();
  const registry = new SearchProviderRegistry(creds);
  const fake = new FakeSearchProvider('alpha');
  registry.register(fake);
  const s = stores();
  if (opts.brokenStore) s.users.describe = async () => Promise.reject(new Error('vault down'));
  const port = new CredentialStoreServiceCredentials(creds, s.users as unknown as UserCredentialsService, s.orgs as unknown as OrgCredentialsService, s.system as unknown as CredentialsService);
  const usage = new MemoryUsage();
  const prisma = { userSettings: { findUnique: async () => (opts.user === undefined ? null : { value: opts.user }) } };
  const settings = { getNamespace: async () => opts.settings ?? { order: ['alpha'] } };
  const service = new WebSearchService(registry, port, usage as unknown as WebSearchUsage, prisma as never, settings as never, { add: jest.fn(), record: jest.fn() } as never);
  const stored: { report: DiagnosticReport; owner: string | null }[] = [];
  const history = { record: async (report: DiagnosticReport, owner: string | null) => (stored.push({ report, owner }), { id: 'r', ...report }) };
  const metrics = { run: jest.fn() };
  const fetchHook = opts.fetch === undefined ? { enabled: async () => true, read: jest.fn(async () => undefined) } : (opts.fetch ?? undefined);
  const d = new WebSearchDiagnostics(registry, service, port, usage as unknown as WebSearchUsage, history as never, metrics as never, fetchHook);
  const setKey = (tier: 'user' | 'organization' | 'system', value: string) => port.set({ service: 'web_search', name: 'alpha' }, tier, ALICE, SecretBytes.from(value));
  const user = () => d.diagnose({ kind: 'user', who: ALICE }, fake, 'owner');
  const deployment = () => d.diagnose({ kind: 'deployment', adminId: ADMIN }, fake, 'admin');
  return { d, fake, usage, stored, metrics, setKey, user, deployment, fetchHook };
}

const stage = (r: DiagnosticReport, id: string) => r.stages.find((s) => s.id === id)!;
const brief = (r: DiagnosticReport) => r.stages.map((s) => `${s.id}:${s.status}${s.code ? `:${s.code}` : ''}`);

describe('a user report', () => {
  it('every stage in order, passing; the live query is the fixed word, counted as one call; stored with the user as owner', async () => {
    const t = setup();
    await t.setKey('user', MARKER);
    const r = await t.user();
    expect(brief(r)).toEqual(['switches:pass', 'credential:pass', 'network:pass', 'live_query:pass', 'limits:pass', 'fetch:pass']);
    expect(r.target).toEqual({ kind: 'search_provider', id: 'alpha' });
    expect(stage(r, 'switches').data).toEqual({ position: 1 });
    expect(stage(r, 'credential').data).toEqual({ tier: 'user', binding: 'credential_store' });
    expect(stage(r, 'limits').data).toEqual({ calls: 1, limit: 300 });
    expect(t.fake.log).toEqual([expect.objectContaining({ query: DIAGNOSTIC_QUERY, count: 1, site: null })]);
    expect(t.usage.rows).toEqual([{ userId: ALICE.userId, provider: 'alpha', failed: false }]);
    expect(t.fetchHook!.read).toHaveBeenCalledWith(FETCH_CHECK_URL, expect.anything());
    expect(t.stored[0]!.owner).toBe(ALICE.userId);
    expect(t.fake.seenKeys.every((k) => k.wiped)).toBe(true);
    expect(JSON.stringify(t.stored)).not.toContain(MARKER);
    expect(t.metrics.run).toHaveBeenCalledWith('search_provider', 'alpha', 'pass');
  });

  it('switches: the deployment off, the user off, the provider off, not in the order', async () => {
    const off = await setup({ settings: { enabled: false, order: ['alpha'] } }).user();
    expect(brief(off)).toEqual(['switches:fail:SEARCH_OFF', 'credential:skipped', 'network:skipped', 'live_query:skipped', 'limits:pass', 'fetch:pass']);
    expect(stage(off, 'switches').remedy).toBe('SEARCH_OFF');
    const mine = await setup({ user: { webSearch: { enabled: false } } }).user();
    expect(stage(mine, 'switches')).toMatchObject({ status: 'fail', code: 'SEARCH_OFF', remedy: 'SEARCH_OFF_BY_YOU' });
    expect(stage(await setup({ settings: { order: ['alpha'], providers: { alpha: { enabled: false } } } }).user(), 'switches')).toMatchObject({ status: 'fail', code: 'PROVIDER_OFF', remedy: 'SEARCH_PROVIDER_OFF' });
    const t = setup({ settings: { order: [] } });
    await t.setKey('user', MARKER);
    const r = await t.user();
    expect(stage(r, 'switches')).toMatchObject({ status: 'warn', code: 'NOT_IN_ORDER' });
    expect(stage(r, 'live_query').status).toBe('pass');
  });

  it('credential: KEY_MISSING (also when only an unshared deployment key exists), USER_KEYS_NOT_ALLOWED, SECRETS_PROVIDER_UNAVAILABLE', async () => {
    const none = setup();
    expect(brief(await none.user()).slice(0, 4)).toEqual(['switches:pass', 'credential:fail:KEY_MISSING', 'network:skipped', 'live_query:skipped']);
    expect(none.fake.log).toHaveLength(0);
    expect(none.usage.rows).toHaveLength(0);

    const unshared = setup({ settings: { order: ['alpha'], shareDeploymentKey: false } });
    await unshared.setKey('system', MARKER);
    const r = await unshared.user();
    expect(stage(r, 'credential')).toEqual({ id: 'credential', status: 'fail', code: 'KEY_MISSING', remedy: 'KEY_MISSING', ms: expect.any(Number) });
    expect(JSON.stringify(r)).not.toMatch(/system|NOT_SHARED/);

    const notAllowed = setup({ settings: { order: ['alpha'], allowUserKeys: false } });
    await notAllowed.setKey('user', MARKER);
    expect(stage(await notAllowed.user(), 'credential')).toMatchObject({ status: 'fail', code: 'USER_KEYS_NOT_ALLOWED' });

    expect(stage(await setup({ brokenStore: true }).user(), 'credential')).toMatchObject({ status: 'fail', code: 'SECRETS_PROVIDER_UNAVAILABLE' });
  });

  it('credential of a provider without a key: ADDRESS_MISSING; and of an AI provider: its own check (MODEL_NOT_CHOSEN)', async () => {
    const t = setup();
    const open = new FakeSearchProvider('open', 'Open', 'none');
    const r1 = await t.d.diagnose({ kind: 'user', who: ALICE }, open, 'owner');
    expect(stage(r1, 'credential')).toMatchObject({ status: 'fail', code: 'ADDRESS_MISSING' });
    const ai = Object.assign(new FakeSearchProvider('ai', 'AI', 'ai_service'), { diagnoseCredential: async () => ({ status: 'fail' as const, code: 'MODEL_NOT_CHOSEN' }) });
    expect(stage(await t.d.diagnose({ kind: 'user', who: ALICE }, ai, 'owner'), 'credential')).toMatchObject({ status: 'fail', code: 'MODEL_NOT_CHOSEN' });
  });

  it('network: every transport code; the live query is then skipped and not counted', async () => {
    for (const code of ['UNRESOLVABLE', 'PRIVATE_TARGET', 'TLS_FAILED', 'TIMEOUT', 'NETWORK'] as const) {
      const t = setup();
      await t.setKey('user', MARKER);
      t.fake.failNetworkNext(code);
      const r = await t.user();
      expect(stage(r, 'network')).toMatchObject({ status: 'fail', code, remedy: SEARCH_REMEDIES[code] ?? code });
      expect(stage(r, 'live_query').status).toBe('skipped');
      expect(t.usage.rows).toHaveLength(0);
    }
    expect(transportOutcome(new OutboundHttpError('network', 'Network error (CERT_HAS_EXPIRED).')).code).toBe('TLS_FAILED');
    expect(transportOutcome(new OutboundHttpError('private_target', 'x')).code).toBe('PRIVATE_TARGET');
    expect(transportOutcome(new OutboundHttpError('unresolvable', 'x')).code).toBe('UNRESOLVABLE');
  });

  it('live_query: AUTH_REFUSED, RATE_LIMITED (warn), QUOTA_EXCEEDED, UNAVAILABLE, FORMAT_DISABLED, NO_RESULTS (warn); a failure is still one call', async () => {
    const cases: [string, (f: FakeSearchProvider) => void, string][] = [
      ['AUTH_REFUSED', (f) => f.failNext('AUTH_REFUSED'), 'fail'],
      ['RATE_LIMITED', (f) => f.failNext('RATE_LIMITED'), 'warn'],
      ['QUOTA_EXCEEDED', (f) => f.failNext('QUOTA_EXCEEDED'), 'fail'],
      ['UNAVAILABLE', (f) => f.failNext('UNAVAILABLE'), 'fail'],
      ['FORMAT_DISABLED', (f) => f.liveCodeNext('FORMAT_DISABLED'), 'fail'],
      ['NO_RESULTS', (f) => (f.hits = []), 'warn'],
    ];
    for (const [code, script, status] of cases) {
      const t = setup();
      await t.setKey('user', MARKER);
      script(t.fake);
      const r = await t.user();
      expect([code, stage(r, 'live_query').status, stage(r, 'live_query').code]).toEqual([code, status, code]);
      expect(t.usage.rows).toEqual([expect.objectContaining({ failed: status === 'fail' })]);
    }
    const t = setup();
    await t.setKey('user', MARKER);
    t.fake.failNext('AUTH_REFUSED');
    expect(stage(await t.user(), 'live_query').remedy).toBe('SEARCH_KEY_REFUSED');
  });

  it('limits: LIMIT_NEAR over 80%, LIMIT_REACHED (no query sent), unlimited', async () => {
    const near = setup({ settings: { order: ['alpha'], limits: { perUserPerDay: 5 } } });
    await near.setKey('user', MARKER);
    for (let i = 0; i < 4; i++) near.usage.rows.push({ userId: ALICE.userId, provider: 'alpha', failed: false });
    expect(stage(await near.user(), 'limits')).toMatchObject({ status: 'fail', code: 'LIMIT_REACHED', data: { calls: 5, limit: 5 } });

    const warn = setup({ settings: { order: ['alpha'], limits: { perUserPerDay: 10 } } });
    await warn.setKey('user', MARKER);
    for (let i = 0; i < 8; i++) warn.usage.rows.push({ userId: ALICE.userId, provider: 'alpha', failed: false });
    expect(stage(await warn.user(), 'limits')).toMatchObject({ status: 'warn', code: 'LIMIT_NEAR', data: { calls: 9, limit: 10 } });

    const full = setup({ settings: { order: ['alpha'], limits: { perUserPerDay: 1 } } });
    await full.setKey('user', MARKER);
    full.usage.rows.push({ userId: ALICE.userId, provider: 'alpha', failed: false });
    const r = await full.user();
    expect(stage(r, 'live_query')).toMatchObject({ status: 'skipped', code: 'LIMIT_REACHED' });
    expect(full.fake.log).toHaveLength(0);
    expect(full.usage.rows).toHaveLength(1);

    const unl = setup({ settings: { order: ['alpha'], limits: { perUserPerDay: null } } });
    await unl.setKey('user', MARKER);
    expect(stage(await unl.user(), 'limits')).toMatchObject({ status: 'pass', data: { calls: 1, unlimited: true } });
  });

  it('fetch: skipped with FETCH_OFF when off (nothing read), BLOCKED, UNAVAILABLE; skipped while no hook is bound', async () => {
    const read = jest.fn();
    const off = setup({ fetch: { enabled: async () => false, read } });
    expect(stage(await off.user(), 'fetch')).toMatchObject({ status: 'skipped', code: 'FETCH_OFF', remedy: 'FETCH_OFF' });
    expect(read).not.toHaveBeenCalled();
    const blocked = setup({ fetch: { enabled: async () => true, read: async () => Promise.reject(new WebToolError('BLOCKED')) } });
    expect(stage(await blocked.user(), 'fetch')).toMatchObject({ status: 'fail', code: 'BLOCKED', data: { host: 'example.com' } });
    const down = setup({ fetch: { enabled: async () => true, read: async () => Promise.reject(new WebToolError('UNAVAILABLE')) } });
    expect(stage(await down.user(), 'fetch')).toMatchObject({ status: 'fail', code: 'UNAVAILABLE', remedy: 'FETCH_UNAVAILABLE' });
    expect(stage(await setup({ fetch: null }).user(), 'fetch')).toMatchObject({ status: 'skipped', code: null, data: { installed: false } });
  });
});

describe('the fetch stage through the real page reader (WebFetchService over the fake web)', () => {
  const reader = (settings: WebSearchSystemSettings, web = new FakeWeb()) => {
    const webSearch = { system: async () => resolveWebSearchSystemSettings(settings) } as unknown as WebSearchService;
    const fetcher = new WebFetchService(web as never, webSearch, { add: jest.fn(), record: jest.fn() } as never);
    return { binding: new WebFetchDiagnosticBinding(fetcher, webSearch), web, fetcher };
  };

  it('pass: the fixed page is read once per report, never from the cache, and nothing is kept', async () => {
    const r = reader({ order: ['alpha'] });
    r.web.html(FETCH_CHECK_URL, '<html><head><title>Example Domain</title></head><body><p>This domain is for use in documentation.</p></body></html>');
    const t = setup({ fetch: r.binding });
    const first = await t.user();
    expect(stage(first, 'fetch')).toMatchObject({ status: 'pass', code: null, data: { host: 'example.com' } });
    await t.user();
    expect(r.web.requestsTo('example.com')).toHaveLength(2);
    expect(r.fetcher.cache.size(DIAGNOSTIC_FETCH_CACHE_KEY)).toBe(0);
    expect(r.web.requests.every((q) => !Object.keys(q.headers).some((h) => /cookie|authorization/i.test(h)))).toBe(true);
  });

  it('skipped when webSearch.fetch.enabled is off; BLOCKED by the blocked hosts or a private address; UNAVAILABLE on an error', async () => {
    const off = reader({ order: ['alpha'], fetch: { enabled: false } });
    expect(stage(await setup({ fetch: off.binding }).user(), 'fetch')).toMatchObject({ status: 'skipped', code: 'FETCH_OFF' });
    expect(off.web.requests).toHaveLength(0);

    const blocked = reader({ order: ['alpha'], fetch: { blockedHosts: ['example.com'] } });
    expect(stage(await setup({ fetch: blocked.binding }).user(), 'fetch')).toMatchObject({ status: 'fail', code: 'BLOCKED' });
    expect(blocked.web.requests).toHaveLength(0);

    const priv = reader({ order: ['alpha'] });
    priv.web.resolve('example.com', ['10.0.0.5']);
    expect(stage(await setup({ fetch: priv.binding }).user(), 'fetch')).toMatchObject({ status: 'fail', code: 'BLOCKED' });
    expect(priv.web.requests).toHaveLength(0);

    const down = reader({ order: ['alpha'] });
    down.web.page(FETCH_CHECK_URL, { status: 503, body: 'down' });
    expect(stage(await setup({ fetch: down.binding }).user(), 'fetch')).toMatchObject({ status: 'fail', code: 'UNAVAILABLE', remedy: 'FETCH_UNAVAILABLE' });
  });
});

describe('a deployment report', () => {
  it("uses the deployment's key only, never a user's; stored with no owner; the live query is the administrator's call", async () => {
    const t = setup();
    await t.setKey('user', 'userkey-0123456789abcdef');
    const missing = await t.deployment();
    expect(stage(missing, 'credential')).toMatchObject({ status: 'fail', code: 'KEY_MISSING', remedy: 'DEPLOYMENT_KEY_MISSING' });
    expect(t.fake.log).toHaveLength(0);

    await t.setKey('system', MARKER);
    const r = await t.deployment();
    expect(brief(r)).toEqual(['switches:pass', 'credential:pass', 'network:pass', 'live_query:pass', 'limits:pass', 'fetch:pass']);
    expect(stage(r, 'credential').data).toEqual({ tier: 'system', binding: 'credential_store' });
    expect(stage(r, 'limits').data).toEqual({ limit: 300 });
    expect(t.stored.at(-1)!.owner).toBeNull();
    expect(t.usage.rows).toEqual([{ userId: ADMIN, provider: 'alpha', failed: false }]);
    expect(JSON.stringify(t.stored)).not.toContain(MARKER);
  });

  it('an unshared key warns DEPLOYMENT_KEY_NOT_SHARED; search off only warns, so the key can be tested first', async () => {
    const t = setup({ settings: { enabled: false, order: ['alpha'], shareDeploymentKey: false } });
    await t.setKey('system', MARKER);
    const r = await t.deployment();
    expect(brief(r).slice(0, 4)).toEqual(['switches:warn:SEARCH_OFF', 'credential:warn:DEPLOYMENT_KEY_NOT_SHARED', 'network:pass', 'live_query:pass']);
  });
});

describe('the remedy table', () => {
  it('has an entry for every code and remedy key a search report can carry', () => {
    const t = setup();
    const keys = [...SEARCH_DIAGNOSTIC_CODES, ...Object.values(SEARCH_REMEDIES), ...(t.fake.diagnosticCodes ?? []), 'SEARCH_OFF_BY_YOU', 'DEPLOYMENT_KEY_MISSING', 'FETCH_UNAVAILABLE'];
    expect(keys.filter((k) => !DIAGNOSTIC_REMEDIES[k])).toEqual([]);
  });
});
