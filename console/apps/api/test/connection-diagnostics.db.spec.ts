// Diagnostics of connections against a real database, the FAKE PROVIDERS and an in-process fake MCP server (E50.10, #980): a Google,
// a Microsoft and an MCP connection each get a staged report through the fallback (today's probes), stages in order and the rest
// skipped after a failure; the history keeps 20 and is deleted with the connection and with the user; the summary; ownership (404),
// the rate limit, the daily health job's report, a provider's own `Diagnosable` whose refused values are dropped; and a seeded-marker
// scan of every response and every stored report for a token, an account email and a mail subject. No real provider is called.
import { randomUUID } from 'node:crypto';
import type { NestFastifyApplication } from '@nestjs/platform-fastify';

import { ConnectionApps } from '../src/connections/connection-apps.service';
import { ConnectionDiagnosticsService } from '../src/connections/connection-diagnostics.service';
import { ConnectionProviderRegistry } from '../src/connections/connection-provider.registry';
import { ConnectionsHealthHandler } from '../src/connections/connections.jobs';
import type { Capability } from '../src/connections/connections.constants';
import { DiagnosticsRegistry } from '../src/diagnostics/diagnostics.registry';
import type { DiagnosticStage } from '../src/diagnostics/diagnostic-report';
import { createApp } from '../src/main';
import { PrismaService } from '../src/prisma/prisma.service';
import { FakeConnectionProvider, type FakeAccount } from './support/fake-connection-provider';
import { FakeMcpServer } from './support/fake-mcp-server';

const savedKey = process.env.SECRETS_ENCRYPTION_KEY;
process.env.SECRETS_ENCRYPTION_KEY ||= Buffer.alloc(32, 7).toString('base64');
const stamp = `${Date.now()}`;
const APP_SECRET = `MARKER-app-secret-${randomUUID()}`;
const BEARER = `MARKER-bearer-${randomUUID()}`;
const SUBJECT = `MARKER subject Quarterly invoice ${randomUUID()}`;

let app: NestFastifyApplication;
let prisma: PrismaService;
let google: FakeConnectionProvider;
let microsoft: FakeConnectionProvider;
let service: ConnectionDiagnosticsService;
let admin: Session;
const responses: string[] = [];
const servers: FakeMcpServer[] = [];
const userIds: string[] = [];

interface Session {
  token: string;
  userId: string;
}
interface Report {
  id: string;
  target: { kind: string; id: string };
  trigger: string;
  overall: string;
  startedAt: string;
  finishedAt: string;
  stages: DiagnosticStage[];
}

async function login(name: string, role: 'contributor' | 'admin' = 'contributor'): Promise<Session> {
  const res = await app.inject({ method: 'POST', url: '/api/auth/test/login', payload: { email: `${name}-${stamp}@example.test`, role } });
  const token = new URL(String(res.headers.location)).searchParams.get('token')!;
  const me = await app.inject({ method: 'GET', url: '/api/auth/me', headers: { authorization: `Bearer ${token}` } });
  const userId = me.json<{ data: { id: string } }>().data.id;
  userIds.push(userId);
  return { token, userId };
}

async function call<T = unknown>(s: Session, method: 'GET' | 'POST' | 'PUT' | 'DELETE', url: string, payload?: unknown) {
  const res = await app.inject({ method, url, headers: { authorization: `Bearer ${s.token}` }, ...(payload === undefined ? {} : { payload: payload as object }) });
  responses.push(`${res.statusCode} ${JSON.stringify(res.headers)} ${res.body}`);
  const body = res.body ? (res.json() as { data?: T; error?: { code?: string }; code?: string }) : {};
  return { statusCode: res.statusCode, code: body.error?.code ?? body.code ?? '', data: body.data as T };
}

const A: FakeAccount = { accountId: 'acct-diag-a', email: `person.a.${stamp}@example.test`, name: 'Person A' };

/** Connects an account through the real flow (authorize, consent at the fake, callback in the same browser). */
async function connected(name: string, fake: FakeConnectionProvider, capabilities: Capability[] = ['mail_read', 'calendar_read']): Promise<{ s: Session; id: string }> {
  const s = await login(name);
  const start = await app.inject({ method: 'POST', url: '/api/connections/authorize', headers: { authorization: `Bearer ${s.token}` }, payload: { provider: fake.id, capabilities } });
  expect(start.statusCode).toBe(200);
  const raw = Array.isArray(start.headers['set-cookie']) ? String(start.headers['set-cookie'][0]) : String(start.headers['set-cookie']);
  const m = /^(hx_conn_[a-f0-9]+)=([^;]*)/.exec(raw)!;
  const { code, state } = fake.consent(start.json<{ data: { authorizeUrl: string } }>().data.authorizeUrl, A);
  const cb = await app.inject({ method: 'GET', url: `/api/connections/callback/${fake.id}?${new URLSearchParams({ code, state })}`, headers: { cookie: `${m[1]}=${m[2]}` } });
  const location = String(cb.headers.location);
  expect(location).toContain('connect=connected');
  return { s, id: new URL(location, 'http://console.example.test').searchParams.get('connection')! };
}

const diagnose = (s: Session, id: string) => call<Report>(s, 'POST', `/api/connections/${id}/diagnose`);
const shape = (r: Report) => r.stages.map((x) => [x.id, x.status, x.code]);

beforeAll(async () => {
  app = await createApp();
  await app.init();
  await app.getHttpAdapter().getInstance().ready();
  prisma = app.get(PrismaService);
  service = app.get(ConnectionDiagnosticsService, { strict: false });
  google = new FakeConnectionProvider('google');
  microsoft = new FakeConnectionProvider('microsoft');
  const registry = app.get(ConnectionProviderRegistry, { strict: false });
  registry.register(google);
  registry.register(microsoft);
  admin = await login('diag-admin', 'admin');
  for (const [p, id] of [['google', 'fake-google-client'], ['microsoft', 'fake-microsoft-client']] as const) {
    expect((await call(admin, 'PUT', `/api/connections/admin/apps/${p}`, { enabled: true, clientId: id, clientSecret: APP_SECRET })).statusCode).toBe(200);
  }
  expect((await call(admin, 'PUT', '/api/connections/admin/mcp', { enabled: true, allowedHosts: [], blockedHosts: [] })).statusCode).toBe(200);
  app.get(ConnectionApps, { strict: false }).invalidate();
});

afterAll(async () => {
  for (const p of ['google', 'microsoft']) await call(admin, 'DELETE', `/api/connections/admin/apps/${p}`);
  await call(admin, 'PUT', '/api/connections/admin/mcp', { enabled: false, allowedHosts: [], blockedHosts: [] });
  await prisma.connectionDiagnostic.deleteMany({ where: { userId: { in: userIds } } });
  await prisma.connection.deleteMany({ where: { user: { email: { contains: stamp } } } });
  await Promise.all(servers.map((s) => s.stop()));
  await app?.close();
  if (savedKey === undefined) delete process.env.SECRETS_ENCRYPTION_KEY;
  else process.env.SECRETS_ENCRYPTION_KEY = savedKey;
});

describe('a report through the fallback', () => {
  it('a Google connection: status, installed, sign-in, one stage per capability, the time; stored and returned', async () => {
    const { s, id } = await connected('diag-google', google, ['mail_read', 'calendar_read']);
    const r = await diagnose(s, id);
    expect(r.statusCode).toBe(200);
    expect(r.data).toMatchObject({ target: { kind: 'connection', id }, trigger: 'owner', overall: 'pass' });
    expect(shape(r.data)).toEqual([
      ['status', 'pass', null],
      ['provider_installed', 'pass', null],
      ['sign_in', 'pass', null],
      ['capability:mail_read', 'pass', null],
      ['capability:calendar_read', 'pass', null],
      ['latency', 'pass', null],
    ]);
    expect(r.data.stages.every((x) => typeof x.ms === 'number')).toBe(true);
    const history = await call<Report[]>(s, 'GET', `/api/connections/${id}/diagnostics`);
    expect(history.data.map((h) => h.id)).toEqual([r.data.id]);
    // Nothing changed on the connection.
    expect((await prisma.connection.findUniqueOrThrow({ where: { id } })).status).toBe('active');
  });

  it('a Microsoft connection whose mail probe is refused: that capability fails with its code, the other still runs', async () => {
    const { s, id } = await connected('diag-microsoft', microsoft, ['mail_read', 'calendar_read']);
    microsoft.probeFails = { mail_read: 'FORBIDDEN' };
    try {
      const r = await diagnose(s, id);
      expect(r.data.overall).toBe('fail');
      expect(shape(r.data)).toEqual([
        ['status', 'pass', null],
        ['provider_installed', 'pass', null],
        ['sign_in', 'pass', null],
        ['capability:mail_read', 'fail', 'FORBIDDEN'],
        ['capability:calendar_read', 'pass', null],
        ['latency', 'pass', null],
      ]);
      expect(r.data.stages[3]!.remedy).toBe('FORBIDDEN');
      // A code outside the closed list is UNKNOWN.
      microsoft.probeFails = { mail_read: 'Mailbox of person.a@example.test is gone' };
      expect((await diagnose(s, id)).data.stages[3]!.code).toBe('UNKNOWN');
    } finally {
      microsoft.probeFails = {};
    }
  });

  it('a revoked grant: the sign-in fails with its reason, the capabilities are skipped; the next report fails at the status', async () => {
    const { s, id } = await connected('diag-revoked', google, ['mail_read']);
    await prisma.connection.update({ where: { id }, data: { accessExpiresAt: new Date(Date.now() - 1000) } });
    google.revokeAllGrants();
    const first = await diagnose(s, id);
    expect(shape(first.data)).toEqual([
      ['status', 'pass', null],
      ['provider_installed', 'pass', null],
      ['sign_in', 'fail', 'CONNECTION_NEEDS_RECONNECT'],
      ['capability:mail_read', 'skipped', null],
      ['latency', 'pass', null],
    ]);
    expect(first.data.stages[2]!.remedy).toBe('GRANT_REVOKED');
    const second = await diagnose(s, id);
    expect(shape(second.data)).toEqual([
      ['status', 'fail', 'CONNECTION_NEEDS_RECONNECT'],
      ['provider_installed', 'skipped', null],
      ['sign_in', 'skipped', null],
      ['capability:mail_read', 'skipped', null],
      ['latency', 'pass', null],
    ]);
    expect(second.data.stages[0]!.remedy).toBe('GRANT_REVOKED');
  });

  it('a paused connection warns at the status and still checks; a provider switched off fails as installed', async () => {
    const { s, id } = await connected('diag-paused', google, ['mail_read']);
    expect((await call(s, 'POST', `/api/connections/${id}/pause`)).statusCode).toBe(200);
    const paused = await diagnose(s, id);
    expect(paused.data.overall).toBe('warn');
    expect(paused.data.stages[0]).toMatchObject({ id: 'status', status: 'warn', code: 'CONNECTION_PAUSED', remedy: 'CONNECTION_PAUSED' });
    expect(paused.data.stages.find((x) => x.id === 'capability:mail_read')!.status).toBe('pass');
    expect((await prisma.connection.findUniqueOrThrow({ where: { id } })).status).toBe('paused');
    await call(admin, 'PUT', '/api/connections/admin/apps/google', { enabled: false });
    app.get(ConnectionApps, { strict: false }).invalidate();
    try {
      const off = await diagnose(s, id);
      expect(shape(off.data).slice(1, 3)).toEqual([
        ['provider_installed', 'fail', 'PROVIDER_DISABLED'],
        ['sign_in', 'skipped', null],
      ]);
    } finally {
      await call(admin, 'PUT', '/api/connections/admin/apps/google', { enabled: true });
      app.get(ConnectionApps, { strict: false }).invalidate();
    }
  });

  it('an MCP server: it answers and lists its tools (a count, never their names); a refused sign-in fails as AUTH_REFUSED', async () => {
    const s = await login('diag-mcp');
    const srv = await new FakeMcpServer({ bearer: BEARER, tools: [{ name: 'search_notes', description: 'Search the notes.', inputSchema: { type: 'object', properties: {} } }, { name: 'add_note', description: 'Adds a note.', inputSchema: { type: 'object', properties: {} } }] }).start();
    servers.push(srv);
    const added = await call<{ connection: { id: string } }>(s, 'POST', '/api/connections/mcp', { url: srv.url, label: 'Notes', auth: { kind: 'bearer', token: BEARER } });
    expect(added.statusCode).toBe(200);
    const id = added.data.connection.id;
    const r = await diagnose(s, id);
    expect(shape(r.data)).toEqual([
      ['status', 'pass', null],
      ['provider_installed', 'pass', null],
      ['server', 'pass', null],
      ['latency', 'pass', null],
    ]);
    expect(r.data.stages[2]!.data).toEqual({ tools: 2 });
    expect(JSON.stringify(r.data)).not.toContain('search_notes');

    // The server stops accepting the token.
    (srv as unknown as { opts: { bearer?: string } }).opts.bearer = 'another-token';
    const refused = await diagnose(s, id);
    expect(refused.data.stages[2]).toMatchObject({ id: 'server', status: 'fail', code: 'AUTH_REFUSED' });

    expect((await call(admin, 'PUT', '/api/connections/admin/mcp', { enabled: false })).statusCode).toBe(200);
    app.get(ConnectionApps, { strict: false }).invalidate();
    try {
      const off = await diagnose(s, id);
      expect(shape(off.data).slice(1, 3)).toEqual([
        ['provider_installed', 'fail', 'PROVIDER_DISABLED'],
        ['server', 'skipped', null],
      ]);
    } finally {
      await call(admin, 'PUT', '/api/connections/admin/mcp', { enabled: true });
      app.get(ConnectionApps, { strict: false }).invalidate();
    }
  });
});

describe('the history', () => {
  it('keeps the last 20 per connection, reads 5 by default and at most 20, and summarises each connection in one entry', async () => {
    const { s, id } = await connected('diag-history', google, ['mail_read']);
    const other = await connected('diag-history-other', microsoft, ['mail_read']);
    const row = await prisma.connection.findUniqueOrThrow({ where: { id } });
    for (let i = 0; i < 22; i++) await service.diagnoseRow(row, 'owner');
    expect(await prisma.connectionDiagnostic.count({ where: { targetKind: 'connection', targetId: id } })).toBe(20);
    expect((await call<Report[]>(s, 'GET', `/api/connections/${id}/diagnostics`)).data).toHaveLength(5);
    const all = (await call<Report[]>(s, 'GET', `/api/connections/${id}/diagnostics?limit=20`)).data;
    expect(all).toHaveLength(20);
    expect([...all].sort((a, b) => b.finishedAt.localeCompare(a.finishedAt)).map((x) => x.id)).toEqual(all.map((x) => x.id));
    expect((await call(s, 'GET', `/api/connections/${id}/diagnostics?limit=21`)).statusCode).toBe(400);
    expect((await call(s, 'GET', `/api/connections/${id}/diagnostics?limit=abc`)).statusCode).toBe(400);

    const summary = await call<{ targetId: string; overall: string; at: string }[]>(s, 'GET', '/api/connections/diagnostics/summary');
    expect(summary.statusCode).toBe(200);
    expect(summary.data).toEqual([{ targetId: id, overall: 'pass', at: all[0]!.finishedAt }]);
    // Another user's connection is not in it.
    await diagnose(other.s, other.id);
    expect((await call<unknown[]>(s, 'GET', '/api/connections/diagnostics/summary')).data).toHaveLength(1);
  });

  it('is deleted with the connection', async () => {
    const { s, id } = await connected('diag-remove', google, ['mail_read']);
    await diagnose(s, id);
    expect(await prisma.connectionDiagnostic.count({ where: { targetId: id } })).toBe(1);
    expect((await call(s, 'DELETE', `/api/connections/${id}`)).statusCode).toBe(200);
    expect(await prisma.connectionDiagnostic.count({ where: { targetId: id } })).toBe(0);
  });

  it('is deleted with an MCP connection', async () => {
    const s = await login('diag-remove-mcp');
    const srv = await new FakeMcpServer({ tools: [] }).start();
    servers.push(srv);
    const id = (await call<{ connection: { id: string } }>(s, 'POST', '/api/connections/mcp', { url: srv.url, label: 'Empty', auth: { kind: 'none' } })).data.connection.id;
    await diagnose(s, id);
    expect((await call(s, 'DELETE', `/api/connections/${id}`)).statusCode).toBe(200);
    expect(await prisma.connectionDiagnostic.count({ where: { targetId: id } })).toBe(0);
  });

  it('is deleted with the user', async () => {
    const { s, id } = await connected('diag-delete-user', google, ['mail_read']);
    await diagnose(s, id);
    expect(await prisma.connectionDiagnostic.count({ where: { userId: s.userId } })).toBe(1);
    await prisma.user.delete({ where: { id: s.userId } });
    expect(await prisma.connectionDiagnostic.count({ where: { targetId: id } })).toBe(0);
  });
});

describe('who may run and read a report', () => {
  it("another user's connection is a 404 on every route, and an unauthenticated caller is refused", async () => {
    const owner = await connected('diag-own-a', google, ['mail_read']);
    const other = await login('diag-own-b');
    await diagnose(owner.s, owner.id);
    expect((await diagnose(other, owner.id)).statusCode).toBe(404);
    expect((await call(other, 'GET', `/api/connections/${owner.id}/diagnostics`)).statusCode).toBe(404);
    expect((await call(admin, 'GET', `/api/connections/${owner.id}/diagnostics`)).statusCode).toBe(404);
    expect((await call<unknown[]>(other, 'GET', '/api/connections/diagnostics/summary')).data).toEqual([]);
    expect((await app.inject({ method: 'POST', url: `/api/connections/${owner.id}/diagnose` })).statusCode).toBe(401);
    expect((await app.inject({ method: 'GET', url: '/api/connections/diagnostics/summary' })).statusCode).toBe(401);
    expect((await call(owner.s, 'POST', '/api/connections/not-a-uuid/diagnose')).statusCode).toBe(400);
  });

  it('at most 6 a minute per connection', async () => {
    const { s, id } = await connected('diag-rate', google, ['mail_read']);
    for (let i = 0; i < 6; i++) expect((await diagnose(s, id)).statusCode).toBe(200);
    const seventh = await diagnose(s, id);
    expect([seventh.statusCode, seventh.code]).toEqual([429, 'DIAGNOSTICS_RATE_LIMITED']);
  });
});

describe('the daily health job', () => {
  it('stores a report (trigger health_job) for a connection whose refresh failed, without asking the provider again', async () => {
    const { s, id } = await connected('diag-health', google, ['mail_read']);
    await prisma.connection.update({ where: { id }, data: { lastRefreshAt: null, lastUsedAt: null } });
    google.failRefresh = { kind: 'unavailable', times: 1 };
    const probes = google.probes.length;
    try {
      await app.get(ConnectionsHealthHandler, { strict: false }).process();
    } finally {
      google.failRefresh = null;
    }
    const [r] = (await call<Report[]>(s, 'GET', `/api/connections/${id}/diagnostics`)).data;
    expect(r).toMatchObject({ trigger: 'health_job', overall: 'fail' });
    expect(shape(r!)).toEqual([
      ['status', 'warn', 'UNAVAILABLE'],
      ['provider_installed', 'pass', null],
      ['sign_in', 'fail', 'UNAVAILABLE'],
      ['capability:mail_read', 'skipped', null],
      ['latency', 'pass', null],
    ]);
    expect(google.probes.length).toBe(probes);
  });
});

describe("a provider's own diagnostic", () => {
  it('replaces the fallback; a value that is an address, a subject or a token is dropped, a code outside its list is UNKNOWN', async () => {
    const { s, id } = await connected('diag-own', microsoft, ['mail_read']);
    let calls = 0;
    app.get(DiagnosticsRegistry, { strict: false }).register('connection', 'microsoft', {
      codes: ['PERMISSION_MISSING'],
      diagnose: async (target: { accessToken(): Promise<string> }): Promise<DiagnosticStage[]> => {
        calls += 1;
        const token = await target.accessToken();
        return [
          { id: 'sign_in', status: 'pass', code: null, remedy: null, ms: 1, data: { account: A.email, token } },
          { id: 'permissions', status: 'fail', code: 'PERMISSION_MISSING', remedy: null, ms: 1, data: { missing: 1, permission: 'Mail.Read', subject: SUBJECT } },
          { id: 'capability:mail_read', status: 'fail', code: 'NOT_IN_ITS_LIST', remedy: null, ms: 1 },
        ];
      },
    });
    const r = await diagnose(s, id);
    expect(calls).toBe(1);
    expect(r.data.stages.map((x) => [x.id, x.status, x.code, x.data ?? null])).toEqual([
      ['status', 'pass', null, null],
      ['provider_installed', 'pass', null, null],
      ['sign_in', 'pass', null, null],
      ['permissions', 'fail', 'PERMISSION_MISSING', { missing: 1, permission: 'Mail.Read' }],
      ['capability:mail_read', 'fail', 'UNKNOWN', null],
      ['latency', 'pass', null, null],
    ]);
  });
});

describe('the marker scan', () => {
  it('no response and no stored report holds a token, an account email, the app secret, the bearer token or a mail subject', async () => {
    const markers = [APP_SECRET, BEARER, SUBJECT, A.email, ...google.issued, ...microsoft.issued];
    const rows = JSON.stringify(await prisma.connectionDiagnostic.findMany({ where: { userId: { in: userIds } } }));
    expect(rows.length).toBeGreaterThan(100);
    const diagnosticResponses = responses.filter((r) => /"stages"|"targetId"/.test(r));
    expect(diagnosticResponses.length).toBeGreaterThan(5);
    for (const m of markers) {
      expect([m, rows.includes(m)]).toEqual([m, false]);
      for (const r of diagnosticResponses) expect([m, r.includes(m)]).toEqual([m, false]);
    }
  });
});
