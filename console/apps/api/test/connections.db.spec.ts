// Connections against a real, migrated and seeded database and the FAKE PROVIDER (E39.2, #599): connecting several accounts of one
// provider, a reconnect that does not duplicate, fewer permissions than asked, state and PKCE, the browser binding, incremental
// consent, defaults, `resolveConnection`, the token service (one refresh however many callers, rotation, invalid grant, the one
// notification), the daily health job, removal, ownership (404 on every route), the user's deletion, and a seeded-marker scan of
// every response, audit row, notification, row and log line. No real Google or Microsoft is called.
import { randomUUID } from 'node:crypto';
import { JobHandlerRegistry } from '@marinoscar/platform-api/jobs';
import { NotificationsService } from '@marinoscar/platform-api/notifications';
import type { NestFastifyApplication } from '@nestjs/platform-fastify';

import { ConnectionApps } from '../src/connections/connection-apps.service';
import { bindingCookieName, ConnectionFlowService } from '../src/connections/connection-flow.service';
import { ConnectionProviderRegistry } from '../src/connections/connection-provider.registry';
import { ConnectionResolverService } from '../src/connections/connection-resolver.service';
import { ConnectionTokenStore } from '../src/connections/connection-token.store';
import { ConnectionTokensService } from '../src/connections/connection-tokens.service';
import { ConnectionUsageRegistry, type ConnectionUsage } from '../src/connections/connection-usage.registry';
import { ConnectionEvents } from '../src/connections/connections.events';
import { ConnectionsHealth, ConnectionsHealthHandler, ConnectionsHealthTask, CONNECTIONS_HEALTH_JOB } from '../src/connections/connections.jobs';
import type { Capability } from '../src/connections/connections.constants';
import { createApp } from '../src/main';
import { PrismaService } from '../src/prisma/prisma.service';
import { FakeConnectionProvider, fakeScopeOf, type FakeAccount } from './support/fake-connection-provider';

const savedKey = process.env.SECRETS_ENCRYPTION_KEY;
process.env.SECRETS_ENCRYPTION_KEY ||= Buffer.alloc(32, 7).toString('base64');
const stamp = `${Date.now()}`;
const APP_SECRET = `MARKER-app-secret-${randomUUID()}`;

let app: NestFastifyApplication;
let prisma: PrismaService;
let google: FakeConnectionProvider;
let microsoft: FakeConnectionProvider;
let tokens: ConnectionTokensService;
let store: ConnectionTokenStore;
let resolver: ConnectionResolverService;
let flows: ConnectionFlowService;
let admin: Session;

/** Everything the console said or wrote, scanned for the seeded markers at the end. */
const responses: string[] = [];
const logged: string[] = [];

interface Session {
  token: string;
  userId: string;
}

async function login(name: string, role: 'contributor' | 'viewer' | 'admin' = 'contributor'): Promise<Session> {
  const res = await app.inject({ method: 'POST', url: '/api/auth/test/login', payload: { email: `${name}-${stamp}@example.test`, role } });
  const token = new URL(String(res.headers.location)).searchParams.get('token')!;
  const me = await app.inject({ method: 'GET', url: '/api/auth/me', headers: { authorization: `Bearer ${token}` } });
  return { token, userId: me.json<{ data: { id: string } }>().data.id };
}

interface Reply<T> {
  statusCode: number;
  code: string;
  data: T;
  headers: Record<string, unknown>;
  details: Record<string, unknown> | undefined;
}
async function call<T = unknown>(s: Session, method: 'GET' | 'PATCH' | 'PUT' | 'DELETE' | 'POST', url: string, payload?: unknown): Promise<Reply<T>> {
  const res = await app.inject({ method, url, headers: { authorization: `Bearer ${s.token}` }, ...(payload === undefined ? {} : { payload: payload as object }) });
  responses.push(`${res.statusCode} ${JSON.stringify(res.headers)} ${res.body}`);
  const body = res.body ? (res.json() as { data?: T; error?: { code?: string; details?: Record<string, unknown> }; code?: string; details?: Record<string, unknown> }) : {};
  return { statusCode: res.statusCode, code: body.error?.code ?? body.code ?? '', data: body.data as T, headers: res.headers, details: body.error?.details ?? body.details };
}

interface View {
  id: string;
  provider: string;
  label: string;
  accountEmail: string;
  capabilities: Capability[];
  granted: Capability[];
  defaultFor: string[];
  status: string;
  statusReason: string | null;
  lastUsedAt: string | null;
}

const A: FakeAccount = { accountId: 'acct-a', email: 'person.a@example.test', name: 'Person A' };
const B: FakeAccount = { accountId: 'acct-b', email: 'person.b@example.test', name: 'Person B' };
const M: FakeAccount = { accountId: 'acct-m', email: 'person.m@example.test', name: 'Person M' };
const ALL: Capability[] = ['mail_read', 'mail_send', 'calendar_read', 'calendar_write', 'docs_read', 'docs_write'];

/** Parses the cookie a `Set-Cookie` header sets: `{ name, value }`. */
function cookieOf(setCookie: unknown): { name: string; value: string } {
  const raw = Array.isArray(setCookie) ? String(setCookie[0]) : String(setCookie);
  const m = /^(hx_conn_[a-f0-9]+)=([^;]*)/.exec(raw)!;
  return { name: m[1]!, value: m[2]! };
}

/** The browser arrives from the provider with `code` and `state`, carrying the binding cookie it was given. */
async function callback(provider: 'google' | 'microsoft', query: Record<string, string>, cookie: { name: string; value: string } | null) {
  const qs = new URLSearchParams(query).toString();
  const res = await app.inject({ method: 'GET', url: `/api/connections/callback/${provider}?${qs}`, headers: cookie ? { cookie: `${cookie.name}=${cookie.value}` } : {} });
  responses.push(`${res.statusCode} ${JSON.stringify(res.headers)} ${res.body}`);
  return res;
}

/** The whole connect flow as the browser does it. */
async function connect(s: Session, fake: FakeConnectionProvider, account: FakeAccount, body: Record<string, unknown> = {}, consent: { deny?: string[]; noRefreshToken?: boolean } = {}) {
  const provider = fake.id;
  const start = await call<{ authorizeUrl: string; expiresAt: string }>(s, 'POST', '/api/connections/authorize', { provider, capabilities: ['mail_read'], ...body });
  expect(start.statusCode).toBe(200);
  const { code, state } = fake.consent(start.data.authorizeUrl, account, consent);
  const cookie = cookieOf(start.headers['set-cookie']);
  const res = await callback(provider, { code, state }, cookie);
  return { start, code, state, cookie, res, location: String(res.headers.location) };
}

const connectionId = (location: string): string => new URL(location, 'http://console.example.test').searchParams.get('connection')!;
const list = async (s: Session) => (await call<View[]>(s, 'GET', '/api/connections')).data;
const rowOf = (id: string) => prisma.connection.findUniqueOrThrow({ where: { id } });
const expireAccess = (id: string, when = new Date(Date.now() - 1000)) => prisma.connection.update({ where: { id }, data: { accessExpiresAt: when } });
const flush = () => app.get(NotificationsService).flush();
const reconnectNotes = (userId: string) => prisma.notification.count({ where: { userId, eventKey: 'connections.needs_reconnect' } });

/** A user with one active connection of `fake` with these capabilities. */
async function connected(name: string, fake = google, account: FakeAccount = A, capabilities: Capability[] = ['mail_read', 'mail_send']) {
  const s = await login(name);
  const r = await connect(s, fake, account, { capabilities });
  expect(r.location).toContain('connect=connected');
  return { s, id: connectionId(r.location) };
}

beforeAll(async () => {
  const origOut = process.stdout.write.bind(process.stdout);
  const origErr = process.stderr.write.bind(process.stderr);
  jest.spyOn(process.stdout, 'write').mockImplementation(((chunk: unknown, ...rest: unknown[]) => {
    logged.push(String(chunk));
    return (origOut as (...a: unknown[]) => boolean)(chunk, ...rest);
  }) as never);
  jest.spyOn(process.stderr, 'write').mockImplementation(((chunk: unknown, ...rest: unknown[]) => {
    logged.push(String(chunk));
    return (origErr as (...a: unknown[]) => boolean)(chunk, ...rest);
  }) as never);

  app = await createApp();
  await app.init();
  await app.getHttpAdapter().getInstance().ready();
  prisma = app.get(PrismaService);
  tokens = app.get(ConnectionTokensService, { strict: false });
  store = app.get(ConnectionTokenStore, { strict: false });
  resolver = app.get(ConnectionResolverService, { strict: false });
  flows = app.get(ConnectionFlowService, { strict: false });
  google = new FakeConnectionProvider('google');
  microsoft = new FakeConnectionProvider('microsoft');
  const registry = app.get(ConnectionProviderRegistry, { strict: false });
  registry.register(google);
  registry.register(microsoft);
  admin = await login('conn-admin', 'admin');
  for (const [p, id] of [['google', 'fake-google-client'], ['microsoft', 'fake-microsoft-client']] as const) {
    expect((await call(admin, 'PUT', `/api/connections/admin/apps/${p}`, { enabled: true, clientId: id, clientSecret: APP_SECRET })).statusCode).toBe(200);
  }
  app.get(ConnectionApps, { strict: false }).invalidate();
});

afterAll(async () => {
  jest.restoreAllMocks();
  // leave the shared settings as found
  for (const p of ['google', 'microsoft']) await call(admin, 'DELETE', `/api/connections/admin/apps/${p}`);
  await prisma.connection.deleteMany({ where: { user: { email: { contains: stamp } } } });
  await app?.close();
  if (savedKey === undefined) delete process.env.SECRETS_ENCRYPTION_KEY;
  else process.env.SECRETS_ENCRYPTION_KEY = savedKey;
});

describe('the providers and the administrator\'s apps', () => {
  it('lists each provider as ready once the administrator has set and switched it on, with the account types', async () => {
    const s = await login('conn-providers');
    const r = await call<{ provider: string; ready: boolean; reason: string | null; accountTypes: { label: string }[] }[]>(s, 'GET', '/api/connections/providers');
    expect(r.statusCode).toBe(200);
    expect(r.data.map((p) => [p.provider, p.ready, p.reason])).toEqual([['google', true, null], ['microsoft', true, null]]);
    expect(r.data[0]!.accountTypes.length).toBeGreaterThan(0);
  });

  it('shows the administrator the redirect URIs, the setup checklist and whether a secret is stored: never the secret', async () => {
    const r = await call<{ provider: string; enabled: boolean; clientId: string | null; hasClientSecret: boolean; redirectUri: string; setupSteps: string[]; installed: boolean }[]>(admin, 'GET', '/api/connections/admin/apps');
    expect(r.statusCode).toBe(200);
    const g = r.data.find((p) => p.provider === 'google')!;
    expect(g).toMatchObject({ enabled: true, clientId: 'fake-google-client', hasClientSecret: true, installed: true });
    expect(g.redirectUri).toMatch(/\/api\/connections\/callback\/google$/);
    expect(g.setupSteps.length).toBeGreaterThan(2);
    expect(JSON.stringify(r.data)).not.toContain(APP_SECRET);
  });

  it('a provider that is off, or half set up, cannot be connected, and says why', async () => {
    const s = await login('conn-off');
    const off = await call(admin, 'PUT', '/api/connections/admin/apps/microsoft', { enabled: false });
    expect(off.statusCode).toBe(200);
    try {
      const providers = (await call<{ provider: string; ready: boolean; reason: string | null }[]>(s, 'GET', '/api/connections/providers')).data;
      expect(providers.find((p) => p.provider === 'microsoft')).toMatchObject({ ready: false, reason: 'disabled' });
      const r = await call(s, 'POST', '/api/connections/authorize', { provider: 'microsoft', capabilities: ['mail_read'] });
      expect([r.statusCode, r.code, r.details]).toEqual([409, 'CONNECTION_PROVIDER_UNAVAILABLE', { reason: 'disabled' }]);
    } finally {
      await call(admin, 'PUT', '/api/connections/admin/apps/microsoft', { enabled: true });
    }
  });

  it('only an administrator reaches the app routes, and they never reach a user\'s connections', async () => {
    const s = await login('conn-nonadmin');
    for (const [m, u] of [['GET', '/api/connections/admin/apps'], ['PUT', '/api/connections/admin/apps/google'], ['DELETE', '/api/connections/admin/apps/google']] as const) {
      expect((await call(s, m, u, m === 'PUT' ? { enabled: true } : undefined)).statusCode).toBe(403);
    }
    expect((await app.inject({ method: 'GET', url: '/api/connections/admin/apps' })).statusCode).toBe(401);
    // an administrator is not an owner of other people's accounts
    const owner = await connected('conn-adm-owner');
    expect((await call(admin, 'GET', `/api/connections/${owner.id}`)).statusCode).toBe(404);
  });
});

describe('connecting accounts', () => {
  it('connects an account: the flow, the row, the tokens encrypted, the redirect that names the outcome only', async () => {
    const s = await login('conn-first');
    const r = await connect(s, google, A, { capabilities: ['mail_read', 'mail_send', 'calendar_read'], label: 'Work' });
    expect(r.res.statusCode).toBe(302);
    expect(r.location).toMatch(/^\/settings\/connections\?connect=connected&connection=[0-9a-f-]{36}$/);
    expect(r.res.headers['referrer-policy']).toBe('no-referrer');
    // The scopes asked for are the least the capabilities need.
    expect(new URL(google.authorizeCalls.at(-1)!.url).searchParams.get('scope')!.split(' ').sort()).toEqual(['fake:calendar.read', 'fake:mail.read', 'fake:mail.send']);
    const id = connectionId(r.location);
    const row = await rowOf(id);
    expect(row).toMatchObject({ provider: 'google', accountId: 'acct-a', accountEmail: A.email, label: 'Work', status: 'active', defaultFor: [], userId: s.userId });
    expect(row.capabilities.sort()).toEqual(['calendar_read', 'mail_read', 'mail_send']);
    // Tokens are in the credential store, encrypted, and nowhere in the row.
    const refresh = (await store.refreshToken(s.userId, id))!;
    const access = (await store.accessToken(s.userId, id))!;
    expect(refresh).toContain('MARKER-google-refresh');
    expect(access).toContain('MARKER-google-access');
    const stored = await prisma.userCredential.findMany({ where: { userId: s.userId, purpose: 'connection_token' } });
    expect(stored.length).toBe(2);
    for (const c of stored) {
      expect(c.secret).not.toContain('MARKER');
      expect(c.secret).not.toContain(refresh);
    }
    expect(JSON.stringify(row)).not.toContain('MARKER');
    // The verifier is gone with the flow, and the flow is consumed.
    expect(await prisma.connectionFlow.count({ where: { userId: s.userId } })).toBe(0);
    const [view] = await list(s);
    expect(view).toMatchObject({ label: 'Work', provider: 'google', status: 'active', capabilities: ['mail_read', 'mail_send', 'calendar_read'], defaultFor: [] });
    expect(await prisma.auditEvent.count({ where: { actorUserId: s.userId, action: 'connection.created' } })).toBe(1);
  });

  it('a write capability brings its read capability, and an unnamed account gets a label from the provider and the account', async () => {
    const s = await login('conn-closure');
    const r = await connect(s, google, A, { capabilities: ['docs_write'] });
    const [view] = await list(s);
    expect(view!.capabilities).toEqual(['docs_read', 'docs_write']);
    expect(view!.label).toBe('Google (person.a@example.test)');
    expect(connectionId(r.location)).toBe(view!.id);
  });

  it('a second account of the same provider is a second connection; connecting the first again updates it, with no duplicate', async () => {
    const s = await login('conn-two');
    const first = await connect(s, google, A, { capabilities: ['mail_read'], label: 'Work' });
    const second = await connect(s, google, B, { capabilities: ['mail_read'], label: 'Personal' });
    expect(connectionId(first.location)).not.toBe(connectionId(second.location));
    expect((await list(s)).map((c) => c.label).sort()).toEqual(['Personal', 'Work']);
    // Reconnect account A (the Reconnect button: the account as login hint) with one more capability.
    const again = await connect(s, google, A, { capabilities: ['mail_read', 'calendar_read'], loginHint: A.email });
    expect(connectionId(again.location)).toBe(connectionId(first.location));
    const views = await list(s);
    expect(views).toHaveLength(2);
    expect(views.find((c) => c.label === 'Work')!.capabilities).toEqual(['mail_read', 'calendar_read']);
    expect(await prisma.auditEvent.count({ where: { actorUserId: s.userId, action: 'connection.updated' } })).toBeGreaterThanOrEqual(1);
    // The same account at another provider is another connection; one owner can have both.
    await connect(s, microsoft, M, { capabilities: ['calendar_read'], label: 'Outlook' });
    expect(await list(s)).toHaveLength(3);
  });

  it('fewer permissions than asked: those capabilities are off and the redirect says which', async () => {
    const s = await login('conn-fewer');
    const r = await connect(s, google, A, { capabilities: ['mail_read', 'mail_send', 'calendar_read'] }, { deny: [fakeScopeOf('mail_send'), fakeScopeOf('calendar_read')] });
    expect(r.location).toContain('connect=connected');
    expect(r.location).toContain('missing=mail_send,calendar_read');
    const [view] = await list(s);
    expect(view!.capabilities).toEqual(['mail_read']);
    expect(view!.granted).toEqual(['mail_read']);
  });

  it('a write granted without its read is not switched on', async () => {
    const s = await login('conn-write-only');
    const r = await connect(s, google, A, { capabilities: ['mail_send'] }, { deny: [fakeScopeOf('mail_read')] });
    expect(r.location).toContain('connect=nothing_granted');
    expect(await list(s)).toEqual([]);
    expect(google.revoked.length).toBeGreaterThan(0);
  });

  it('a label is unique ignoring case, and an unnamed second flow never collides', async () => {
    const s = await login('conn-labels');
    await connect(s, google, A, { label: 'Work' });
    const taken = await call(s, 'POST', '/api/connections/authorize', { provider: 'google', capabilities: ['mail_read'], label: 'work' });
    expect([taken.statusCode, taken.code]).toEqual([409, 'CONNECTION_LABEL_TAKEN']);
    // the same name for the account that holds it is a reconnect, not a conflict
    const ok = await call(s, 'POST', '/api/connections/authorize', { provider: 'google', capabilities: ['mail_read'], label: 'work', loginHint: A.email });
    expect(ok.statusCode).toBe(200);
    // two accounts, no label given: both get names
    await connect(s, google, B);
    expect((await list(s)).map((c) => c.label).sort()).toEqual(['Google (person.b@example.test)', 'Work']);
    // rename
    const target = (await list(s)).find((c) => c.label === 'Work')!;
    const clash = await call(s, 'PATCH', `/api/connections/${target.id}`, { label: 'google (PERSON.B@example.test)' });
    expect([clash.statusCode, clash.code]).toEqual([409, 'CONNECTION_LABEL_TAKEN']);
    const renamed = await call<{ connection: View }>(s, 'PATCH', `/api/connections/${target.id}`, { label: '  Office  ' });
    expect(renamed.data.connection.label).toBe('Office');
  });

  it('no refresh token at all is refused, but a reconnect may reuse the one already stored', async () => {
    const s = await login('conn-norefresh');
    const refused = await connect(s, google, A, {}, { noRefreshToken: true });
    expect(refused.location).toContain('connect=no_refresh_token');
    expect(await list(s)).toEqual([]);
    const ok = await connect(s, google, A, {});
    const id = connectionId(ok.location);
    const before = (await store.refreshToken(s.userId, id))!;
    const second = await connect(s, google, A, { capabilities: ['mail_read', 'calendar_read'], loginHint: A.email }, { noRefreshToken: true });
    expect(second.location).toContain('connect=connected');
    expect(await store.refreshToken(s.userId, id)).toBe(before);
  });

  it('the provider answering with an error, or the owner saying no, is a closed outcome', async () => {
    const s = await login('conn-denied');
    const start = await call<{ authorizeUrl: string }>(s, 'POST', '/api/connections/authorize', { provider: 'google', capabilities: ['mail_read'] });
    const state = new URL(start.data.authorizeUrl).searchParams.get('state')!;
    const res = await callback('google', { error: 'access_denied', state, error_description: 'MARKER-provider-text' }, cookieOf(start.headers['set-cookie']));
    expect(String(res.headers.location)).toBe('/settings/connections?connect=denied');
    expect(await list(s)).toEqual([]);
    expect(await prisma.connectionFlow.count({ where: { userId: s.userId } })).toBe(0);
  });
});

describe('state, PKCE and the browser binding', () => {
  it('a wrong state is refused and changes nothing', async () => {
    const s = await login('conn-state-wrong');
    const start = await call<{ authorizeUrl: string }>(s, 'POST', '/api/connections/authorize', { provider: 'google', capabilities: ['mail_read'] });
    const { code } = google.consent(start.data.authorizeUrl, A);
    const res = await callback('google', { code, state: 'not-the-state' }, cookieOf(start.headers['set-cookie']));
    expect(String(res.headers.location)).toBe('/settings/connections?connect=state_invalid');
    expect(await list(s)).toEqual([]);
    expect(google.exchangeCalls.some((c) => c.code === code)).toBe(false);
  });

  it('a state is used once: replaying the callback is refused', async () => {
    const s = await login('conn-state-reuse');
    const r = await connect(s, google, A);
    expect(r.location).toContain('connect=connected');
    const replay = await callback('google', { code: r.code, state: r.state }, r.cookie);
    expect(String(replay.headers.location)).toBe('/settings/connections?connect=state_invalid');
    expect(await list(s)).toHaveLength(1);
  });

  it('an expired flow is refused, and its verifier is deleted', async () => {
    const s = await login('conn-state-expired');
    const start = await call<{ authorizeUrl: string }>(s, 'POST', '/api/connections/authorize', { provider: 'google', capabilities: ['mail_read'] });
    const { code, state } = google.consent(start.data.authorizeUrl, A);
    await prisma.connectionFlow.updateMany({ where: { userId: s.userId }, data: { expiresAt: new Date(Date.now() - 1000) } });
    const res = await callback('google', { code, state }, cookieOf(start.headers['set-cookie']));
    expect(String(res.headers.location)).toBe('/settings/connections?connect=expired');
    expect(await list(s)).toEqual([]);
    expect(await prisma.connectionFlow.count({ where: { userId: s.userId } })).toBe(0);
    expect(await prisma.userCredential.count({ where: { userId: s.userId, purpose: 'connection_token' } })).toBe(0);
  });

  it('the callback of another browser (another user\'s session, or none) is refused, and the owner can still finish', async () => {
    const s = await login('conn-bind-owner');
    const other = await login('conn-bind-other');
    const start = await call<{ authorizeUrl: string }>(s, 'POST', '/api/connections/authorize', { provider: 'google', capabilities: ['mail_read'] });
    const otherStart = await call<{ authorizeUrl: string }>(other, 'POST', '/api/connections/authorize', { provider: 'google', capabilities: ['mail_read'] });
    const { code, state } = google.consent(start.data.authorizeUrl, A);
    const mine = cookieOf(start.headers['set-cookie']);
    const theirs = cookieOf(otherStart.headers['set-cookie']);
    // The other user's cookie (named for THEIR flow) cannot complete this state; neither can no cookie, nor a guessed value.
    for (const cookie of [null, { name: mine.name, value: theirs.value }, { name: theirs.name, value: theirs.value }, { name: mine.name, value: 'guess' }]) {
      const res = await callback('google', { code, state }, cookie);
      expect(String(res.headers.location)).toBe('/settings/connections?connect=binding_invalid');
    }
    expect(await list(s)).toEqual([]);
    expect(await list(other)).toEqual([]);
    // The right browser still can.
    const ok = await callback('google', { code, state }, mine);
    expect(String(ok.headers.location)).toContain('connect=connected');
    expect(await list(s)).toHaveLength(1);
    expect(await list(other)).toEqual([]);
  });

  it('a state is bound to its provider, and the verifier is checked by the provider (PKCE)', async () => {
    const s = await login('conn-pkce');
    const start = await call<{ authorizeUrl: string }>(s, 'POST', '/api/connections/authorize', { provider: 'google', capabilities: ['mail_read'] });
    const url = new URL(start.data.authorizeUrl);
    expect(url.searchParams.get('code_challenge_method')).toBe('S256');
    expect(url.searchParams.get('code_challenge')).toMatch(/^[A-Za-z0-9_-]{43}$/);
    const { code, state } = google.consent(start.data.authorizeUrl, A);
    const cookie = cookieOf(start.headers['set-cookie']);
    expect(cookie.name).toBe(bindingCookieName(state));
    const wrong = await callback('microsoft', { code, state }, cookie);
    expect(String(wrong.headers.location)).toBe('/settings/connections?connect=state_invalid');
    // that attempt consumed the flow; a fresh one proves the verifier travels: the fake rejects a mismatch
    const s2 = await login('conn-pkce2');
    const start2 = await call<{ authorizeUrl: string }>(s2, 'POST', '/api/connections/authorize', { provider: 'google', capabilities: ['mail_read'] });
    const { code: code2, state: state2 } = google.consent(start2.data.authorizeUrl, A);
    await prisma.connectionFlow.deleteMany({ where: { userId: s2.userId } });
    await prisma.userCredential.deleteMany({ where: { userId: s2.userId, purpose: 'connection_token' } });
    const gone = await callback('google', { code: code2, state: state2 }, cookieOf(start2.headers['set-cookie']));
    expect(String(gone.headers.location)).toBe('/settings/connections?connect=state_invalid');
  });

  it('the return page is always a path on this console', async () => {
    const s = await login('conn-return');
    const start = await call<{ authorizeUrl: string }>(s, 'POST', '/api/connections/authorize', { provider: 'google', capabilities: ['mail_read'], returnTo: 'https://evil.example.test/steal' });
    const { code, state } = google.consent(start.data.authorizeUrl, A);
    const res = await callback('google', { code, state }, cookieOf(start.headers['set-cookie']));
    expect(String(res.headers.location)).toMatch(/^\/settings\/connections\?connect=connected/);
    const ok = await call<{ authorizeUrl: string }>(s, 'POST', '/api/connections/authorize', { provider: 'google', capabilities: ['mail_read'], returnTo: '/chat/new', loginHint: A.email });
    const c2 = google.consent(ok.data.authorizeUrl, A);
    const res2 = await callback('google', { code: c2.code, state: c2.state }, cookieOf(ok.headers['set-cookie']));
    expect(String(res2.headers.location)).toMatch(/^\/chat\/new\?connect=connected/);
  });
});

describe('changing what an account can do', () => {
  it('turning a capability off is immediate and local; the permission stays granted', async () => {
    const { s, id } = await connected('conn-off-cap', google, A, ['mail_read', 'mail_send', 'calendar_read']);
    google.revoked.length = 0;
    const r = await call<{ connection: View; consent: unknown }>(s, 'PATCH', `/api/connections/${id}`, { capabilities: ['mail_read'] });
    expect(r.statusCode).toBe(200);
    expect(r.data.consent).toBeNull();
    expect(r.data.connection.capabilities).toEqual(['mail_read']);
    expect(r.data.connection.granted).toEqual(['mail_read', 'mail_send', 'calendar_read']);
    expect(google.revoked).toEqual([]);
    // switching one back on that is still granted needs no consent
    const back = await call<{ connection: View; consent: unknown }>(s, 'PATCH', `/api/connections/${id}`, { capabilities: ['mail_read', 'calendar_read'] });
    expect(back.data.consent).toBeNull();
    expect(back.data.connection.capabilities).toEqual(['mail_read', 'calendar_read']);
  });

  it('adding a capability the provider has not granted starts an incremental consent for just the extra permissions, with the account as the login hint', async () => {
    const { s, id } = await connected('conn-incr', google, A, ['mail_read']);
    const r = await call<{ connection: View; consent: { authorizeUrl: string } | null }>(s, 'PATCH', `/api/connections/${id}`, { capabilities: ['mail_read', 'docs_read'], returnTo: '/settings/connections' });
    expect(r.statusCode).toBe(200);
    expect(r.data.consent).not.toBeNull();
    // not on yet: the switch comes on when the consent returns
    expect(r.data.connection.capabilities).toEqual(['mail_read']);
    const url = new URL(r.data.consent!.authorizeUrl);
    expect(url.searchParams.get('scope')).toBe(fakeScopeOf('docs_read'));
    expect(url.searchParams.get('login_hint')).toBe(A.email);
    expect(google.authorizeCalls.at(-1)).toMatchObject({ incremental: true });
    const { code, state } = google.consent(r.data.consent!.authorizeUrl, A, { noRefreshToken: true });
    const res = await callback('google', { code, state }, cookieOf(r.headers['set-cookie']));
    expect(String(res.headers.location)).toBe(`/settings/connections?connect=connected&connection=${id}`);
    const view = (await list(s)).find((c) => c.id === id)!;
    expect(view.capabilities).toEqual(['mail_read', 'docs_read']);
    expect(view.granted).toEqual(['mail_read', 'docs_read']);
  });

  it('an incremental consent signed in as a different account is refused and grafts nothing', async () => {
    const { s, id } = await connected('conn-incr-other', google, A, ['mail_read']);
    const r = await call<{ consent: { authorizeUrl: string } }>(s, 'PATCH', `/api/connections/${id}`, { capabilities: ['mail_read', 'calendar_read'] });
    const { code, state } = google.consent(r.data.consent.authorizeUrl, B);
    const res = await callback('google', { code, state }, cookieOf(r.headers['set-cookie']));
    expect(String(res.headers.location)).toContain('connect=account_mismatch');
    expect((await list(s)).find((c) => c.id === id)!.capabilities).toEqual(['mail_read']);
    expect(await list(s)).toHaveLength(1);
  });

  it('unticking the new permission at the consent leaves the switch off', async () => {
    const { s, id } = await connected('conn-incr-deny', google, A, ['mail_read']);
    const r = await call<{ consent: { authorizeUrl: string } }>(s, 'PATCH', `/api/connections/${id}`, { capabilities: ['mail_read', 'calendar_read'] });
    const { code, state } = google.consent(r.data.consent.authorizeUrl, A, { deny: [fakeScopeOf('calendar_read')], noRefreshToken: true });
    const res = await callback('google', { code, state }, cookieOf(r.headers['set-cookie']));
    expect(String(res.headers.location)).toContain('missing=calendar_read');
    expect((await list(s)).find((c) => c.id === id)!.capabilities).toEqual(['mail_read']);
  });
});

describe('defaults', () => {
  it('at most one default per provider and group: the second claim takes it from the first', async () => {
    const s = await login('conn-default');
    const a = connectionId((await connect(s, google, A, { capabilities: ['mail_read', 'calendar_read'], label: 'Work' })).location);
    const b = connectionId((await connect(s, google, B, { capabilities: ['mail_read'], label: 'Personal' })).location);
    expect((await call<{ connection: View }>(s, 'PATCH', `/api/connections/${a}`, { defaultFor: ['mail', 'calendar'] })).data.connection.defaultFor).toEqual(['mail', 'calendar']);
    expect((await call<{ connection: View }>(s, 'PATCH', `/api/connections/${b}`, { defaultFor: ['mail'] })).data.connection.defaultFor).toEqual(['mail']);
    const views = await list(s);
    expect(views.find((c) => c.id === a)!.defaultFor).toEqual(['calendar']);
    expect(views.find((c) => c.id === b)!.defaultFor).toEqual(['mail']);
    // a default needs a capability of its group switched on
    const bad = await call(s, 'PATCH', `/api/connections/${b}`, { defaultFor: ['mail', 'docs'] });
    expect([bad.statusCode, bad.code]).toEqual([422, 'CONNECTION_DEFAULT_NEEDS_CAPABILITY']);
    // turning the group off drops the default
    const off = await call<{ connection: View }>(s, 'PATCH', `/api/connections/${a}`, { capabilities: ['mail_read'] });
    expect(off.data.connection.defaultFor).toEqual([]);
    // another provider has its own defaults
    const m = connectionId((await connect(s, microsoft, M, { capabilities: ['mail_read'], label: 'Outlook' })).location);
    expect((await call<{ connection: View }>(s, 'PATCH', `/api/connections/${m}`, { defaultFor: ['mail'] })).data.connection.defaultFor).toEqual(['mail']);
    expect((await list(s)).find((c) => c.id === b)!.defaultFor).toEqual(['mail']);
  });

  it('the database enforces it too: a second claim in the same provider and group is refused', async () => {
    const s = await login('conn-default-db');
    const a = connectionId((await connect(s, google, A, { label: 'Work' })).location);
    const b = connectionId((await connect(s, google, B, { label: 'Personal' })).location);
    await prisma.connection.update({ where: { id: a }, data: { defaultFor: ['mail'] } });
    await expect(prisma.connection.update({ where: { id: b }, data: { defaultFor: ['mail', 'docs'] } })).rejects.toThrow(/default for this provider and capability group already exists|unique/i);
    // a different group, or a different provider, is fine
    await prisma.connection.update({ where: { id: b }, data: { defaultFor: ['docs'] } });
    const m = connectionId((await connect(s, microsoft, M, { label: 'Outlook' })).location);
    await prisma.connection.update({ where: { id: m }, data: { defaultFor: ['mail'] } });
  });

  it('two writers claiming the same default at once leave exactly one', async () => {
    const s = await login('conn-default-race');
    const a = connectionId((await connect(s, google, A, { label: 'Work' })).location);
    const b = connectionId((await connect(s, google, B, { label: 'Personal' })).location);
    const results = await Promise.all([a, b].map((id) => call(s, 'PATCH', `/api/connections/${id}`, { defaultFor: ['mail'] })));
    expect(results.map((r) => r.statusCode)).toEqual([200, 200]);
    const defaults = (await list(s)).filter((c) => c.defaultFor.includes('mail'));
    expect(defaults).toHaveLength(1);
  });
});

describe('resolveConnection', () => {
  it('an explicit id or label wins; a label is matched ignoring case', async () => {
    const s = await login('conn-resolve-explicit');
    const a = connectionId((await connect(s, google, A, { capabilities: ['mail_read'], label: 'Work' })).location);
    const b = connectionId((await connect(s, google, B, { capabilities: ['mail_read'], label: 'Personal' })).location);
    await call(s, 'PATCH', `/api/connections/${a}`, { defaultFor: ['mail'] });
    expect((await resolver.resolveConnection(s.userId, { capability: 'mail_read', connectionId: b })).label).toBe('Personal');
    expect((await resolver.resolveConnection(s.userId, { capability: 'mail_read', label: 'PERSONAL' })).id).toBe(b);
    await expect(resolver.resolveConnection(s.userId, { capability: 'mail_read', label: 'Nobody' })).rejects.toMatchObject({ code: 'CONNECTION_NOT_FOUND' });
    // the capability must be on for the named account
    await expect(resolver.resolveConnection(s.userId, { capability: 'calendar_read', label: 'Work' })).rejects.toMatchObject({ code: 'CONNECTION_CAPABILITY_OFF', details: { label: 'Work', capability: 'calendar_read' } });
    // another user's id is not found
    const other = await login('conn-resolve-other');
    await expect(resolver.resolveConnection(other.userId, { capability: 'mail_read', connectionId: a })).rejects.toMatchObject({ code: 'CONNECTION_NOT_FOUND' });
  });

  it('otherwise the default; otherwise the single candidate; otherwise ambiguous with the labels; otherwise none', async () => {
    const s = await login('conn-resolve-rules');
    await expect(resolver.resolveConnection(s.userId, { capability: 'mail_read' })).rejects.toMatchObject({ code: 'CONNECTION_NONE' });
    const a = connectionId((await connect(s, google, A, { capabilities: ['mail_read'], label: 'Work' })).location);
    // exactly one candidate
    expect((await resolver.resolveConnection(s.userId, { capability: 'mail_read' })).id).toBe(a);
    await expect(resolver.resolveConnection(s.userId, { capability: 'calendar_read' })).rejects.toMatchObject({ code: 'CONNECTION_NONE' });
    const b = connectionId((await connect(s, google, B, { capabilities: ['mail_read'], label: 'Personal' })).location);
    // two candidates, no default: ask
    const err = await resolver.resolveConnection(s.userId, { capability: 'mail_read' }).catch((e) => e);
    expect(err).toMatchObject({ code: 'CONNECTION_AMBIGUOUS', details: { candidates: ['Personal', 'Work'] } });
    // a default decides
    await call(s, 'PATCH', `/api/connections/${b}`, { defaultFor: ['mail'] });
    expect((await resolver.resolveConnection(s.userId, { capability: 'mail_read' })).id).toBe(b);
    // an explicit one still beats the default
    expect((await resolver.resolveConnection(s.userId, { capability: 'mail_read', label: 'work' })).id).toBe(a);
    // a provider filter narrows the candidates
    const m = connectionId((await connect(s, microsoft, M, { capabilities: ['mail_read'], label: 'Outlook' })).location);
    expect((await resolver.resolveConnection(s.userId, { provider: 'microsoft', capability: 'mail_read' })).id).toBe(m);
    // the result carries no token
    expect(Object.keys(await resolver.resolveConnection(s.userId, { capability: 'mail_read' })).sort()).toEqual(['accountEmail', 'capabilities', 'id', 'label', 'provider']);
  });

  it('a paused or needs_reconnect connection is never chosen', async () => {
    const s = await login('conn-resolve-states');
    const a = connectionId((await connect(s, google, A, { capabilities: ['mail_read'], label: 'Work' })).location);
    const b = connectionId((await connect(s, google, B, { capabilities: ['mail_read'], label: 'Personal' })).location);
    // paused: the other one is the single active candidate
    await call(s, 'POST', `/api/connections/${a}/pause`);
    expect((await resolver.resolveConnection(s.userId, { capability: 'mail_read' })).id).toBe(b);
    // naming a paused one fails, typed
    await expect(resolver.resolveConnection(s.userId, { capability: 'mail_read', label: 'Work' })).rejects.toMatchObject({ code: 'CONNECTION_PAUSED', details: { label: 'Work' } });
    // needs_reconnect: same
    await prisma.connection.update({ where: { id: b }, data: { status: 'needs_reconnect', statusReason: 'GRANT_REVOKED' } });
    const none = await resolver.resolveConnection(s.userId, { capability: 'mail_read' }).catch((e) => e);
    expect(none).toMatchObject({ code: 'CONNECTION_NONE' });
    expect((none.details as { unavailable: unknown[] }).unavailable).toEqual(expect.arrayContaining([{ label: 'Work', status: 'paused' }, { label: 'Personal', status: 'needs_reconnect' }]));
    await expect(resolver.resolveConnection(s.userId, { capability: 'mail_read', connectionId: b })).rejects.toMatchObject({ code: 'CONNECTION_NEEDS_RECONNECT' });
    // a default that cannot be used is an error naming it, never a silent switch to the other account
    await prisma.connection.update({ where: { id: a }, data: { status: 'active', defaultFor: ['mail'] } });
    await prisma.connection.update({ where: { id: b }, data: { status: 'active' } });
    await prisma.connection.update({ where: { id: a }, data: { status: 'paused' } });
    await expect(resolver.resolveConnection(s.userId, { capability: 'mail_read' })).rejects.toMatchObject({ code: 'CONNECTION_PAUSED', details: { label: 'Work' } });
  });
});

describe('pause, resume and test', () => {
  it('a paused connection is not used by anything, and resumes', async () => {
    const { s, id } = await connected('conn-pause');
    const paused = await call<View>(s, 'POST', `/api/connections/${id}/pause`);
    expect(paused.data.status).toBe('paused');
    expect((await call<View>(s, 'POST', `/api/connections/${id}/pause`)).statusCode).toBe(200); // idempotent
    await expect(tokens.getAccessToken(id, s.userId)).rejects.toMatchObject({ code: 'CONNECTION_PAUSED' });
    const t = await call(s, 'POST', `/api/connections/${id}/test`);
    expect([t.statusCode, t.code]).toEqual([409, 'CONNECTION_PAUSED']);
    const resumed = await call<View>(s, 'POST', `/api/connections/${id}/resume`);
    expect(resumed.data.status).toBe('active');
    await expect(tokens.getAccessToken(id, s.userId)).resolves.toContain('MARKER-google-access');
    expect(await prisma.auditEvent.count({ where: { actorUserId: s.userId, action: { in: ['connection.paused', 'connection.resumed'] } } })).toBe(2);
    // a connection that needs reconnecting cannot be paused or resumed
    await prisma.connection.update({ where: { id }, data: { status: 'needs_reconnect' } });
    for (const a of ['pause', 'resume']) expect((await call(s, 'POST', `/api/connections/${id}/${a}`)).code).toBe('CONNECTION_NEEDS_RECONNECT');
  });

  it('tests each capability that is on with one cheap call, and reports a failure with a reason code', async () => {
    const { s, id } = await connected('conn-test', google, A, ['mail_read', 'mail_send', 'calendar_read']);
    google.probes.length = 0;
    const ok = await call<{ results: { capability: string; ok: boolean; code: string | null }[] }>(s, 'POST', `/api/connections/${id}/test`);
    expect(ok.statusCode).toBe(200);
    expect(ok.data.results).toEqual([
      { capability: 'mail_read', ok: true, code: null },
      { capability: 'mail_send', ok: true, code: null },
      { capability: 'calendar_read', ok: true, code: null },
    ]);
    expect(google.probes).toEqual(['mail_read', 'mail_send', 'calendar_read']);
    google.probeFails = { calendar_read: 'FORBIDDEN', mail_send: 'a message that could carry data: hunter2' };
    try {
      const bad = await call<{ results: { capability: string; ok: boolean; code: string | null }[] }>(s, 'POST', `/api/connections/${id}/test`);
      expect(bad.data.results.filter((r) => !r.ok)).toEqual([
        { capability: 'mail_send', ok: false, code: 'UNKNOWN' },
        { capability: 'calendar_read', ok: false, code: 'FORBIDDEN' },
      ]);
    } finally {
      google.probeFails = {};
    }
  });
});

describe('the token service', () => {
  it('returns the cached access token while it is good, and refreshes within two minutes of its expiry', async () => {
    const { s, id } = await connected('conn-tok-fresh');
    const cached = (await store.accessToken(s.userId, id))!;
    const before = google.refreshCalls.length;
    expect(await tokens.getAccessToken(id, s.userId)).toBe(cached);
    expect(google.refreshCalls.length).toBe(before);
    await expireAccess(id, new Date(Date.now() + 90_000)); // under two minutes left
    const next = await tokens.getAccessToken(id, s.userId);
    expect(next).not.toBe(cached);
    expect(google.refreshCalls.length).toBe(before + 1);
    expect(await store.accessToken(s.userId, id)).toBe(next);
    expect((await rowOf(id)).accessExpiresAt!.getTime()).toBeGreaterThan(Date.now() + 10 * 60_000);
    expect((await rowOf(id)).lastRefreshAt).not.toBeNull();
    // beyond two minutes it is not refreshed
    await expireAccess(id, new Date(Date.now() + 5 * 60_000));
    expect(await tokens.getAccessToken(id, s.userId)).toBe(next);
    expect(google.refreshCalls.length).toBe(before + 1);
  });

  it('concurrent callers trigger ONE refresh, in one process and across two service instances', async () => {
    const { s, id } = await connected('conn-tok-concurrent');
    await expireAccess(id);
    google.refreshDelayMs = 120;
    const before = google.refreshCalls.length;
    try {
      const got = await Promise.all(Array.from({ length: 12 }, () => tokens.getAccessToken(id, s.userId)));
      expect(new Set(got).size).toBe(1);
      expect(google.refreshCalls.length).toBe(before + 1);
      // two instances (two API processes): the database lease lets one refresh and the other waits for its result
      await expireAccess(id);
      const second = new ConnectionTokensService(prisma, store, app.get(ConnectionProviderRegistry, { strict: false }), app.get(ConnectionApps, { strict: false }), app.get(ConnectionEvents, { strict: false }));
      const both = await Promise.all([tokens.getAccessToken(id, s.userId), second.getAccessToken(id, s.userId)]);
      expect(both[0]).toBe(both[1]);
      expect(google.refreshCalls.length).toBe(before + 2);
    } finally {
      google.refreshDelayMs = 0;
    }
  });

  it('stores a rotated refresh token before the old one is dropped, and never presents a retired one again', async () => {
    const { s, id } = await connected('conn-tok-rotate');
    const first = (await store.refreshToken(s.userId, id))!;
    for (let i = 0; i < 3; i++) {
      await expireAccess(id);
      await tokens.getAccessToken(id, s.userId);
    }
    const now = (await store.refreshToken(s.userId, id))!;
    expect(now).not.toBe(first);
    // every refresh presented the token the previous one returned: no replay
    const mine = google.refreshCalls.slice(-3).map((c) => c.refreshToken);
    expect(new Set(mine).size).toBe(3);
    expect(mine[0]).toBe(first);
    expect(google.liveRefreshTokens()).toContain(now);
    expect(google.liveRefreshTokens()).not.toContain(first);
    // a provider that does not rotate keeps the stored token
    google.rotate = false;
    try {
      await expireAccess(id);
      await tokens.getAccessToken(id, s.userId);
      expect(await store.refreshToken(s.userId, id)).toBe(now);
    } finally {
      google.rotate = true;
    }
  });

  it('a failure to store the rotated refresh token needs_reconnect rather than carrying on with a retired one', async () => {
    const { s, id } = await connected('conn-tok-storefail');
    await expireAccess(id);
    const spy = jest.spyOn(store, 'setRefreshToken').mockRejectedValueOnce(new Error('disk full'));
    try {
      await expect(tokens.getAccessToken(id, s.userId)).rejects.toMatchObject({ code: 'CONNECTION_NEEDS_RECONNECT', details: { reason: 'TOKEN_STORE_FAILED' } });
    } finally {
      spy.mockRestore();
    }
    expect(await rowOf(id)).toMatchObject({ status: 'needs_reconnect', statusReason: 'TOKEN_STORE_FAILED' });
  });

  it('an invalid grant sets needs_reconnect with a reason, deletes the tokens, notifies the owner ONCE and fails every caller with the typed error', async () => {
    const { s, id } = await connected('conn-tok-revoked');
    google.revokeAllGrants(); // the owner removed the app at Google, or changed the password
    await expireAccess(id);
    const results = await Promise.allSettled([tokens.getAccessToken(id, s.userId), tokens.getAccessToken(id, s.userId, { forceRefresh: true })]);
    for (const r of results) expect(r).toMatchObject({ status: 'rejected', reason: { code: 'CONNECTION_NEEDS_RECONNECT', details: { reason: 'GRANT_REVOKED', label: expect.any(String) } } });
    expect(await rowOf(id)).toMatchObject({ status: 'needs_reconnect', statusReason: 'GRANT_REVOKED', accessExpiresAt: null });
    expect(await prisma.userCredential.count({ where: { userId: s.userId, purpose: 'connection_token' } })).toBe(0);
    // later callers get the same answer without touching the provider, and the owner is not told again
    const calls = google.refreshCalls.length;
    await expect(tokens.getAccessToken(id, s.userId)).rejects.toMatchObject({ code: 'CONNECTION_NEEDS_RECONNECT' });
    expect(google.refreshCalls.length).toBe(calls);
    await Promise.all([tokens.markNeedsReconnect(s.userId, id, 'GRANT_REVOKED'), tokens.markNeedsReconnect(s.userId, id, 'UNAUTHORIZED')]);
    await flush();
    expect(await reconnectNotes(s.userId)).toBe(1);
    expect(await prisma.auditEvent.count({ where: { actorUserId: s.userId, action: 'connection.needs_reconnect' } })).toBe(1);
    // The list puts it first and says why, by code.
    const [view] = await list(s);
    expect(view).toMatchObject({ id, status: 'needs_reconnect', statusReason: 'GRANT_REVOKED' });
    // Reconnecting the same account clears it (and a later episode may notify again).
    const again = await connect(s, google, A, { capabilities: ['mail_read', 'mail_send'], loginHint: A.email });
    expect(connectionId(again.location)).toBe(id);
    expect(await rowOf(id)).toMatchObject({ status: 'active', statusReason: null, reconnectNotifiedAt: null });
    await expect(tokens.getAccessToken(id, s.userId)).resolves.toContain('MARKER-google-access');
  });

  it('a provider that cannot be reached changes nothing: the status stays and the caller is told to try again', async () => {
    const { s, id } = await connected('conn-tok-unavailable');
    await expireAccess(id);
    google.failRefresh = { kind: 'unavailable', times: 1 };
    await expect(tokens.getAccessToken(id, s.userId)).rejects.toMatchObject({ code: 'CONNECTION_UNAVAILABLE', status: 503 });
    expect(await rowOf(id)).toMatchObject({ status: 'active', statusReason: 'UNAVAILABLE' });
    await flush();
    expect(await reconnectNotes(s.userId)).toBe(0);
    // the app credentials being wrong is not the owner's to fix: no needs_reconnect either
    google.failRefresh = { kind: 'invalid_client', times: 1 };
    await expect(tokens.getAccessToken(id, s.userId)).rejects.toMatchObject({ code: 'CONNECTION_UNAVAILABLE' });
    expect((await rowOf(id)).status).toBe('active');
    // and the next call works
    await expect(tokens.getAccessToken(id, s.userId)).resolves.toContain('MARKER-google-access');
    expect((await rowOf(id)).statusReason).toBeNull();
  });

  it('another user\'s connection is not found', async () => {
    const { id } = await connected('conn-tok-owner');
    const other = await login('conn-tok-other');
    await expect(tokens.getAccessToken(id, other.userId)).rejects.toMatchObject({ code: 'CONNECTION_NOT_FOUND' });
  });
});

describe('the daily health job', () => {
  it('is a registered, server-only queue job with an execution profile, enqueued by an enqueue-only cron', async () => {
    const handler = app.get(JobHandlerRegistry).get(CONNECTIONS_HEALTH_JOB) as unknown as Record<string, unknown>;
    expect(handler).toBeDefined();
    expect(handler.profile).toEqual({ maxRuntimeMs: 10 * 60_000, maxAttempts: 1 });
    expect(handler.nodeResultSchema).toBeUndefined();
    expect(handler.persistNodeResult).toBeUndefined();
    const { id } = await connected('conn-health-cron');
    await prisma.connection.update({ where: { id }, data: { lastRefreshAt: new Date(Date.now() - 3 * 86_400_000) } });
    await prisma.job.deleteMany({ where: { type: CONNECTIONS_HEALTH_JOB } });
    await app.get(ConnectionsHealthTask, { strict: false }).handleCron();
    expect(await prisma.job.count({ where: { type: CONNECTIONS_HEALTH_JOB } })).toBe(1);
  });

  it('refreshes connections that were not used lately (paused ones too), leaves recent ones, and flags the ones that fail', async () => {
    const idle = await connected('conn-health-idle');
    const used = await connected('conn-health-used');
    const paused = await connected('conn-health-paused');
    const broken = await connected('conn-health-broken');
    const old = new Date(Date.now() - 3 * 86_400_000);
    for (const c of [idle, paused, broken]) await prisma.connection.update({ where: { id: c.id }, data: { lastRefreshAt: old, lastUsedAt: null } });
    await prisma.connection.update({ where: { id: paused.id }, data: { status: 'paused' } });
    await prisma.connection.update({ where: { id: used.id }, data: { lastRefreshAt: old, lastUsedAt: new Date() } });
    // the access token of the idle one is still good: the job refreshes anyway, so the REFRESH TOKEN is exercised
    const ids = (await app.get(ConnectionsHealth, { strict: false }).idle()).map((c) => c.id);
    expect(ids).toEqual(expect.arrayContaining([idle.id, paused.id, broken.id]));
    expect(ids).not.toContain(used.id);
    // one grant is gone at the provider
    const lost = (await store.refreshToken(broken.s.userId, broken.id))!;
    (google as unknown as { refreshTokens: Map<string, { live: boolean }> }).refreshTokens.get(lost)!.live = false;
    await app.get(ConnectionsHealthHandler, { strict: false }).process();
    expect((await rowOf(idle.id)).lastRefreshAt!.getTime()).toBeGreaterThan(old.getTime() + 86_400_000);
    expect((await rowOf(paused.id)).lastRefreshAt!.getTime()).toBeGreaterThan(old.getTime() + 86_400_000);
    expect((await rowOf(paused.id)).status).toBe('paused');
    expect((await rowOf(used.id)).lastRefreshAt!.getTime()).toBe(old.getTime());
    expect(await rowOf(broken.id)).toMatchObject({ status: 'needs_reconnect', statusReason: 'GRANT_REVOKED' });
    await flush();
    expect(await reconnectNotes(broken.s.userId)).toBe(1);
    expect(await reconnectNotes(idle.s.userId)).toBe(0);
  });

  it('removes flows that expired, with their verifiers', async () => {
    const s = await login('conn-health-flows');
    await call(s, 'POST', '/api/connections/authorize', { provider: 'google', capabilities: ['mail_read'] });
    expect(await prisma.userCredential.count({ where: { userId: s.userId, purpose: 'connection_token' } })).toBe(1);
    await prisma.connectionFlow.updateMany({ where: { userId: s.userId }, data: { expiresAt: new Date(Date.now() - 1000) } });
    expect(await flows.purgeExpired()).toBeGreaterThanOrEqual(1);
    expect(await prisma.connectionFlow.count({ where: { userId: s.userId } })).toBe(0);
    expect(await prisma.userCredential.count({ where: { userId: s.userId, purpose: 'connection_token' } })).toBe(0);
  });
});

describe('removing a connection', () => {
  it('revokes at the provider, clears the references, deletes the tokens and the row', async () => {
    const { s, id } = await connected('conn-remove');
    const refresh = (await store.refreshToken(s.userId, id))!;
    const cleared: string[] = [];
    const usage: ConnectionUsage[] = [{ kind: 'task', id: 'task-1', name: 'Pay the loan' }];
    app.get(ConnectionUsageRegistry, { strict: false }).register({ kind: 'task', list: async () => usage, clear: async (_u, c) => void cleared.push(c) });
    try {
      const detail = await call<View & { usedBy: ConnectionUsage[] }>(s, 'GET', `/api/connections/${id}`);
      expect(detail.data.usedBy).toEqual(usage);
      google.revoked.length = 0;
      const r = await call<{ revoked: boolean; clearedReferences: number }>(s, 'DELETE', `/api/connections/${id}`);
      expect(r.statusCode).toBe(200);
      expect(r.data).toEqual({ revoked: true, clearedReferences: 1 });
      expect(google.revoked.map((x) => x.token)).toContain(refresh);
      expect(cleared).toEqual([id]);
    } finally {
      app.get(ConnectionUsageRegistry, { strict: false }).unregister('task');
    }
    expect(await prisma.connection.count({ where: { id } })).toBe(0);
    expect(await prisma.userCredential.count({ where: { userId: s.userId, purpose: 'connection_token' } })).toBe(0);
    expect((await call(s, 'GET', `/api/connections/${id}`)).statusCode).toBe(404);
    expect(await prisma.auditEvent.count({ where: { actorUserId: s.userId, action: 'connection.removed' } })).toBe(1);
  });

  it('an unreachable provider is reported as not revoked, and the tokens are still deleted', async () => {
    const { s, id } = await connected('conn-remove-offline');
    const spy = jest.spyOn(google, 'revoke').mockRejectedValue(new Error('offline'));
    try {
      const r = await call<{ revoked: boolean }>(s, 'DELETE', `/api/connections/${id}`);
      expect(r.data.revoked).toBe(false);
    } finally {
      spy.mockRestore();
    }
    expect(await prisma.userCredential.count({ where: { userId: s.userId, purpose: 'connection_token' } })).toBe(0);
    expect(await prisma.connection.count({ where: { id } })).toBe(0);
  });

  it('deleting the user purges the connections, the flows and the tokens', async () => {
    const { s, id } = await connected('conn-delete-user');
    await call(s, 'POST', '/api/connections/authorize', { provider: 'google', capabilities: ['mail_read'], loginHint: A.email });
    expect(await prisma.connectionFlow.count({ where: { userId: s.userId } })).toBe(1);
    await prisma.user.delete({ where: { id: s.userId } });
    expect(await prisma.connection.count({ where: { id } })).toBe(0);
    expect(await prisma.connectionFlow.count({ where: { userId: s.userId } })).toBe(0);
    expect(await prisma.userCredential.count({ where: { userId: s.userId } })).toBe(0);
  });
});

describe('permissions and ownership', () => {
  it('another user\'s connection is 404 on every route', async () => {
    const owner = await connected('conn-own-a');
    const other = await login('conn-own-b');
    const id = owner.id;
    const routes: [('GET' | 'PATCH' | 'POST' | 'DELETE'), string, unknown?][] = [
      ['GET', `/api/connections/${id}`],
      ['PATCH', `/api/connections/${id}`, { label: 'Mine now' }],
      ['POST', `/api/connections/${id}/pause`],
      ['POST', `/api/connections/${id}/resume`],
      ['POST', `/api/connections/${id}/test`],
      ['DELETE', `/api/connections/${id}`],
    ];
    for (const [m, u, b] of routes) {
      const r = await call(other, m, u, b);
      expect([m, u.replace(id, ':id'), r.statusCode, r.code]).toEqual([m, u.replace(id, ':id'), 404, 'CONNECTION_NOT_FOUND']);
    }
    expect(await list(other)).toEqual([]);
    expect(await prisma.connection.count({ where: { id } })).toBe(1);
    expect((await rowOf(id)).label).not.toBe('Mine now');
  });

  it('a viewer has no access, and nothing works without a session; a malformed id is 400', async () => {
    const viewer = await login('conn-viewer', 'viewer');
    for (const [m, u] of [['GET', '/api/connections'], ['GET', '/api/connections/providers'], ['POST', '/api/connections/authorize']] as const) {
      expect((await call(viewer, m, u, m === 'POST' ? { provider: 'google', capabilities: ['mail_read'] } : undefined)).statusCode).toBe(403);
    }
    for (const u of ['/api/connections', '/api/connections/providers']) expect((await app.inject({ method: 'GET', url: u })).statusCode).toBe(401);
    expect((await app.inject({ method: 'POST', url: '/api/connections/authorize', payload: { provider: 'google', capabilities: ['mail_read'] } })).statusCode).toBe(401);
    const s = await login('conn-validate');
    expect((await call(s, 'GET', '/api/connections/not-a-uuid')).statusCode).toBe(400);
    expect((await call(s, 'POST', '/api/connections/authorize', { provider: 'mcp', capabilities: ['mail_read'] })).statusCode).toBe(400);
    expect((await call(s, 'POST', '/api/connections/authorize', { provider: 'google', capabilities: [] })).statusCode).toBe(400);
    expect((await call(s, 'POST', '/api/connections/authorize', { provider: 'google', capabilities: ['mail_everything'] })).statusCode).toBe(400);
    expect((await call(s, 'POST', '/api/connections/authorize', { provider: 'google', capabilities: ['mail_read'], extra: true })).statusCode).toBe(400);
  });
});

describe('no secret leaks (seeded markers)', () => {
  it('no token, app secret, verifier or authorization code is in any API response, audit event, notification, connection row or log line; tokens are encrypted at rest', async () => {
    const { s, id } = await connected('conn-marker', google, A, ['mail_read', 'mail_send']);
    await expireAccess(id);
    const access = await tokens.getAccessToken(id, s.userId);
    const refresh = (await store.refreshToken(s.userId, id))!;
    await call(s, 'GET', '/api/connections');
    await call(s, 'GET', `/api/connections/${id}`);
    await call(s, 'POST', `/api/connections/${id}/test`);
    await call(admin, 'GET', '/api/connections/admin/apps');
    // an episode that notifies
    google.revokeAllGrants();
    await expireAccess(id);
    await tokens.getAccessToken(id, s.userId).catch(() => undefined);
    await flush();
    await call(s, 'DELETE', `/api/connections/${id}`);
    const audit = JSON.stringify(await prisma.auditEvent.findMany({ where: { OR: [{ actorUserId: s.userId }, { actorUserId: admin.userId }] } }));
    const notes = JSON.stringify(await prisma.notification.findMany({ where: { userId: s.userId } }));
    const rows = JSON.stringify([...(await prisma.connection.findMany({ where: { userId: s.userId } })), ...(await prisma.connectionFlow.findMany({ where: { userId: s.userId } }))]);
    const everything = [responses.join('\n'), audit, notes, rows, logged.join('')];
    expect(notes).toContain('connections.needs_reconnect');
    const markers = [APP_SECRET, access, refresh, ...google.issued, ...microsoft.issued];
    expect(google.issued.length).toBeGreaterThan(10);
    for (const marker of markers) for (const place of everything) expect(place).not.toContain(marker);
    // at rest: every stored credential row is ciphertext (a seeded token is not readable in the database)
    const { s: s2, id: id2 } = await connected('conn-marker-rest');
    const plain = [(await store.refreshToken(s2.userId, id2))!, (await store.accessToken(s2.userId, id2))!];
    const rowsAtRest = JSON.stringify(await prisma.userCredential.findMany({ where: { userId: s2.userId } }));
    const appRows = JSON.stringify(await prisma.credential.findMany({ where: { purpose: { startsWith: 'connection_app_' } } }));
    for (const p of [...plain, APP_SECRET]) {
      expect(rowsAtRest).not.toContain(p);
      expect(appRows).not.toContain(p);
    }
    expect(appRows).toContain('connection_app_google');
  });
});
