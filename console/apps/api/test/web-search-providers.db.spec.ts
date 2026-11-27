// More search providers against a real database (E50.8, #978): the providers API lists Tavily, Exa and SearXNG as data (label, kind,
// credential: the web app needs no change); a fallback across two real adapters (Brave's quota spent → Tavily answers; both calls
// counted); the user's preferred provider goes first; and SearXNG end to end against a fake instance: its address refused when saved
// without the private-network tick, accepted with it, a search through the real adapter and the real address rule, the diagnostic
// report with FORMAT_DISABLED, and the egress entry naming its configured host. Invented data; no provider is called.
import { randomUUID } from 'node:crypto';
import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import { EgressRegistry } from '@marinoscar/platform-api/doctor';

import { createApp } from '../src/main';
import { PrismaService } from '../src/prisma/prisma.service';
import { BraveSearchProvider } from '../src/web-search/providers/brave.provider';
import { SearxngSearchProvider } from '../src/web-search/providers/searxng.provider';
import { TavilySearchProvider } from '../src/web-search/providers/tavily.provider';
import { FakeBrave } from '../src/web-search/testing/fake-brave';
import { FakeSearxng } from '../src/web-search/testing/fake-searxng';
import { FakeTavily } from '../src/web-search/testing/fake-tavily';
import { WebSearchAdminService } from '../src/web-search/web-search-admin.service';

const savedKey = process.env.SECRETS_ENCRYPTION_KEY;
process.env.SECRETS_ENCRYPTION_KEY ||= Buffer.alloc(32, 7).toString('base64');
const stamp = randomUUID().slice(0, 8);
const MARKER = `MARKER${randomUUID().replace(/-/g, '')}`;
const BRAVE_KEY = `${MARKER}brave`;
const TAVILY_KEY = `${MARKER}tavily`;
const SEARXNG = 'http://10.0.0.5:8080';

let app: NestFastifyApplication;
let prisma: PrismaService;
let brave: FakeBrave;
let tavily: FakeTavily;
let searxng: FakeSearxng;
const responses: string[] = [];
const userIds: string[] = [];

interface Session {
  token: string;
  userId: string;
  orgId: string | null;
}

async function login(name: string, role: 'contributor' | 'admin' = 'contributor'): Promise<Session> {
  const res = await app.inject({ method: 'POST', url: '/api/auth/test/login', payload: { email: `${name}-${stamp}@example.test`, role } });
  const token = new URL(String(res.headers.location)).searchParams.get('token')!;
  const me = await app.inject({ method: 'GET', url: '/api/auth/me', headers: { authorization: `Bearer ${token}` } });
  const data = me.json<{ data: { id: string; activeOrg?: { id: string } | null } }>().data;
  userIds.push(data.id);
  return { token, userId: data.id, orgId: data.activeOrg?.id ?? null };
}

type Body = { data?: unknown; error?: { code?: string; details?: unknown }; code?: string; details?: unknown };
async function call(s: Session, method: 'GET' | 'PUT' | 'POST' | 'DELETE' | 'PATCH', url: string, payload?: unknown) {
  const res = await app.inject({ method, url, headers: { authorization: `Bearer ${s.token}` }, ...(payload === undefined ? {} : { payload: payload as object }) });
  responses.push(`${res.statusCode} ${res.body}`);
  return { status: res.statusCode, body: (res.body ? res.json() : null) as Body | null };
}
const codeOf = (r: Awaited<ReturnType<typeof call>>) => r.body?.error?.code ?? r.body?.code;
const data = <T>(r: Awaited<ReturnType<typeof call>>) => r.body!.data as T;

const RESET = { enabled: true, order: ['brave'], shareDeploymentKey: true, allowUserKeys: true, limits: { perRun: 30, perUserPerDay: 300 }, providers: { brave: { enabled: true, costPerCallUsd: null }, searxng: { baseUrl: null, allowPrivate: false } } };

let admin: Session;

beforeAll(async () => {
  app = await createApp();
  await app.init();
  await app.getHttpAdapter().getInstance().ready();
  prisma = app.get(PrismaService);
  brave = new FakeBrave([BRAVE_KEY]);
  tavily = new FakeTavily([TAVILY_KEY]);
  searxng = new FakeSearxng(SEARXNG);
  // The real adapters over fake endpoints instead of the network; the administrator's address check uses the fake instance's DNS.
  Object.assign(app.get(BraveSearchProvider, { strict: false }), { http: brave });
  Object.assign(app.get(TavilySearchProvider, { strict: false }), { http: tavily });
  Object.assign(app.get(SearxngSearchProvider, { strict: false }), { http: searxng });
  Object.assign(app.get(WebSearchAdminService, { strict: false }), { http: searxng });
  admin = await login('wsp-admin', 'admin');
  expect((await call(admin, 'PUT', '/api/web-search/admin', { ...RESET, shareDeploymentKey: false })).status).toBe(200);
}, 120_000);

afterAll(async () => {
  try {
    await call(admin, 'PUT', '/api/web-search/admin', RESET);
    await prisma?.webSearchUsage.deleteMany({ where: { userId: { in: userIds } } });
  } finally {
    await app?.close();
    if (savedKey === undefined) delete process.env.SECRETS_ENCRYPTION_KEY;
    else process.env.SECRETS_ENCRYPTION_KEY = savedKey;
  }
});

describe('the providers API', () => {
  it('lists every installed provider as data: label, kind, credential, whether it needs a key, its estimate', async () => {
    const s = await login('wsp-list');
    const list = data<{ id: string; label: string; kind: string; credential: string; needsKey: boolean; listed: boolean; estimatedCostPerCallUsd: number | null }[]>(await call(s, 'GET', '/api/web-search/providers'));
    expect(list.map((p) => [p.id, p.label, p.kind, p.credential, p.needsKey, p.listed, p.estimatedCostPerCallUsd])).toEqual([
      ['brave', 'Brave Search', 'results', 'api_key', true, true, 0.005],
      ['tavily', 'Tavily', 'results', 'api_key', true, false, 0.008],
      ['exa', 'Exa', 'results', 'api_key', true, false, 0.01],
      ['searxng', 'SearXNG (self-hosted)', 'results', 'none', false, false, 0],
    ]);
  });
});

describe('order and fallback', () => {
  it("Brave's quota spent: Tavily answers, the result names it, both calls are counted; a provider not in the order is never tried", async () => {
    const s = await login('wsp-fallback');
    expect((await call(s, 'PUT', '/api/service-credentials/web_search/brave', { value: BRAVE_KEY })).status).toBe(204);
    expect((await call(s, 'PUT', '/api/service-credentials/web_search/tavily', { value: TAVILY_KEY })).status).toBe(204);

    // Tavily has a key but is not in the order: it is not used.
    brave.stub({ status: 402 });
    const before = tavily.requests.length;
    const alone = await call(s, 'POST', '/api/web-search/search', { query: 'example widgets' });
    expect([alone.status, codeOf(alone)]).toEqual([502, 'WEB_SEARCH_QUOTA_EXCEEDED']);
    expect(tavily.requests.length).toBe(before);

    expect((await call(admin, 'PUT', '/api/web-search/admin', { order: ['brave', 'tavily'] })).status).toBe(200);
    brave.stub({ status: 429, headers: { 'x-ratelimit-remaining': '1, 0' } });
    const r = await call(s, 'POST', '/api/web-search/search', { query: 'example widgets', count: 2, site: 'docs.example.test' });
    expect(r.status).toBe(200);
    expect(data(r)).toEqual({ provider: 'tavily', answer: null, hits: [{ title: 'Example widgets & parts', url: 'https://docs.example.test/widgets', snippet: 'An invented page about widgets.', publishedAt: '2026-10-01T00:00:00Z' }] });
    expect(tavily.requests[tavily.requests.length - 1]).toMatchObject({ keyPresent: true, body: expect.objectContaining({ include_domains: ['docs.example.test'], search_depth: 'basic' }) });
    const rows = await prisma.webSearchUsage.findMany({ where: { userId: s.userId }, orderBy: { provider: 'asc' } });
    expect(rows.map((u) => [u.provider, u.calls, u.failures])).toEqual([
      ['brave', 2, 2],
      ['tavily', 1, 0],
    ]);

    // Switched off by the administrator: Tavily is skipped although listed.
    expect((await call(admin, 'PUT', '/api/web-search/admin', { providers: { tavily: { enabled: false } } })).status).toBe(200);
    brave.stub({ status: 402 });
    expect(codeOf(await call(s, 'POST', '/api/web-search/search', { query: 'example widgets' }))).toBe('WEB_SEARCH_QUOTA_EXCEEDED');
    expect((await call(admin, 'PUT', '/api/web-search/admin', { providers: { tavily: { enabled: true } } })).status).toBe(200);
  });

  it("the user's preferred provider goes first for that user only", async () => {
    const s = await login('wsp-prefers');
    const other = await login('wsp-default');
    for (const who of [s, other]) {
      expect((await call(who, 'PUT', '/api/service-credentials/web_search/brave', { value: BRAVE_KEY })).status).toBe(204);
      expect((await call(who, 'PUT', '/api/service-credentials/web_search/tavily', { value: TAVILY_KEY })).status).toBe(204);
    }
    expect((await call(s, 'PATCH', '/api/user-settings', { webSearch: { provider: 'tavily' } })).status).toBeLessThan(300);
    expect(data(await call(s, 'GET', '/api/web-search/status'))).toMatchObject({ provider: { id: 'tavily', tier: 'user' } });
    expect(data<{ provider: string }>(await call(s, 'POST', '/api/web-search/search', { query: 'example widgets' })).provider).toBe('tavily');
    expect(data<{ provider: string }>(await call(other, 'POST', '/api/web-search/search', { query: 'example widgets' })).provider).toBe('brave');
  });
});

describe('SearXNG, self-hosted', () => {
  it("its address: a private http address is refused without the tick and saved with it; then searches go to that host", async () => {
    const refused = await call(admin, 'PUT', '/api/web-search/admin', { providers: { searxng: { baseUrl: SEARXNG } } });
    expect([refused.status, codeOf(refused)]).toEqual([422, 'WEB_SEARCH_ADDRESS_REFUSED']);
    const privateHttps = await call(admin, 'PUT', '/api/web-search/admin', { providers: { searxng: { baseUrl: 'https://10.0.0.5' } } });
    expect([privateHttps.status, codeOf(privateHttps)]).toEqual([422, 'WEB_SEARCH_ADDRESS_REFUSED']);
    expect((await call(admin, 'PUT', '/api/web-search/admin', { providers: { searxng: { baseUrl: 'https://search.example.test?x=1' } } })).status).toBe(400);

    const saved = await call(admin, 'PUT', '/api/web-search/admin', { order: ['searxng', 'brave'], providers: { searxng: { baseUrl: SEARXNG, allowPrivate: true } } });
    expect(saved.status).toBe(200);
    expect(data<{ providers: Record<string, unknown> }>(saved).providers.searxng).toEqual({ enabled: true, costPerCallUsd: null, baseUrl: SEARXNG, allowPrivate: true });
    // Unticking it again while the address is private http is refused.
    expect(codeOf(await call(admin, 'PUT', '/api/web-search/admin', { providers: { searxng: { allowPrivate: false } } }))).toBe('WEB_SEARCH_ADDRESS_REFUSED');

    const s = await login('wsp-searxng');
    expect(data(await call(s, 'GET', '/api/web-search/status'))).toMatchObject({ enabled: true, provider: { id: 'searxng', label: 'SearXNG (self-hosted)', tier: null } });
    const r = await call(s, 'POST', '/api/web-search/search', { query: 'example widgets', freshness: 'week' });
    expect(r.status).toBe(200);
    expect(data<{ provider: string; hits: unknown[] }>(r)).toMatchObject({ provider: 'searxng', hits: [expect.objectContaining({ url: 'https://docs.example.test/widgets' }), expect.objectContaining({ url: 'http://shop.example.test/catalogue' })] });
    expect(searxng.requests[searxng.requests.length - 1]).toMatchObject({ url: 'http://10.0.0.5:8080/search', address: '10.0.0.5', query: expect.objectContaining({ format: 'json', time_range: 'week' }) });
    expect(await prisma.webSearchUsage.findFirst({ where: { userId: s.userId } })).toMatchObject({ provider: 'searxng', calls: 1, failures: 0 });

    // The egress list names the configured host and says private addresses are accepted for it.
    const contributor = app.get(EgressRegistry, { strict: false }).list().find((c) => c.id === 'web_search')!;
    const entry = (await contributor.describe()).find((d) => d.id === 'web_search.searxng')!;
    expect(entry).toMatchObject({ enabled: true, hosts: ['10.0.0.5', 'example.com'] });
    expect(entry.capability).toBe('Web search (SearXNG (self-hosted), private network allowed for its configured host)');
  });

  it('JSON switched off at the instance: the search falls back to the next provider; the report says FORMAT_DISABLED', async () => {
    const s = await login('wsp-format');
    expect((await call(s, 'PUT', '/api/service-credentials/web_search/brave', { value: BRAVE_KEY })).status).toBe(204);
    searxng.jsonEnabled = false;
    try {
      expect(data<{ provider: string }>(await call(s, 'POST', '/api/web-search/search', { query: 'example widgets' })).provider).toBe('brave');
      const report = data<{ stages: { id: string; status: string; code: string | null; remedy: string | null }[] }>(await call(admin, 'POST', '/api/web-search/admin/providers/searxng/diagnose'));
      expect(report.stages.find((st) => st.id === 'credential')).toMatchObject({ status: 'pass' });
      expect(report.stages.find((st) => st.id === 'network')).toMatchObject({ status: 'pass' });
      expect(report.stages.find((st) => st.id === 'live_query')).toMatchObject({ status: 'fail', code: 'FORMAT_DISABLED', remedy: 'FORMAT_DISABLED' });
    } finally {
      searxng.jsonEnabled = true;
    }
  });
});

describe('the marker scan', () => {
  it('no key in a response, a usage row or a fake request log', async () => {
    const usage = await prisma.webSearchUsage.findMany({ where: { userId: { in: userIds } } });
    for (const [what, text] of [
      ['responses', responses.join('\n')],
      ['usage rows', JSON.stringify(usage)],
      ['fake requests', JSON.stringify([brave.requests, tavily.requests, searxng.requests])],
    ] as const) {
      expect({ what, leaked: text.includes(MARKER) }).toEqual({ what, leaked: false });
    }
  });
});
