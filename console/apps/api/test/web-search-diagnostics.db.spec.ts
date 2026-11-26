// Web search diagnostics and the Doctor lines of connections, MCP and search, against a real database (E50.13, #983): the four routes
// and their permissions; a user's report and the deployment's through the real Brave adapter over the in-process fake of its endpoint
// (stored as `search_provider` reports, the user's with them as owner, the deployment's with none; the live query counted as one
// call); the rate limit; the six Doctor checks registered, run while no outbound request is made and no row is written; the egress
// entries; and a seeded-marker scan of every response and stored report (the key never appears).
import { randomUUID } from 'node:crypto';
import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import { DoctorCheckRegistry, EgressRegistry } from '@marinoscar/platform-api/doctor';

import { createApp } from '../src/main';
import { OutboundHttp } from '../src/oauth-client/outbound-http';
import { PrismaService } from '../src/prisma/prisma.service';
import { BraveSearchProvider } from '../src/web-search/providers/brave.provider';
import { FakeBrave } from '../src/web-search/testing/fake-brave';

const savedKey = process.env.SECRETS_ENCRYPTION_KEY;
process.env.SECRETS_ENCRYPTION_KEY ||= Buffer.alloc(32, 7).toString('base64');
const stamp = randomUUID().slice(0, 8);
const MARKER = `MARKER${randomUUID().replace(/-/g, '')}`;
const USER_KEY = `${MARKER}user`;
const SYSTEM_KEY = `${MARKER}system`;

let app: NestFastifyApplication;
let prisma: PrismaService;
let fake: FakeBrave;
let admin: Session;
const responses: string[] = [];
const userIds: string[] = [];

interface Session {
  token: string;
  userId: string;
}
type Role = 'contributor' | 'viewer' | 'admin';
interface Report {
  target: { kind: string; id: string };
  trigger: string;
  overall: string;
  stages: { id: string; status: string; code: string | null; remedy: string | null; data?: Record<string, unknown> }[];
}

async function login(name: string, role: Role = 'contributor'): Promise<Session> {
  const res = await app.inject({ method: 'POST', url: '/api/auth/test/login', payload: { email: `${name}-${stamp}@example.test`, role } });
  const token = new URL(String(res.headers.location)).searchParams.get('token')!;
  const me = await app.inject({ method: 'GET', url: '/api/auth/me', headers: { authorization: `Bearer ${token}` } });
  const userId = me.json<{ data: { id: string } }>().data.id;
  userIds.push(userId);
  return { token, userId };
}

async function call(s: Session, method: 'GET' | 'PUT' | 'POST' | 'DELETE', url: string, payload?: unknown) {
  const res = await app.inject({ method, url, headers: { authorization: `Bearer ${s.token}` }, ...(payload === undefined ? {} : { payload: payload as object }) });
  responses.push(`${res.statusCode} ${res.body}`);
  return { status: res.statusCode, body: (res.body ? res.json() : null) as { data?: unknown; error?: { code?: string }; code?: string } | null };
}
const data = <T>(r: Awaited<ReturnType<typeof call>>) => r.body!.data as T;
const codeOf = (r: Awaited<ReturnType<typeof call>>) => r.body?.error?.code ?? r.body?.code;
const brief = (r: Report) => r.stages.map((s) => `${s.id}:${s.status}${s.code ? `:${s.code}` : ''}`);

beforeAll(async () => {
  app = await createApp();
  await app.init();
  await app.getHttpAdapter().getInstance().ready();
  prisma = app.get(PrismaService);
  fake = new FakeBrave([USER_KEY, SYSTEM_KEY]);
  Object.assign(app.get(BraveSearchProvider, { strict: false }), { http: fake });
  admin = await login('wsd-admin', 'admin');
  expect((await call(admin, 'PUT', '/api/web-search/admin', { enabled: true, order: ['brave'], shareDeploymentKey: false, allowUserKeys: true, limits: { perRun: 30, perUserPerDay: 300 }, providers: { brave: { enabled: true, costPerCallUsd: null } } })).status).toBe(200);
}, 120_000);

afterAll(async () => {
  try {
    await call(admin, 'DELETE', '/api/service-credentials/admin/web_search/brave');
    await call(admin, 'PUT', '/api/web-search/admin', { shareDeploymentKey: true });
    await prisma?.webSearchUsage.deleteMany({ where: { userId: { in: userIds } } });
    await prisma?.connectionDiagnostic.deleteMany({ where: { targetKind: 'search_provider' } });
  } finally {
    await app?.close();
    if (savedKey === undefined) delete process.env.SECRETS_ENCRYPTION_KEY;
    else process.env.SECRETS_ENCRYPTION_KEY = savedKey;
  }
});

describe('permissions', () => {
  it('a viewer reads their reports but cannot run one; a contributor cannot reach the deployment routes; an unknown provider is a 404', async () => {
    const viewer = await login('wsd-viewer', 'viewer');
    const contributor = await login('wsd-contrib');
    expect((await call(viewer, 'GET', '/api/web-search/diagnostics')).status).toBe(200);
    expect((await call(viewer, 'POST', '/api/web-search/diagnose')).status).toBe(403);
    expect((await call(contributor, 'POST', '/api/web-search/admin/providers/brave/diagnose')).status).toBe(403);
    expect((await call(contributor, 'GET', '/api/web-search/admin/providers/brave/diagnostics')).status).toBe(403);
    expect((await call(viewer, 'GET', '/api/web-search/admin/providers/brave/diagnostics')).status).toBe(403);
    const unknown = await call(contributor, 'POST', '/api/web-search/diagnose?provider=nosuch');
    expect([unknown.status, codeOf(unknown)]).toEqual([404, 'WEB_SEARCH_PROVIDER_UNKNOWN']);
    expect((await call(admin, 'POST', '/api/web-search/admin/providers/nosuch/diagnose')).status).toBe(404);
    expect((await call(contributor, 'POST', '/api/web-search/diagnose?provider=Bad-Id')).status).toBe(400);
  });
});

describe('reports', () => {
  it("a user's report: no key, then their own key through the real adapter; stored as theirs; the live query is one call", async () => {
    const s = await login('wsd-user');
    const none = data<Report>(await call(s, 'POST', '/api/web-search/diagnose'));
    expect(none.target).toEqual({ kind: 'search_provider', id: 'brave' });
    expect(brief(none).slice(0, 2)).toEqual(['switches:pass', 'credential:fail:KEY_MISSING']);

    expect((await call(s, 'PUT', '/api/service-credentials/web_search/brave', { value: USER_KEY })).status).toBe(204);
    const before = fake.requests.length;
    const r = await call(s, 'POST', '/api/web-search/diagnose?provider=brave');
    expect(r.status).toBe(200);
    const report = data<Report>(r);
    expect(brief(report)).toEqual(['switches:pass', 'credential:pass', 'network:pass', 'live_query:pass', 'limits:pass', 'fetch:skipped']);
    expect(report).toMatchObject({ trigger: 'owner', overall: 'pass' });
    expect(report.stages[1]!.data).toEqual({ tier: 'user', binding: 'credential_store' });
    expect(fake.requests.slice(before)).toEqual([expect.objectContaining({ url: 'https://api.search.brave.com/', tokenPresent: false }), expect.objectContaining({ query: { q: 'weather', count: '1' }, tokenPresent: true })]);
    expect(await prisma.webSearchUsage.findFirst({ where: { userId: s.userId } })).toMatchObject({ provider: 'brave', calls: 1 });

    const rows = await prisma.connectionDiagnostic.findMany({ where: { targetKind: 'search_provider', userId: s.userId } });
    expect(rows).toHaveLength(2);
    const mine = data<Report[]>(await call(s, 'GET', '/api/web-search/diagnostics'));
    expect(mine.map((m) => m.overall)).toEqual(['pass', 'fail']);
    // Another user sees none of them.
    const other = await login('wsd-other');
    expect(data<Report[]>(await call(other, 'GET', '/api/web-search/diagnostics'))).toEqual([]);
  });

  it("the deployment's report uses the deployment key only, stored with no owner; a user is never told about an unshared key", async () => {
    const s = await login('wsd-unshared');
    expect((await call(admin, 'PUT', '/api/service-credentials/admin/web_search/brave', { value: SYSTEM_KEY })).status).toBe(204);
    const dep = data<Report>(await call(admin, 'POST', '/api/web-search/admin/providers/brave/diagnose'));
    expect(brief(dep)).toEqual(['switches:pass', 'credential:warn:DEPLOYMENT_KEY_NOT_SHARED', 'network:pass', 'live_query:pass', 'limits:pass', 'fetch:skipped']);
    expect(dep.trigger).toBe('admin');
    expect(await prisma.connectionDiagnostic.count({ where: { targetKind: 'search_provider', targetId: 'brave', userId: null } })).toBe(1);
    expect(data<Report[]>(await call(admin, 'GET', '/api/web-search/admin/providers/brave/diagnostics'))).toHaveLength(1);
    // The administrator's own reports list does not hold the deployment's.
    expect(data<Report[]>(await call(admin, 'GET', '/api/web-search/diagnostics'))).toEqual([]);

    const user = data<Report>(await call(s, 'POST', '/api/web-search/diagnose'));
    expect(user.stages[1]).toMatchObject({ status: 'fail', code: 'KEY_MISSING' });
    expect(JSON.stringify(user)).not.toMatch(/system|NOT_SHARED/);
  });

  it('at most 6 reports a minute for one provider', async () => {
    const s = await login('wsd-rate');
    for (let i = 0; i < 6; i++) expect((await call(s, 'POST', '/api/web-search/diagnose')).status).toBe(200);
    const r = await call(s, 'POST', '/api/web-search/diagnose');
    expect([r.status, codeOf(r)]).toEqual([429, 'DIAGNOSTICS_RATE_LIMITED']);
  });
});

describe('Doctor and the egress list', () => {
  const IDS = ['connections.google_app', 'connections.microsoft_app', 'connections.accounts', 'connections.health_job', 'connections.mcp', 'web_search.provider'];

  it('the six checks are registered and read stored state only: no outbound request, no row written', async () => {
    const registry = app.get(DoctorCheckRegistry, { strict: false });
    const checks = IDS.map((id) => registry.get(id));
    expect(checks.every(Boolean)).toBe(true);
    expect(checks.map((c) => c!.category)).toEqual(['connections', 'connections', 'connections', 'connections', 'connections', 'web_search']);

    const http = app.get(OutboundHttp, { strict: false });
    const send = jest.spyOn(http, 'send');
    const fetchSpy = jest.spyOn(globalThis, 'fetch');
    const fakeBefore = fake.requests.length;
    const counts = () => Promise.all([prisma.connectionDiagnostic.count(), prisma.auditEvent.count(), prisma.job.count(), prisma.webSearchUsage.count(), prisma.connection.count(), prisma.connectionMcpTool.count()]);
    const before = await counts();
    const outcomes = await Promise.all(checks.map((c) => c!.run()));
    expect(await counts()).toEqual(before);
    expect(send).not.toHaveBeenCalled();
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(fake.requests.length).toBe(fakeBefore);
    send.mockRestore();
    fetchSpy.mockRestore();

    for (const o of outcomes) expect(['pass', 'warn', 'fail', 'skip']).toContain(o.status);
    // The last deployment report of Brave warned (the key is not shared): the search line says so.
    expect(outcomes[5]).toMatchObject({ status: 'warn', data: expect.objectContaining({ provider: 'brave', deploymentKey: true, lastReport: 'warn' }) });
    const text = JSON.stringify(outcomes);
    expect(text).not.toContain(MARKER);
    expect(text).not.toMatch(/@example\.test/);
  });

  it('the egress list shows the hosts of each provider and server', async () => {
    const all = await Promise.all(app.get(EgressRegistry, { strict: false }).list().filter((c) => c.id === 'connections' || c.id === 'web_search').map((c) => c.describe()));
    const byId = Object.fromEntries(all.flat().map((d) => [d.id, d]));
    expect(byId['web_search.brave']).toMatchObject({ hosts: ['api.search.brave.com', 'example.com'], enabled: true });
    expect(byId['connections.google']!.hosts).toEqual(expect.arrayContaining(['oauth2.googleapis.com', 'gmail.googleapis.com']));
    expect(byId['connections.microsoft']!.hosts).toEqual(expect.arrayContaining(['graph.microsoft.com', 'login.microsoftonline.com']));
    expect(byId['connections.mcp']).toMatchObject({ id: 'connections.mcp', required: false });
  });
});

describe('the marker scan', () => {
  it('no key in a response or a stored report', async () => {
    const stored = await prisma.connectionDiagnostic.findMany({ where: { targetKind: 'search_provider' } });
    expect(responses.join('\n')).not.toContain(MARKER);
    expect(JSON.stringify(stored)).not.toContain(MARKER);
    expect(JSON.stringify(fake.requests)).not.toContain(MARKER);
  });
});
