// The Google provider inside the running API against a real, migrated database and the in-process fake Google endpoints
// (E39.3, #601): connecting two Google accounts through the real adapter (PKCE, offline access, incremental consent that asks only
// for the new permission), the token service refreshing for the capability calls, the Test route, a revoked grant becoming a typed
// error, removal revoking at Google, and tokens that never cross between two accounts of one user.
import { randomUUID } from 'node:crypto';
import type { NestFastifyApplication } from '@nestjs/platform-fastify';

import { CapabilityError } from '../src/connections/capabilities';
import { CapabilityProviderRegistry } from '../src/connections/capability-provider.registry';
import { ConnectionApps } from '../src/connections/connection-apps.service';
import { ConnectionCapabilities } from '../src/connections/connection-capabilities.service';
import { ConnectionProviderRegistry } from '../src/connections/connection-provider.registry';
import { ConnectionTokensService } from '../src/connections/connection-tokens.service';
import type { Capability } from '../src/connections/connections.constants';
import { GoogleConnectionAdapter } from '../src/connections/google/google.adapter';
import { GoogleCapabilityProvider } from '../src/connections/google/google.provider';
import { GoogleHttp } from '../src/connections/google/google-http';
import { SCOPE } from '../src/connections/google/google.scopes';
import { FakeGoogle, type FakeGoogleAccount } from '../src/connections/google/testing';
import { createApp } from '../src/main';
import { OAuthClientService } from '../src/oauth-client';
import { PrismaService } from '../src/prisma/prisma.service';

const savedKey = process.env.SECRETS_ENCRYPTION_KEY;
process.env.SECRETS_ENCRYPTION_KEY ||= Buffer.alloc(32, 7).toString('base64');
const stamp = `${Date.now()}`;

let app: NestFastifyApplication;
let prisma: PrismaService;
let fake: FakeGoogle;
let admin: Session;
let capabilities: ConnectionCapabilities;
let tokens: ConnectionTokensService;
let savedAdapter: unknown;
let savedProvider: unknown;

interface Session {
  token: string;
  userId: string;
}

async function login(name: string, role: 'contributor' | 'admin' = 'contributor'): Promise<Session> {
  const res = await app.inject({ method: 'POST', url: '/api/auth/test/login', payload: { email: `${name}-${stamp}@example.test`, role } });
  const token = new URL(String(res.headers.location)).searchParams.get('token')!;
  const me = await app.inject({ method: 'GET', url: '/api/auth/me', headers: { authorization: `Bearer ${token}` } });
  return { token, userId: me.json<{ data: { id: string } }>().data.id };
}

async function call<T = unknown>(s: Session, method: 'GET' | 'PATCH' | 'PUT' | 'DELETE' | 'POST', url: string, payload?: unknown) {
  const res = await app.inject({ method, url, headers: { authorization: `Bearer ${s.token}` }, ...(payload === undefined ? {} : { payload: payload as object }) });
  const body = res.body ? (res.json() as { data?: T; error?: { code?: string }; code?: string }) : {};
  return { statusCode: res.statusCode, data: body.data as T, code: body.error?.code ?? body.code ?? '', headers: res.headers };
}

const cookieOf = (setCookie: unknown): { name: string; value: string } => {
  const raw = Array.isArray(setCookie) ? String(setCookie[0]) : String(setCookie);
  const m = /^(hx_conn_[a-f0-9]+)=([^;]*)/.exec(raw)!;
  return { name: m[1]!, value: m[2]! };
};

/** The browser's half of a consent: sign in at Google as `account`, tick or untick, come back with the cookie. */
async function consentAndReturn(authorizeUrl: string, cookie: { name: string; value: string }, account: FakeGoogleAccount, opts: { deny?: string[] } = {}) {
  const { code, state } = fake.consent(authorizeUrl, account, opts);
  const res = await app.inject({ method: 'GET', url: `/api/connections/callback/google?${new URLSearchParams({ code, state })}`, headers: { cookie: `${cookie.name}=${cookie.value}` } });
  return String(res.headers.location);
}

async function connect(s: Session, account: FakeGoogleAccount, body: { capabilities: Capability[]; label?: string }, opts: { deny?: string[] } = {}) {
  const start = await call<{ authorizeUrl: string }>(s, 'POST', '/api/connections/authorize', { provider: 'google', loginHint: account.email, ...body });
  expect(start.statusCode).toBe(200);
  const location = await consentAndReturn(start.data.authorizeUrl, cookieOf(start.headers['set-cookie']), account, opts);
  return { start, location, id: new URL(location, 'http://console.example.test').searchParams.get('connection')! };
}

beforeAll(async () => {
  app = await createApp();
  await app.init();
  await app.getHttpAdapter().getInstance().ready();
  prisma = app.get(PrismaService);
  capabilities = app.get(ConnectionCapabilities, { strict: false });
  tokens = app.get(ConnectionTokensService, { strict: false });
  fake = new FakeGoogle();
  // The real Google adapter and capability provider, over the fake endpoints instead of the network.
  const adapters = app.get(ConnectionProviderRegistry, { strict: false });
  const providers = app.get(CapabilityProviderRegistry, { strict: false });
  savedAdapter = adapters.get('google');
  savedProvider = providers.get('google');
  adapters.register(new GoogleConnectionAdapter(new OAuthClientService(fake), fake));
  providers.register(new GoogleCapabilityProvider(new GoogleHttp(fake, undefined, { sleep: async () => undefined }), tokens));
  admin = await login('gconn-admin', 'admin');
  expect((await call(admin, 'PUT', '/api/connections/admin/apps/google', { enabled: true, clientId: fake.client.id, clientSecret: fake.client.secret })).statusCode).toBe(200);
  app.get(ConnectionApps, { strict: false }).invalidate();
});

afterAll(async () => {
  await call(admin, 'DELETE', '/api/connections/admin/apps/google');
  await prisma.connection.deleteMany({ where: { user: { email: { contains: stamp } } } });
  if (savedAdapter) app.get(ConnectionProviderRegistry, { strict: false }).register(savedAdapter as never);
  if (savedProvider) app.get(CapabilityProviderRegistry, { strict: false }).register(savedProvider as never);
  await app?.close();
  if (savedKey === undefined) delete process.env.SECRETS_ENCRYPTION_KEY;
  else process.env.SECRETS_ENCRYPTION_KEY = savedKey;
});

describe('connecting Google accounts', () => {
  it('sends the owner to Google with PKCE, offline access, incremental consent and the account as a hint', async () => {
    const s = await login('gconn-url');
    const a = fake.addAccount({ email: `person-a-${stamp}@example.test`, scopes: [] });
    const start = await call<{ authorizeUrl: string }>(s, 'POST', '/api/connections/authorize', { provider: 'google', capabilities: ['mail_read', 'mail_send'], loginHint: a.email });
    const u = new URL(start.data.authorizeUrl);
    expect(`${u.origin}${u.pathname}`).toBe('https://accounts.google.com/o/oauth2/v2/auth');
    expect(Object.fromEntries(u.searchParams)).toMatchObject({
      response_type: 'code',
      client_id: fake.client.id,
      code_challenge_method: 'S256',
      access_type: 'offline',
      include_granted_scopes: 'true',
      prompt: 'consent',
      login_hint: a.email,
    });
    expect(u.searchParams.get('redirect_uri')).toMatch(/\/api\/connections\/callback\/google$/);
    expect(u.searchParams.get('scope')!.split(' ').sort()).toEqual(['email', 'openid', 'profile', SCOPE.gmailRead, SCOPE.gmailSend].sort());
    expect(u.searchParams.get('client_secret')).toBeNull();
  });

  it('connects an account: the stable id and email from Google, what Google granted, tokens that work', async () => {
    const s = await login('gconn-first');
    const a = fake.addAccount({ email: `person-a2-${stamp}@example.test`, scopes: [] });
    const r = await connect(s, a, { capabilities: ['mail_read', 'mail_send'], label: 'Work' });
    expect(r.location).toContain('connect=connected');
    const row = await prisma.connection.findUniqueOrThrow({ where: { id: r.id } });
    expect(row).toMatchObject({ provider: 'google', accountId: a.sub, accountEmail: a.email, label: 'Work', status: 'active' });
    expect(row.grantedScopes).toEqual(expect.arrayContaining([SCOPE.gmailRead, SCOPE.gmailSend]));
    expect(row.capabilities).toEqual(['mail_read', 'mail_send']);
    a.addMessage({ subject: 'Welcome' });
    const found = await capabilities.mail({ connectionId: r.id, userId: s.userId }).search({});
    expect(found.items.map((m) => m.subject)).toEqual(['Welcome']);
    expect((await prisma.connection.findUniqueOrThrow({ where: { id: r.id } })).lastUsedAt).not.toBeNull();
  });

  it('a permission the owner unticks leaves its capability off', async () => {
    const s = await login('gconn-deny');
    const a = fake.addAccount({ email: `person-a3-${stamp}@example.test`, scopes: [] });
    const r = await connect(s, a, { capabilities: ['mail_read', 'mail_send'] }, { deny: [SCOPE.gmailSend] });
    expect(r.location).toContain('missing=mail_send');
    const view = (await call<{ capabilities: Capability[]; granted: Capability[] }>(s, 'GET', `/api/connections/${r.id}`)).data;
    expect(view.capabilities).toEqual(['mail_read']);
    expect(view.granted).toEqual(['mail_read']);
  });

  it('incremental consent: switching Calendar on for a mail-only connection asks only for the calendar permission', async () => {
    const s = await login('gconn-inc');
    const a = fake.addAccount({ email: `person-a4-${stamp}@example.test`, scopes: [] });
    const r = await connect(s, a, { capabilities: ['mail_read'] });
    const patch = await call<{ connection: { capabilities: Capability[] }; consent: { authorizeUrl: string } | null }>(s, 'PATCH', `/api/connections/${r.id}`, { capabilities: ['mail_read', 'calendar_read'] });
    expect(patch.statusCode).toBe(200);
    expect(patch.data.connection.capabilities).toEqual(['mail_read']); // not on until the consent returns
    const u = new URL(patch.data.consent!.authorizeUrl);
    const asked = u.searchParams.get('scope')!.split(' ');
    expect(asked).toEqual(expect.arrayContaining([SCOPE.calendarRead]));
    expect(asked).not.toContain(SCOPE.gmailRead);
    expect(asked.filter((x) => x.includes('/auth/'))).toEqual([SCOPE.calendarRead]);
    expect(u.searchParams.get('include_granted_scopes')).toBe('true');
    expect(u.searchParams.get('prompt')).toBeNull(); // the account already gave a refresh token
    expect(u.searchParams.get('login_hint')).toBe(a.email);
    const location = await consentAndReturn(patch.data.consent!.authorizeUrl, cookieOf(patch.headers['set-cookie']), a, {});
    expect(location).toContain('connect=connected');
    const view = (await call<{ capabilities: Capability[]; granted: Capability[] }>(s, 'GET', `/api/connections/${r.id}`)).data;
    expect(view.capabilities).toEqual(['mail_read', 'calendar_read']);
    expect(view.granted).toEqual(['mail_read', 'calendar_read']); // the mail permission is still granted
  });
});

describe('using the accounts', () => {
  it('keeps two Google accounts of one user apart, and refreshes each with its own token', async () => {
    const s = await login('gconn-two');
    const a = fake.addAccount({ email: `person-a5-${stamp}@example.test`, scopes: [] });
    const b = fake.addAccount({ email: `person-b5-${stamp}@example.test`, scopes: [] });
    const ca = await connect(s, a, { capabilities: ['mail_read', 'mail_send'], label: 'Work' });
    const cb = await connect(s, b, { capabilities: ['mail_read', 'mail_send'], label: 'Home' });
    a.addMessage({ subject: 'Only Work' });
    b.addMessage({ subject: 'Only Home' });
    // Make both access tokens due, so each call refreshes through the token service.
    await prisma.connection.updateMany({ where: { id: { in: [ca.id, cb.id] } }, data: { accessExpiresAt: new Date(Date.now() - 1000) } });
    fake.requests.length = 0;
    const [fromA, fromB] = await Promise.all([capabilities.mail({ connectionId: ca.id, userId: s.userId }).search({}), capabilities.mail({ connectionId: cb.id, userId: s.userId }).search({})]);
    expect(fromA.items.map((m) => m.subject)).toEqual(['Only Work']);
    expect(fromB.items.map((m) => m.subject)).toEqual(['Only Home']);
    expect(fake.requestsTo('POST oauth2.googleapis.com/token')).toHaveLength(2);
    // The refresh tokens that were presented are each account's own.
    expect(fake.requestsTo('POST oauth2.googleapis.com/token').map((r) => r.form!.refresh_token).sort()).toEqual([a.refreshToken, b.refreshToken].sort());
    for (const r of fake.requestsTo('gmail.googleapis.com')) expect([a.accessToken, b.accessToken]).toContain(r.bearer);
    await capabilities.mail({ connectionId: cb.id, userId: s.userId }).send({ to: [{ address: 'person-c@example.test' }], subject: 'From Home', text: 'x' });
    expect(a.sent).toHaveLength(0);
    expect(b.sent[0]!.headers.from).toEqual([b.email]);
  });

  it('another user cannot use the connection', async () => {
    const owner = await login('gconn-own');
    const other = await login('gconn-other');
    const a = fake.addAccount({ email: `person-a6-${stamp}@example.test`, scopes: [] });
    const c = await connect(owner, a, { capabilities: ['mail_read'] });
    const e = await capabilities.mail({ connectionId: c.id, userId: other.userId }).search({}).catch((x: unknown) => x);
    expect(e).toBeInstanceOf(CapabilityError);
    expect((e as CapabilityError).code).toBe('CONNECTION_NOT_FOUND');
  });

  it('a call with a capability that is off is CAPABILITY_OFF before any request to Google', async () => {
    const s = await login('gconn-off');
    const a = fake.addAccount({ email: `person-a7-${stamp}@example.test`, scopes: [] });
    const c = await connect(s, a, { capabilities: ['mail_read'] });
    fake.requests.length = 0;
    const e = await capabilities.calendar({ connectionId: c.id, userId: s.userId }).listCalendars().catch((x: unknown) => x);
    expect((e as CapabilityError).code).toBe('CAPABILITY_OFF');
    expect(fake.requests).toHaveLength(0);
  });

  it('the Test route makes one cheap read per switched-on capability', async () => {
    const s = await login('gconn-test');
    const a = fake.addAccount({ email: `person-a8-${stamp}@example.test`, scopes: [] });
    const c = await connect(s, a, { capabilities: ['mail_read', 'calendar_read', 'docs_read'] });
    fake.requests.length = 0;
    const t = await call<{ results: { capability: string; ok: boolean; code: string | null }[] }>(s, 'POST', `/api/connections/${c.id}/test`);
    expect(t.statusCode).toBe(200);
    expect(t.data.results).toEqual([
      { capability: 'mail_read', ok: true, code: null },
      { capability: 'calendar_read', ok: true, code: null },
      { capability: 'docs_read', ok: true, code: null },
    ]);
    expect(fake.requests.map((r) => `${r.method} ${r.host}${r.path}`)).toEqual(['GET gmail.googleapis.com/gmail/v1/users/me/labels', 'GET www.googleapis.com/calendar/v3/users/me/calendarList', 'GET www.googleapis.com/drive/v3/about']);
    // A switched-off API at the Google project is named, not "failed" (E50.11, #681: with the API to enable).
    fake.failNext('calendarList', { status: 403, body: { error: { details: [{ reason: 'SERVICE_DISABLED' }] } } });
    const t2 = await call<{ results: { capability: string; ok: boolean; code: string | null }[] }>(s, 'POST', `/api/connections/${c.id}/test`);
    expect(t2.data.results.find((r) => r.capability === 'calendar_read')).toEqual({ capability: 'calendar_read', ok: false, code: 'API_DISABLED', api: 'calendar-json.googleapis.com' });
  });

  it('a grant the owner revoked at Google becomes CONNECTION_NEEDS_RECONNECT for the caller, once', async () => {
    const s = await login('gconn-revoked');
    const a = fake.addAccount({ email: `person-a9-${stamp}@example.test`, scopes: [] });
    const c = await connect(s, a, { capabilities: ['mail_read'] });
    a.revoked = true; // removed in the account's own settings
    await prisma.connection.update({ where: { id: c.id }, data: { accessExpiresAt: new Date(Date.now() - 1000) } });
    const e = (await capabilities.mail({ connectionId: c.id, userId: s.userId }).search({}).catch((x: unknown) => x)) as CapabilityError;
    expect(e).toBeInstanceOf(CapabilityError);
    expect(e.code).toBe('CONNECTION_NEEDS_RECONNECT');
    expect(e.details.reason).toBe('GRANT_REVOKED');
    expect((await prisma.connection.findUniqueOrThrow({ where: { id: c.id } })).status).toBe('needs_reconnect');
  });

  it('removing a connection revokes the grant at Google', async () => {
    const s = await login('gconn-remove');
    const a = fake.addAccount({ email: `person-a10-${stamp}@example.test`, scopes: [] });
    const c = await connect(s, a, { capabilities: ['mail_read'] });
    const r = await call<{ revoked: boolean }>(s, 'DELETE', `/api/connections/${c.id}`);
    expect(r.data.revoked).toBe(true);
    expect(fake.requestsTo('POST oauth2.googleapis.com/revoke').length).toBeGreaterThan(0);
    expect(a.revoked).toBe(true);
    void randomUUID;
  });
});
