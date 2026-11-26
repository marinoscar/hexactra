// Web search against a real database (E50.5, #975): the routes and their permissions for each role; the tiers through the real
// credential stores (the user's own key, the deployment's only while shared); one search through the real Brave adapter over an
// in-process fake of its endpoint; the usage table and the per-day limit; the administrator's settings and usage; the egress entry;
// and a seeded-marker scan of every response, audit row, log line and usage row (the key never appears).
import { randomUUID } from 'node:crypto';
import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import { EgressRegistry } from '@marinoscar/platform-api/doctor';

import { createApp } from '../src/main';
import { PrismaService } from '../src/prisma/prisma.service';
import { BraveSearchProvider } from '../src/web-search/providers/brave.provider';
import { FakeBrave } from '../src/web-search/testing/fake-brave';
import { WebSearchService } from '../src/web-search/web-search.service';

const savedKey = process.env.SECRETS_ENCRYPTION_KEY;
process.env.SECRETS_ENCRYPTION_KEY ||= Buffer.alloc(32, 7).toString('base64');
const stamp = randomUUID().slice(0, 8);
const MARKER = `MARKER${randomUUID().replace(/-/g, '')}`;
const USER_KEY = `${MARKER}user`;
const SYSTEM_KEY = `${MARKER}system`;

let app: NestFastifyApplication;
let prisma: PrismaService;
let fake: FakeBrave;
const responses: string[] = [];
const logs: string[] = [];
const userIds: string[] = [];
const originalWrites = { out: process.stdout.write.bind(process.stdout), err: process.stderr.write.bind(process.stderr) };

interface Session {
  token: string;
  userId: string;
  orgId: string | null;
}
type Role = 'contributor' | 'viewer' | 'admin' | 'org_admin';

async function login(name: string, role: Role = 'contributor'): Promise<Session> {
  const res = await app.inject({ method: 'POST', url: '/api/auth/test/login', payload: { email: `${name}-${stamp}@example.test`, role } });
  const token = new URL(String(res.headers.location)).searchParams.get('token')!;
  const me = await app.inject({ method: 'GET', url: '/api/auth/me', headers: { authorization: `Bearer ${token}` } });
  const data = me.json<{ data: { id: string; activeOrg?: { id: string } | null } }>().data;
  userIds.push(data.id);
  return { token, userId: data.id, orgId: data.activeOrg?.id ?? null };
}

type Body = { data?: unknown; error?: { code?: string; details?: unknown }; code?: string };
async function call(s: Session, method: 'GET' | 'PUT' | 'POST' | 'DELETE', url: string, payload?: unknown) {
  const res = await app.inject({ method, url, headers: { authorization: `Bearer ${s.token}` }, ...(payload === undefined ? {} : { payload: payload as object }) });
  responses.push(`${res.statusCode} ${JSON.stringify(res.headers)} ${res.body}`);
  return { status: res.statusCode, body: (res.body ? res.json() : null) as Body | null };
}
const codeOf = (r: Awaited<ReturnType<typeof call>>) => r.body?.error?.code ?? r.body?.code;
const data = <T>(r: Awaited<ReturnType<typeof call>>) => r.body!.data as T;

let admin: Session;

beforeAll(async () => {
  const capture = (sink: string[], write: typeof process.stdout.write) =>
    ((chunk: unknown, ...rest: unknown[]) => {
      sink.push(String(chunk));
      return (write as (...a: unknown[]) => boolean)(chunk, ...rest);
    }) as typeof process.stdout.write;
  process.stdout.write = capture(logs, originalWrites.out);
  process.stderr.write = capture(logs, originalWrites.err);
  app = await createApp();
  await app.init();
  await app.getHttpAdapter().getInstance().ready();
  prisma = app.get(PrismaService);
  fake = new FakeBrave([USER_KEY, SYSTEM_KEY]);
  // The real Brave adapter, over the fake endpoint instead of the network.
  Object.assign(app.get(BraveSearchProvider, { strict: false }), { http: fake });
  admin = await login('ws-admin', 'admin');
  // A known starting point: the defaults, the deployment key not shared until a test says so.
  expect((await call(admin, 'PUT', '/api/web-search/admin', { enabled: true, order: ['brave'], shareDeploymentKey: false, allowUserKeys: true, limits: { perRun: 30, perUserPerDay: 300 }, providers: { brave: { enabled: true, costPerCallUsd: null } } })).status).toBe(200);
}, 120_000);

afterAll(async () => {
  process.stdout.write = originalWrites.out;
  process.stderr.write = originalWrites.err;
  try {
    await call(admin, 'DELETE', '/api/service-credentials/admin/web_search/brave');
    await call(admin, 'PUT', '/api/web-search/admin', { enabled: true, order: ['brave'], shareDeploymentKey: true, allowUserKeys: true, limits: { perRun: 30, perUserPerDay: 300 }, providers: { brave: { enabled: true, costPerCallUsd: null } } });
    await prisma?.webSearchUsage.deleteMany({ where: { userId: { in: userIds } } });
  } finally {
    await app?.close();
    if (savedKey === undefined) delete process.env.SECRETS_ENCRYPTION_KEY;
    else process.env.SECRETS_ENCRYPTION_KEY = savedKey;
  }
});

describe('permissions', () => {
  it('a viewer reads the status but cannot search; a contributor cannot reach the admin routes', async () => {
    const viewer = await login('ws-viewer', 'viewer');
    const contributor = await login('ws-contrib');
    expect((await call(viewer, 'GET', '/api/web-search/status')).status).toBe(200);
    expect((await call(viewer, 'GET', '/api/web-search/providers')).status).toBe(200);
    expect((await call(viewer, 'POST', '/api/web-search/search', { query: 'x' })).status).toBe(403);
    expect((await call(contributor, 'GET', '/api/web-search/admin')).status).toBe(403);
    expect((await call(contributor, 'PUT', '/api/web-search/admin', { enabled: false })).status).toBe(403);
    expect((await call(contributor, 'GET', '/api/web-search/admin/usage')).status).toBe(403);
    expect((await call(contributor, 'POST', '/api/web-search/search', { query: '' })).status).toBe(400);
    expect((await call(contributor, 'POST', '/api/web-search/search', { query: 'x', count: 99 })).status).toBe(400);
  });
});

describe('the tiers, a search and the usage', () => {
  it('no key: off with the reason; the search answers NOT_CONFIGURED; forUser is null', async () => {
    const s = await login('ws-nokey');
    expect(data(await call(s, 'GET', '/api/web-search/status'))).toEqual({ enabled: false, reason: 'no_key', provider: null, today: { calls: 0, limit: 300, remaining: 300 }, perRunLimit: 30 });
    const r = await call(s, 'POST', '/api/web-search/search', { query: 'example widgets' });
    expect([r.status, codeOf(r)]).toEqual([409, 'WEB_SEARCH_NOT_CONFIGURED']);
    expect(await app.get(WebSearchService, { strict: false }).forUser(s.userId, s.orgId)).toBeNull();
  });

  it("the user's own key: a search through Brave, counted in the usage table", async () => {
    const s = await login('ws-own');
    expect((await call(s, 'PUT', '/api/service-credentials/web_search/brave', { value: USER_KEY })).status).toBe(204);
    expect(data(await call(s, 'GET', '/api/web-search/status'))).toMatchObject({ enabled: true, reason: null, provider: { id: 'brave', label: 'Brave Search', tier: 'user' } });
    const providers = data<{ id: string; keyTier: string | null; needsKey: boolean; estimatedCostPerCallUsd: number }[]>(await call(s, 'GET', '/api/web-search/providers'));
    expect(providers.find((p) => p.id === 'brave')).toMatchObject({ keyTier: 'user', needsKey: true, estimatedCostPerCallUsd: 0.005 });

    const before = fake.requests.length;
    const r = await call(s, 'POST', '/api/web-search/search', { query: 'example widgets', count: 2, freshness: 'month', site: 'docs.example.test' });
    expect(r.status).toBe(200);
    expect(data(r)).toEqual({ provider: 'brave', answer: null, hits: [{ title: 'Example widgets & parts', url: 'https://docs.example.test/widgets', snippet: 'An invented page about widgets.', publishedAt: '2026-10-01T00:00:00' }] });
    expect(fake.requests.slice(before)).toEqual([expect.objectContaining({ query: { q: 'example widgets site:docs.example.test', count: '2', freshness: 'pm' }, tokenPresent: true })]);

    const rows = await prisma.webSearchUsage.findMany({ where: { userId: s.userId } });
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ provider: 'brave', calls: 1, failures: 0 });
    expect(Number(rows[0]!.estimatedCostUsd)).toBeCloseTo(0.005);
    expect(data(await call(s, 'GET', '/api/web-search/status'))).toMatchObject({ today: { calls: 1, limit: 300, remaining: 299 } });

    // The provider refuses: a closed code, counted as a failure, never the provider's text.
    fake.stub({ status: 401, body: { error: { code: 'SUBSCRIPTION_TOKEN_INVALID', detail: 'invented provider text' } } });
    const refused = await call(s, 'POST', '/api/web-search/search', { query: 'example widgets' });
    expect([refused.status, codeOf(refused)]).toEqual([502, 'WEB_SEARCH_AUTH_REFUSED']);
    expect(JSON.stringify(refused.body)).not.toContain('invented provider text');
    expect(await prisma.webSearchUsage.findFirst({ where: { userId: s.userId } })).toMatchObject({ calls: 2, failures: 1 });

    // The port the agent gets (E50.7).
    const port = await app.get(WebSearchService, { strict: false }).forUser(s.userId, s.orgId);
    expect((await port!.search({ query: 'example widgets', count: 1, freshness: null, site: null, signal: new AbortController().signal })).provider).toBe('brave');
  });

  it("the deployment's key is used only while the administrator shares it", async () => {
    const s = await login('ws-shared');
    expect((await call(admin, 'PUT', '/api/service-credentials/admin/web_search/brave', { value: SYSTEM_KEY })).status).toBe(204);
    expect(data(await call(s, 'GET', '/api/web-search/status'))).toMatchObject({ enabled: false, reason: 'no_key' });
    expect((await call(admin, 'PUT', '/api/web-search/admin', { shareDeploymentKey: true })).status).toBe(200);
    expect(data(await call(s, 'GET', '/api/web-search/status'))).toMatchObject({ enabled: true, provider: { id: 'brave', tier: 'system' } });
    expect((await call(s, 'POST', '/api/web-search/search', { query: 'example widgets' })).status).toBe(200);
  });

  it('the per-day limit: reached gives LIMIT_REACHED; null is unlimited', async () => {
    const s = await login('ws-limit');
    expect((await call(s, 'PUT', '/api/service-credentials/web_search/brave', { value: USER_KEY })).status).toBe(204);
    expect((await call(admin, 'PUT', '/api/web-search/admin', { limits: { perUserPerDay: 1 } })).status).toBe(200);
    expect((await call(s, 'POST', '/api/web-search/search', { query: 'example widgets' })).status).toBe(200);
    const r = await call(s, 'POST', '/api/web-search/search', { query: 'example widgets' });
    expect([r.status, codeOf(r)]).toEqual([429, 'WEB_SEARCH_LIMIT_REACHED']);
    expect(data(await call(s, 'GET', '/api/web-search/status'))).toMatchObject({ today: { calls: 1, limit: 1, remaining: 0 } });
    expect((await call(admin, 'PUT', '/api/web-search/admin', { limits: { perUserPerDay: null } })).status).toBe(200);
    expect((await call(s, 'POST', '/api/web-search/search', { query: 'example widgets' })).status).toBe(200);
    expect(data(await call(s, 'GET', '/api/web-search/status'))).toMatchObject({ today: { calls: 2, limit: null, remaining: null } });
    expect((await call(admin, 'PUT', '/api/web-search/admin', { limits: { perUserPerDay: 300 } })).status).toBe(200);
  });

  it('the route allows 10 searches a minute', async () => {
    const s = await login('ws-rate');
    expect((await call(s, 'PUT', '/api/service-credentials/web_search/brave', { value: USER_KEY })).status).toBe(204);
    for (let i = 0; i < 10; i++) expect((await call(s, 'POST', '/api/web-search/search', { query: 'example widgets' })).status).toBe(200);
    const r = await call(s, 'POST', '/api/web-search/search', { query: 'example widgets' });
    expect([r.status, codeOf(r)]).toEqual([429, 'WEB_SEARCH_TEST_RATE_LIMITED']);
  });

  it('the user switches it off for themselves', async () => {
    const s = await login('ws-off');
    expect((await call(s, 'PUT', '/api/service-credentials/web_search/brave', { value: USER_KEY })).status).toBe(204);
    const res = await app.inject({ method: 'PATCH', url: '/api/user-settings', headers: { authorization: `Bearer ${s.token}` }, payload: { webSearch: { enabled: false } } });
    expect(res.statusCode).toBeLessThan(300);
    expect(data(await call(s, 'GET', '/api/web-search/status'))).toMatchObject({ enabled: false, reason: 'disabled_by_you' });
  });
});

describe('the administrator', () => {
  it('reads and changes the settings (audited), reads the usage by day and provider, and the egress list shows the provider', async () => {
    const v = data<{ installed: { id: string; hosts: string[]; defaultEstimatedCostPerCallUsd: number }[]; providers: Record<string, unknown> }>(await call(admin, 'GET', '/api/web-search/admin'));
    expect(v.installed).toEqual([{ id: 'brave', label: 'Brave Search', credential: 'api_key', hosts: ['api.search.brave.com'], defaultEstimatedCostPerCallUsd: 0.005 }]);
    const saved = await call(admin, 'PUT', '/api/web-search/admin', { providers: { brave: { costPerCallUsd: 0.004 } } });
    expect(data<{ providers: Record<string, unknown> }>(saved).providers.brave).toEqual({ enabled: true, costPerCallUsd: 0.004, baseUrl: null });
    expect((await call(admin, 'PUT', '/api/web-search/admin', { limits: { perRun: -1 } })).status).toBe(400);
    expect(await prisma.auditEvent.count({ where: { actorUserId: admin.userId, action: 'web_search.settings_saved' } })).toBeGreaterThan(0);

    const usage = data<{ day: string; provider: string; calls: number; failures: number; estimatedCostUsd: number }[]>(await call(admin, 'GET', '/api/web-search/admin/usage?days=7'));
    const today = new Date().toISOString().slice(0, 10);
    expect(usage.find((u) => u.day === today && u.provider === 'brave')).toMatchObject({ calls: expect.any(Number), failures: expect.any(Number) });
    expect(Object.keys(usage[0]!).sort()).toEqual(['calls', 'day', 'estimatedCostUsd', 'failures', 'provider']);

    const contributor = app.get(EgressRegistry, { strict: false }).list().find((c) => c.id === 'web_search')!;
    expect(await contributor.describe()).toEqual([expect.objectContaining({ id: 'web_search.brave', enabled: true, required: false, hosts: ['api.search.brave.com'], degradation: 'The agent searches in the browser instead' })]);
  });

  it('switched off by the administrator: off for everyone, with the reason', async () => {
    const s = await login('ws-admin-off');
    expect((await call(s, 'PUT', '/api/service-credentials/web_search/brave', { value: USER_KEY })).status).toBe(204);
    expect((await call(admin, 'PUT', '/api/web-search/admin', { enabled: false })).status).toBe(200);
    expect(data(await call(s, 'GET', '/api/web-search/status'))).toMatchObject({ enabled: false, reason: 'disabled_by_admin' });
    expect((await call(admin, 'PUT', '/api/web-search/admin', { enabled: true })).status).toBe(200);
  });
});

describe('the marker scan', () => {
  it('no key in a response, an audit row, a log line or a usage row', async () => {
    const audits = await prisma.auditEvent.findMany({ where: { actorUserId: { in: userIds } } });
    const usage = await prisma.webSearchUsage.findMany({ where: { userId: { in: userIds } } });
    expect(responses.length).toBeGreaterThan(10);
    for (const [what, text] of [
      ['responses', responses.join('\n')],
      ['audit rows', JSON.stringify(audits)],
      ['logs', logs.join('')],
      ['usage rows', JSON.stringify(usage)],
      ['fake requests', JSON.stringify(fake.requests)],
    ] as const) {
      expect({ what, leaked: text.includes(MARKER) }).toEqual({ what, leaked: false });
    }
  });
});
