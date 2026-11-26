// Google and Microsoft diagnostics inside the running API against a real database and the in-process fakes (E50.11, #981; #681):
// the real adapters over FakeGoogle and the fake Graph. A Google connection whose Drive API is switched off names the API in its
// report AND in `POST /test`; a revoked grant fails at `sign_in` with every capability skipped; a Microsoft account without a
// mailbox; the deployment's app tested by an administrator before anyone connects (and refused for everyone else), stored with no
// user; and a seeded-marker scan of every response and every stored report for the app secret, a token, an account address, a
// subject, Google's project number and the fake Graph's message marker. No real provider is called.
import { randomUUID } from 'node:crypto';
import type { NestFastifyApplication } from '@nestjs/platform-fastify';

import { ConnectionApps } from '../src/connections/connection-apps.service';
import { ConnectionAppDiagnostics } from '../src/connections/connection-app-diagnostics.service';
import { ConnectionProviderRegistry } from '../src/connections/connection-provider.registry';
import type { Capability } from '../src/connections/connections.constants';
import { GoogleConnectionAdapter } from '../src/connections/google/google.adapter';
import { FakeGoogle, type FakeGoogleAccount } from '../src/connections/google/testing';
import { MicrosoftConnectionAdapter } from '../src/connections/microsoft/microsoft.adapter';
import { FakeGraph, type FakeAccount } from '../src/connections/microsoft/testing/fake-graph';
import { DiagnosticsRegistry } from '../src/diagnostics/diagnostics.registry';
import type { DiagnosticStage } from '../src/diagnostics/diagnostic-report';
import { createApp } from '../src/main';
import { OAuthClientService } from '../src/oauth-client';
import { PrismaService } from '../src/prisma/prisma.service';

const savedKey = process.env.SECRETS_ENCRYPTION_KEY;
process.env.SECRETS_ENCRYPTION_KEY ||= Buffer.alloc(32, 7).toString('base64');
const stamp = `${Date.now()}`;
const APP_SECRET = `MARKER-app-secret-${randomUUID()}`;
const SUBJECT = `MARKER subject Quarterly invoice ${randomUUID()}`;

let app: NestFastifyApplication;
let prisma: PrismaService;
let google: FakeGoogle;
let graph: FakeGraph;
let admin: Session;
let saved: { google?: unknown; microsoft?: unknown } = {};
const responses: string[] = [];
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

async function call<T = unknown>(s: Session, method: 'GET' | 'POST' | 'PUT' | 'DELETE', url: string, payload?: unknown, headers: Record<string, string> = {}) {
  const res = await app.inject({ method, url, headers: { authorization: `Bearer ${s.token}`, ...headers }, ...(payload === undefined ? {} : { payload: payload as object }) });
  responses.push(`${res.statusCode} ${JSON.stringify(res.headers)} ${res.body}`);
  const body = res.body ? (res.json() as { data?: T; error?: { code?: string }; code?: string }) : {};
  return { statusCode: res.statusCode, code: body.error?.code ?? body.code ?? '', data: body.data as T, headers: res.headers };
}

const cookieOf = (setCookie: unknown): string => {
  const raw = Array.isArray(setCookie) ? String(setCookie[0]) : String(setCookie);
  const m = /^(hx_conn_[a-f0-9]+)=([^;]*)/.exec(raw)!;
  return `${m[1]}=${m[2]}`;
};

async function connect(s: Session, provider: 'google' | 'microsoft', capabilities: Capability[], consent: (url: string) => { code: string; state: string }): Promise<string> {
  const start = await call<{ authorizeUrl: string }>(s, 'POST', '/api/connections/authorize', { provider, capabilities });
  expect(start.statusCode).toBe(200);
  const { code, state } = consent(start.data.authorizeUrl);
  const cb = await app.inject({ method: 'GET', url: `/api/connections/callback/${provider}?${new URLSearchParams({ code, state })}`, headers: { cookie: cookieOf(start.headers['set-cookie']) } });
  const location = String(cb.headers.location);
  expect(location).toContain('connect=connected');
  return new URL(location, 'http://console.example.test').searchParams.get('connection')!;
}

const shape = (r: Report) => r.stages.map((x) => [x.id, x.status, x.code]);
const stage = (r: Report, id: string) => r.stages.find((x) => x.id === id)!;
const diagnose = (s: Session, id: string) => call<Report>(s, 'POST', `/api/connections/${id}/diagnose`);

beforeAll(async () => {
  app = await createApp();
  await app.init();
  await app.getHttpAdapter().getInstance().ready();
  prisma = app.get(PrismaService);
  google = new FakeGoogle();
  google.client = { id: '123456789012-fakeclient9q7z.apps.googleusercontent.com', secret: APP_SECRET };
  graph = new FakeGraph();
  graph.clientSecret = APP_SECRET;
  const adapters = app.get(ConnectionProviderRegistry, { strict: false });
  saved = { google: adapters.get('google'), microsoft: adapters.get('microsoft') };
  adapters.register(new GoogleConnectionAdapter(new OAuthClientService(google), google));
  adapters.register(new MicrosoftConnectionAdapter({ fetch: (...a) => graph.fetch(...a) }));
  admin = await login('pdiag-admin', 'admin');
  expect((await call(admin, 'PUT', '/api/connections/admin/apps/google', { enabled: true, clientId: google.client.id, clientSecret: APP_SECRET })).statusCode).toBe(200);
  expect((await call(admin, 'PUT', '/api/connections/admin/apps/microsoft', { enabled: true, clientId: graph.clientId, clientSecret: APP_SECRET, tenant: 'common' })).statusCode).toBe(200);
  app.get(ConnectionApps, { strict: false }).invalidate();
});

afterAll(async () => {
  for (const p of ['google', 'microsoft']) await call(admin, 'DELETE', `/api/connections/admin/apps/${p}`);
  await prisma.connectionDiagnostic.deleteMany({ where: { OR: [{ userId: { in: userIds } }, { targetKind: 'provider_app' }] } });
  await prisma.connection.deleteMany({ where: { user: { email: { contains: stamp } } } });
  const adapters = app.get(ConnectionProviderRegistry, { strict: false });
  if (saved.google) adapters.register(saved.google as never);
  if (saved.microsoft) adapters.register(saved.microsoft as never);
  await app?.close();
  if (savedKey === undefined) delete process.env.SECRETS_ENCRYPTION_KEY;
  else process.env.SECRETS_ENCRYPTION_KEY = savedKey;
});

describe('a Google connection', () => {
  let s: Session;
  let account: FakeGoogleAccount;
  let id: string;

  beforeAll(async () => {
    s = await login('pdiag-google');
    account = google.addAccount({ email: `person-a-${stamp}@example.test` });
    account.addMessage({ subject: SUBJECT, text: SUBJECT });
    id = await connect(s, 'google', ['mail_read', 'calendar_read', 'docs_read'], (url) => google.consent(url, account));
  });

  it("runs the provider's own stages in order, after the generic ones", async () => {
    const r = await diagnose(s, id);
    expect(r.statusCode).toBe(200);
    expect(shape(r.data)).toEqual([
      ['status', 'pass', null],
      ['provider_installed', 'pass', null],
      ['app_config', 'pass', null],
      ['sign_in', 'pass', null],
      ['token_lifetime', 'pass', null],
      ['permissions', 'pass', null],
      ['capability:mail_read', 'pass', null],
      ['capability:calendar_read', 'pass', null],
      ['capability:docs_read', 'pass', null],
      ['clock', 'pass', null],
      ['latency', 'pass', null],
    ]);
    expect(stage(r.data, 'token_lifetime').data!.expires_in_s).toBeGreaterThan(0);
  });

  it('#681: Drive, Docs and Sheets switched off are named in the report and in Test; Mail and Calendar still pass', async () => {
    for (const api of ['drive.googleapis.com', 'docs.googleapis.com', 'sheets.googleapis.com']) google.disabledApis.add(api);
    try {
      const r = await diagnose(s, id);
      expect(r.data.overall).toBe('fail');
      expect(stage(r.data, 'capability:docs_read')).toMatchObject({ status: 'fail', code: 'API_DISABLED', remedy: 'API_DISABLED_DRIVE', data: { api: 'drive.googleapis.com', drive: false, docs: false, sheets: false, disabled: 3 } });
      expect(stage(r.data, 'capability:mail_read').status).toBe('pass');
      expect(stage(r.data, 'capability:calendar_read').status).toBe('pass');
      const t = await call<{ results: { capability: string; ok: boolean; code: string | null; api?: string }[] }>(s, 'POST', `/api/connections/${id}/test`);
      expect(t.data.results).toEqual([
        { capability: 'mail_read', ok: true, code: null },
        { capability: 'calendar_read', ok: true, code: null },
        { capability: 'docs_read', ok: false, code: 'API_DISABLED', api: 'drive.googleapis.com' },
      ]);
    } finally {
      google.disabledApis.clear();
    }
  });

  it('a grant revoked at Google fails at sign_in and every capability stage is skipped', async () => {
    const s2 = await login('pdiag-google-revoked');
    const b = google.addAccount({ email: `person-b-${stamp}@example.test` });
    const id2 = await connect(s2, 'google', ['mail_read', 'calendar_read'], (url) => google.consent(url, b));
    b.revoked = true;
    await prisma.connection.update({ where: { id: id2 }, data: { accessExpiresAt: new Date(Date.now() - 1000) } });
    const r = await diagnose(s2, id2);
    expect(shape(r.data)).toEqual([
      ['status', 'pass', null],
      ['provider_installed', 'pass', null],
      ['app_config', 'pass', null],
      ['sign_in', 'fail', 'GRANT_REVOKED'],
      ['token_lifetime', 'pass', null],
      ['permissions', 'pass', null],
      ['capability:mail_read', 'skipped', null],
      ['capability:calendar_read', 'skipped', null],
      ['clock', 'skipped', null],
      ['latency', 'pass', null],
    ]);
  });
});

describe('a Microsoft connection', () => {
  it('an account without a mailbox: Mail fails with MAILBOX_NOT_FOUND, Calendar still passes', async () => {
    const s = await login('pdiag-microsoft');
    const account: FakeAccount = graph.addAccount({ email: `person-c-${stamp}@example.test` });
    const id = await connect(s, 'microsoft', ['mail_read', 'calendar_read'], (url) => graph.consent(url, account));
    graph.fail((r) => r.path.startsWith('/me/mailFolders'), 404, 'MailboxNotEnabledForRESTAPI');
    const r = await diagnose(s, id);
    expect(stage(r.data, 'sign_in').status).toBe('pass');
    expect(stage(r.data, 'capability:mail_read')).toMatchObject({ status: 'fail', code: 'MAILBOX_NOT_FOUND' });
    expect(stage(r.data, 'capability:calendar_read').status).toBe('pass');
  });
});

describe("the deployment's apps, before anyone connects", () => {
  const origin = { origin: 'http://localhost:3535' };

  it('an administrator tests the Google app: stored with no user and listed', async () => {
    const r = await call<Report>(admin, 'POST', '/api/connections/admin/apps/google/diagnose', undefined, origin);
    expect(r.statusCode).toBe(200);
    expect(r.data).toMatchObject({ target: { kind: 'provider_app', id: 'google' }, trigger: 'admin' });
    expect(r.data.stages.map((x) => x.id)).toEqual(['app_config', 'redirect_uri', 'discovery', 'client_check', 'picker_key']);
    expect(stage(r.data, 'app_config')).toMatchObject({ status: 'pass', data: { client_id_set: true, secret_set: true, enabled: true, client_id_end: '9q7z' } });
    expect(stage(r.data, 'client_check')).toMatchObject({ status: 'pass', data: { accepted: true } });
    expect(stage(r.data, 'picker_key')).toMatchObject({ status: 'warn', code: 'PICKER_KEY_MISSING' });
    const row = await prisma.connectionDiagnostic.findUniqueOrThrow({ where: { id: r.data.id } });
    expect(row.userId).toBeNull();
    const list = await call<Report[]>(admin, 'GET', '/api/connections/admin/apps/google/diagnostics');
    expect(list.statusCode).toBe(200);
    expect(list.data[0]!.id).toBe(r.data.id);
    // An app report is nobody's connection report: it is not in an owner's summary.
    expect((await call<unknown[]>(admin, 'GET', '/api/connections/diagnostics/summary')).data).toEqual([]);
  });

  it('a refused secret, the switch off and a Microsoft tenant that does not exist are each named', async () => {
    google.client = { ...google.client, secret: 'rotated-at-google' };
    try {
      const r = await call<Report>(admin, 'POST', '/api/connections/admin/apps/google/diagnose', undefined, origin);
      expect(stage(r.data, 'client_check')).toMatchObject({ status: 'fail', code: 'APP_CREDENTIALS_REFUSED', remedy: 'APP_CREDENTIALS_REFUSED' });
    } finally {
      google.client = { ...google.client, secret: APP_SECRET };
    }
    expect((await call(admin, 'PUT', '/api/connections/admin/apps/microsoft', { enabled: false, tenant: '11111111-2222-4333-8444-555555555555' })).statusCode).toBe(200);
    graph.unknownTenants.add('11111111-2222-4333-8444-555555555555');
    try {
      const m = await call<Report>(admin, 'POST', '/api/connections/admin/apps/microsoft/diagnose', undefined, origin);
      expect(shape(m.data).filter(([sid]) => sid !== 'redirect_uri')).toEqual([
        ['app_config', 'warn', 'PROVIDER_OFF'],
        ['discovery', 'fail', 'TENANT_NOT_FOUND'],
        ['client_check', 'fail', 'TENANT_NOT_FOUND'],
      ]);
    } finally {
      graph.unknownTenants.clear();
      await call(admin, 'PUT', '/api/connections/admin/apps/microsoft', { enabled: true, tenant: 'common' });
    }
  });

  it('an app with no secret fails app_config and skips the rest', async () => {
    const svc = app.get(ConnectionAppDiagnostics, { strict: false });
    expect((await call(admin, 'DELETE', '/api/connections/admin/apps/microsoft')).statusCode).toBe(200);
    try {
      const stages = await svc.stages('microsoft');
      expect(stages.map((x) => [x.id, x.status, x.code])).toEqual([
        ['app_config', 'fail', 'APP_NOT_CONFIGURED'],
        ['redirect_uri', 'skipped', null],
        ['discovery', 'skipped', null],
        ['client_check', 'skipped', null],
      ]);
    } finally {
      await call(admin, 'PUT', '/api/connections/admin/apps/microsoft', { enabled: true, clientId: graph.clientId, clientSecret: APP_SECRET, tenant: 'common' });
    }
  });

  it('the registry holds each provider app check (for the Doctor of E50.13)', async () => {
    const registry = app.get(DiagnosticsRegistry, { strict: false });
    const d = registry.get<{ provider: 'google'; publicOrigin?: string | null }>('provider_app', 'google');
    expect(d).toBeDefined();
    const stages = await d!.diagnose({ provider: 'google' }, { signal: new AbortController().signal, trigger: 'admin' });
    expect(stages[0]!.id).toBe('app_config');
    expect(registry.codes()).toEqual(expect.arrayContaining(['APP_CREDENTIALS_REFUSED', 'TENANT_NOT_FOUND', 'PICKER_KEY_MISSING']));
  });

  it('is refused for everyone but an administrator', async () => {
    const someone = await login('pdiag-contributor');
    expect((await call(someone, 'POST', '/api/connections/admin/apps/google/diagnose')).statusCode).toBe(403);
    expect((await call(someone, 'GET', '/api/connections/admin/apps/google/diagnostics')).statusCode).toBe(403);
    expect((await call(admin, 'POST', '/api/connections/admin/apps/nope/diagnose')).statusCode).toBe(400);
  });
});

describe('what a report never holds', () => {
  it('no secret, token, account address, subject, Google project number or Graph message in any response or stored report', async () => {
    const rows = await prisma.connectionDiagnostic.findMany({ where: { OR: [{ userId: { in: userIds } }, { targetKind: 'provider_app' }] } });
    expect(rows.length).toBeGreaterThan(3);
    const stored = JSON.stringify(rows.map((r) => r.stages));
    const diagnosticResponses = responses.filter((r) => r.includes('"stages"') || r.includes('"results"')).join('\n');
    const markers = [APP_SECRET, 'MARKER', `person-a-${stamp}`, `person-b-${stamp}`, `person-c-${stamp}`, '123456789012', 'console.developers', FakeGraph.CONTENT_MARKER, ...google.accounts.map((a) => a.accessToken), ...google.accounts.map((a) => a.refreshToken)];
    for (const m of markers) {
      expect([m, stored.includes(m)]).toEqual([m, false]);
      expect([m, diagnosticResponses.includes(m)]).toEqual([m, false]);
    }
  });
});
