// The Microsoft provider inside the running API against a real, migrated database and the in-process fake Graph (E39.4, #602):
// connecting a work and a personal account of one person (two connections, tokens never cross), the account id, rotation through the
// real token service, incremental consent, an administrator's approval told apart from a decline, the Test route, removal, the
// capability matrix on the providers route, and a marker scan of every response and log line for tokens and the app secret.
import { randomUUID } from 'node:crypto';
import type { NestFastifyApplication } from '@nestjs/platform-fastify';

import { CapabilityError } from '../../src/connections/capabilities';
import { CapabilityProviderRegistry } from '../../src/connections/capability-provider.registry';
import { COLUMNS_OF_PROVIDER, matrixRows } from '../../src/connections/capability-matrix';
import { ConnectionApps } from '../../src/connections/connection-apps.service';
import { ConnectionCapabilities } from '../../src/connections/connection-capabilities.service';
import { ConnectionProviderRegistry } from '../../src/connections/connection-provider.registry';
import { ConnectionTokenStore } from '../../src/connections/connection-token.store';
import { ConnectionTokensService } from '../../src/connections/connection-tokens.service';
import type { Capability } from '../../src/connections/connections.constants';
import { GraphClient } from '../../src/connections/microsoft/graph-client';
import { MicrosoftConnectionAdapter } from '../../src/connections/microsoft/microsoft.adapter';
import { CONSUMER_TENANT_ID } from '../../src/connections/microsoft/microsoft.constants';
import { MicrosoftCapabilityProvider } from '../../src/connections/microsoft/microsoft.provider';
import { FakeGraph, type FakeAccount } from '../../src/connections/microsoft/testing/fake-graph';
import { createApp } from '../../src/main';
import { PrismaService } from '../../src/prisma/prisma.service';

const savedKey = process.env.SECRETS_ENCRYPTION_KEY;
process.env.SECRETS_ENCRYPTION_KEY ||= Buffer.alloc(32, 7).toString('base64');
const stamp = `${Date.now()}`;
const APP_SECRET = 'fake-client-secret';

let app: NestFastifyApplication;
let prisma: PrismaService;
let fake: FakeGraph;
let admin: Session;
let capabilities: ConnectionCapabilities;
let tokens: ConnectionTokensService;
let store: ConnectionTokenStore;
let savedAdapter: unknown;
let savedProvider: unknown;
const seen: string[] = [];
const logged: string[] = [];

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
  seen.push(`${res.statusCode} ${JSON.stringify(res.headers)} ${res.body}`);
  const body = res.body ? (res.json() as { data?: T; error?: { code?: string }; code?: string }) : {};
  return { statusCode: res.statusCode, data: body.data as T, code: body.error?.code ?? body.code ?? '', headers: res.headers };
}

const cookieOf = (setCookie: unknown): { name: string; value: string } => {
  const raw = Array.isArray(setCookie) ? String(setCookie[0]) : String(setCookie);
  const m = /^(hx_conn_[a-f0-9]+)=([^;]*)/.exec(raw)!;
  return { name: m[1]!, value: m[2]! };
};

async function callback(query: Record<string, string>, cookie: { name: string; value: string }) {
  const res = await app.inject({ method: 'GET', url: `/api/connections/callback/microsoft?${new URLSearchParams(query)}`, headers: { cookie: `${cookie.name}=${cookie.value}` } });
  seen.push(`${res.statusCode} ${JSON.stringify(res.headers)} ${res.body}`);
  return String(res.headers.location);
}

/** The browser's half of a consent: sign in at Microsoft as `account`, tick or untick, come back with the cookie. */
async function consentAndReturn(authorizeUrl: string, cookie: { name: string; value: string }, account: FakeAccount, opts: { deny?: string[] } = {}) {
  const { code, state } = fake.consent(authorizeUrl, account, opts);
  return callback({ code, state }, cookie);
}

async function connect(s: Session, account: FakeAccount, body: { capabilities: Capability[]; label?: string; loginHint?: string }, opts: { deny?: string[] } = {}) {
  const start = await call<{ authorizeUrl: string }>(s, 'POST', '/api/connections/authorize', { provider: 'microsoft', ...body });
  expect(start.statusCode).toBe(200);
  const location = await consentAndReturn(start.data.authorizeUrl, cookieOf(start.headers['set-cookie']), account, opts);
  return { start, location, id: new URL(location, 'http://console.example.test').searchParams.get('connection')! };
}

beforeAll(async () => {
  const origOut = process.stdout.write.bind(process.stdout);
  jest.spyOn(process.stdout, 'write').mockImplementation(((chunk: unknown, ...rest: unknown[]) => {
    logged.push(String(chunk));
    return (origOut as (...a: unknown[]) => boolean)(chunk, ...rest);
  }) as never);
  app = await createApp();
  await app.init();
  await app.getHttpAdapter().getInstance().ready();
  prisma = app.get(PrismaService);
  capabilities = app.get(ConnectionCapabilities, { strict: false });
  tokens = app.get(ConnectionTokensService, { strict: false });
  store = app.get(ConnectionTokenStore, { strict: false });
  fake = new FakeGraph();
  // The real Microsoft adapter and capability provider, over the fake endpoints instead of the network.
  const adapters = app.get(ConnectionProviderRegistry, { strict: false });
  const providers = app.get(CapabilityProviderRegistry, { strict: false });
  savedAdapter = adapters.get('microsoft');
  savedProvider = providers.get('microsoft');
  const fetchFake: typeof fetch = (...a) => fake.fetch(...a);
  adapters.register(new MicrosoftConnectionAdapter({ fetch: fetchFake }));
  providers.register(new MicrosoftCapabilityProvider(new GraphClient({ fetch: fetchFake, sleep: async () => undefined, tokens: (ctx, o) => tokens.getAccessToken(ctx.connectionId, ctx.userId, { forceRefresh: o?.forceRefresh }) })));
  admin = await login('mconn-admin', 'admin');
  expect((await call(admin, 'PUT', '/api/connections/admin/apps/microsoft', { enabled: true, clientId: fake.clientId, clientSecret: APP_SECRET, tenant: 'common' })).statusCode).toBe(200);
  app.get(ConnectionApps, { strict: false }).invalidate();
});

afterAll(async () => {
  jest.restoreAllMocks();
  await call(admin, 'DELETE', '/api/connections/admin/apps/microsoft');
  await prisma.connection.deleteMany({ where: { user: { email: { contains: stamp } } } });
  if (savedAdapter) app.get(ConnectionProviderRegistry, { strict: false }).register(savedAdapter as never);
  if (savedProvider) app.get(CapabilityProviderRegistry, { strict: false }).register(savedProvider as never);
  await app?.close();
  if (savedKey === undefined) delete process.env.SECRETS_ENCRYPTION_KEY;
  else process.env.SECRETS_ENCRYPTION_KEY = savedKey;
});

describe('the providers route', () => {
  it('returns the capability matrix with the provider\'s columns, and the administrator\'s approval link, so nothing unsupported is offered', async () => {
    const s = await login('mconn-providers');
    const r = await call<{ provider: string; ready: boolean; matrixColumns: string[]; capabilityMatrix: unknown[]; adminConsentUrl: string | null }[]>(s, 'GET', '/api/connections/providers');
    expect(r.statusCode).toBe(200);
    const ms = r.data.find((p) => p.provider === 'microsoft')!;
    expect(ms).toMatchObject({ ready: true, matrixColumns: ['microsoft_work', 'microsoft_personal'] });
    expect(ms.capabilityMatrix).toEqual(JSON.parse(JSON.stringify(matrixRows(COLUMNS_OF_PROVIDER.microsoft))));
    const sheet = (ms.capabilityMatrix as ReturnType<typeof matrixRows>).find((x) => x.method === 'documents.appendRows')!;
    expect(sheet.support.microsoft_personal!.support).toBe('unsupported');
    expect(sheet.support.microsoft_work!.support).not.toBe('unsupported');
    const u = new URL(ms.adminConsentUrl!);
    expect(u.pathname).toBe('/organizations/v2.0/adminconsent');
    expect(u.searchParams.get('client_id')).toBe(fake.clientId);
    expect(JSON.stringify(r.data)).not.toContain(APP_SECRET);
    const google = r.data.find((p) => p.provider === 'google')!;
    expect(google.matrixColumns).toEqual(['google']);
  });
});

describe('connecting Microsoft accounts', () => {
  it('sends the owner to Microsoft with PKCE, offline access, only the permissions asked for and the account chooser', async () => {
    const s = await login('mconn-url');
    const start = await call<{ authorizeUrl: string }>(s, 'POST', '/api/connections/authorize', { provider: 'microsoft', capabilities: ['mail_read', 'calendar_read'] });
    const u = new URL(start.data.authorizeUrl);
    expect(`${u.origin}${u.pathname}`).toBe('https://login.microsoftonline.com/common/oauth2/v2.0/authorize');
    expect(u.searchParams.get('scope')!.split(' ').sort()).toEqual(['Calendars.Read', 'Mail.Read', 'User.Read', 'email', 'offline_access', 'openid', 'profile']);
    expect(u.searchParams.get('code_challenge_method')).toBe('S256');
    expect(u.searchParams.get('prompt')).toBe('select_account');
    expect(u.searchParams.get('client_secret')).toBeNull();
  });

  it('a work account and a personal account of one person become two connections, each read with its own tokens', async () => {
    const s = await login('mconn-two');
    const work = fake.addAccount({ email: `person-a-${stamp}@org-alpha.example.test`, kind: 'work' });
    const personal = fake.addAccount({ email: `person-a-${stamp}@example.test`, kind: 'personal' });
    work.addMessage({ subject: 'work only' });
    personal.addMessage({ subject: 'personal only' });
    const w = await connect(s, work, { capabilities: ['mail_read', 'mail_send'], label: 'Work' });
    const p = await connect(s, personal, { capabilities: ['mail_read'], label: 'Personal' });
    expect(w.location).toContain('connect=connected');
    expect(p.location).toContain('connect=connected');
    expect(w.id).not.toBe(p.id);
    const rows = await prisma.connection.findMany({ where: { userId: s.userId }, orderBy: { label: 'asc' } });
    expect(rows.map((r) => [r.label, r.provider, r.accountId])).toEqual([
      ['Personal', 'microsoft', `${CONSUMER_TENANT_ID}:${personal.objectId}`],
      ['Work', 'microsoft', `${work.tenantId}:${work.objectId}`],
    ]);
    expect(rows[1]!.grantedScopes).toEqual(expect.arrayContaining(['Mail.Read', 'Mail.Send']));
    const [fromWork, fromPersonal] = await Promise.all([capabilities.mail({ connectionId: w.id, userId: s.userId }).search({}), capabilities.mail({ connectionId: p.id, userId: s.userId }).search({})]);
    expect(fromWork.items.map((m) => m.subject)).toEqual(['work only']);
    expect(fromPersonal.items.map((m) => m.subject)).toEqual(['personal only']);
    // The tokens never crossed: each mailbox call carried only its own account's token.
    const tokenOf = (id: string) => store.accessToken(s.userId, id);
    const [tw, tp] = await Promise.all([tokenOf(w.id), tokenOf(p.id)]);
    expect(tw).not.toBe(tp);
    const byMailbox = fake.calls((r) => r.host === 'graph.microsoft.com' && r.path === '/me/messages').map((r) => r.headers.authorization);
    expect(new Set(byMailbox)).toEqual(new Set([`Bearer ${tw}`, `Bearer ${tp}`]));
    // Reading the other account's message with this connection is not found.
    await expect(capabilities.mail({ connectionId: p.id, userId: s.userId }).get(work.messages[0]!.id, { body: 'text' })).rejects.toMatchObject({ code: 'NOT_FOUND' });
  });

  it('connecting the same account again updates its connection (no duplicate)', async () => {
    const s = await login('mconn-again');
    const a = fake.addAccount({ email: `person-a2-${stamp}@example.test`, kind: 'personal' });
    const first = await connect(s, a, { capabilities: ['mail_read'], label: 'Mine' });
    const second = await connect(s, a, { capabilities: ['mail_read'], loginHint: a.email });
    expect(second.id).toBe(first.id);
    expect(await prisma.connection.count({ where: { userId: s.userId } })).toBe(1);
  });

  it('keeps off what Microsoft did not grant, and says which', async () => {
    const s = await login('mconn-deny');
    const a = fake.addAccount({ email: `person-a3-${stamp}@org-alpha.example.test`, kind: 'work' });
    const r = await connect(s, a, { capabilities: ['mail_read', 'mail_send', 'calendar_read'] }, { deny: ['Mail.Send'] });
    expect(r.location).toContain('connect=connected');
    expect(r.location).toContain('missing=mail_send');
    const row = await prisma.connection.findUniqueOrThrow({ where: { id: r.id } });
    expect(row.capabilities).toEqual(['mail_read', 'calendar_read']);
  });

  it('switching a capability on later asks only for the added permission, and keeps what was granted', async () => {
    const s = await login('mconn-incr');
    const a = fake.addAccount({ email: `person-a4-${stamp}@example.test`, kind: 'personal' });
    const r = await connect(s, a, { capabilities: ['mail_read'] });
    const patch = await call<{ consent: { authorizeUrl: string } | null }>(s, 'PATCH', `/api/connections/${r.id}`, { capabilities: ['mail_read', 'calendar_read'] });
    expect(patch.statusCode).toBe(200);
    const u = new URL(patch.data.consent!.authorizeUrl);
    const asked = u.searchParams.get('scope')!.split(' ');
    expect(asked).toContain('Calendars.Read');
    expect(asked).not.toContain('Mail.Read');
    expect(u.searchParams.get('login_hint')).toBe(a.email);
    const loc = await consentAndReturn(patch.data.consent!.authorizeUrl, cookieOf(patch.headers['set-cookie']), a);
    expect(loc).toContain('connect=connected');
    const row = await prisma.connection.findUniqueOrThrow({ where: { id: r.id } });
    expect(row.capabilities).toEqual(['mail_read', 'calendar_read']);
    expect(row.grantedScopes).toEqual(expect.arrayContaining(['Mail.Read', 'Calendars.Read']));
  });
});

describe('administrator approval is not a decline', () => {
  async function failWith(query: Record<string, string>) {
    const s = await login(`mconn-fail-${randomUUID().slice(0, 6)}`);
    const start = await call<{ authorizeUrl: string }>(s, 'POST', '/api/connections/authorize', { provider: 'microsoft', capabilities: ['mail_read'] });
    const state = new URL(start.data.authorizeUrl).searchParams.get('state')!;
    return callback({ state, ...query }, cookieOf(start.headers['set-cookie']));
  }

  it('an owner who declined is told so; an organization that needs an administrator is told that', async () => {
    expect(await failWith({ error: 'access_denied', error_description: 'AADSTS65004: The user declined to consent to access the app.' })).toBe('/settings/connections?connect=denied');
    expect(await failWith({ error: 'access_denied' })).toBe('/settings/connections?connect=denied');
    expect(await failWith({ error: 'access_denied', error_description: 'AADSTS90094: Administrator consent is required.' })).toBe('/settings/connections?connect=admin_consent_required');
    expect(await failWith({ error: 'consent_required', error_description: 'AADSTS65001: The user or administrator has not consented.' })).toBe('/settings/connections?connect=admin_consent_required');
    expect(await failWith({ error: 'server_error', error_description: 'AADSTS500011: something' })).toBe('/settings/connections?connect=refused');
  });

  it('is also told apart when the refusal comes at the token endpoint, after the consent screen', async () => {
    const s = await login('mconn-admin-token');
    const a = fake.addAccount({ email: `person-a5-${stamp}@org-beta.example.test`, kind: 'work' });
    fake.answer((r) => r.form?.grant_type === 'authorization_code', () => new Response(JSON.stringify({ error: 'invalid_grant', error_description: `AADSTS65001 ${FakeGraph.CONTENT_MARKER}`, error_codes: [65001] }), { status: 400, headers: { 'content-type': 'application/json' } }));
    const r = await connect(s, a, { capabilities: ['mail_read'] });
    expect(r.location).toContain('connect=admin_consent_required');
    expect(await prisma.connection.count({ where: { userId: s.userId } })).toBe(0);
  });
});

describe('tokens, the Test route and removal', () => {
  it('refreshes through the token service, stores the rotated refresh token and refreshes once however many callers ask', async () => {
    const s = await login('mconn-rotate');
    const a = fake.addAccount({ email: `person-a6-${stamp}@example.test`, kind: 'personal' });
    const r = await connect(s, a, { capabilities: ['mail_read'] });
    const refreshBefore = await store.refreshToken(s.userId, r.id);
    await prisma.connection.update({ where: { id: r.id }, data: { accessExpiresAt: new Date(Date.now() - 1000) } });
    const grants = () => fake.calls((x) => x.form?.grant_type === 'refresh_token').length;
    const before = grants();
    const ctx = { connectionId: r.id, userId: s.userId };
    await Promise.all([capabilities.mail(ctx).listLabels(), capabilities.mail(ctx).listLabels(), capabilities.mail(ctx).listLabels()]);
    expect(grants() - before).toBe(1);
    const refreshAfter = await store.refreshToken(s.userId, r.id);
    expect(refreshAfter).not.toBe(refreshBefore);
    expect(refreshAfter).toMatch(/^RT-/);
    // The retired token no longer works at Microsoft, and the new one does.
    await prisma.connection.update({ where: { id: r.id }, data: { accessExpiresAt: new Date(Date.now() - 1000) } });
    await capabilities.mail(ctx).listLabels();
    expect(await store.refreshToken(s.userId, r.id)).not.toBe(refreshAfter);
  });

  it('a revoked grant becomes needs_reconnect, and callers get the typed error', async () => {
    const s = await login('mconn-revoked');
    const a = fake.addAccount({ email: `person-a7-${stamp}@example.test`, kind: 'personal' });
    const r = await connect(s, a, { capabilities: ['mail_read'], label: 'Mine' });
    fake.revokeGrant((await store.refreshToken(s.userId, r.id))!);
    await prisma.connection.update({ where: { id: r.id }, data: { accessExpiresAt: new Date(Date.now() - 1000) } });
    const e = await capabilities.mail({ connectionId: r.id, userId: s.userId }).listLabels().catch((x: unknown) => x);
    expect(e).toBeInstanceOf(CapabilityError);
    expect((e as CapabilityError).code).toBe('CONNECTION_NEEDS_RECONNECT');
    expect((await prisma.connection.findUniqueOrThrow({ where: { id: r.id } })).status).toBe('needs_reconnect');
  });

  it('a call without the capability fails before any request to Microsoft', async () => {
    const s = await login('mconn-gate');
    const a = fake.addAccount({ email: `person-a8-${stamp}@example.test`, kind: 'personal' });
    const r = await connect(s, a, { capabilities: ['mail_read'] });
    const before = fake.requests.length;
    const e = await capabilities.calendar({ connectionId: r.id, userId: s.userId }).listCalendars().catch((x: unknown) => x);
    expect((e as CapabilityError).code).toBe('CAPABILITY_OFF');
    expect(fake.requests.length).toBe(before);
  });

  it('tests each switched-on capability with one cheap read, and names a failure with a closed code', async () => {
    const s = await login('mconn-test');
    const a = fake.addAccount({ email: `person-a9-${stamp}@org-alpha.example.test`, kind: 'work' });
    const r = await connect(s, a, { capabilities: ['mail_read', 'calendar_read', 'docs_read'] });
    const ok = await call<{ results: { capability: string; ok: boolean; code: string | null }[] }>(s, 'POST', `/api/connections/${r.id}/test`);
    expect(ok.statusCode).toBe(200);
    expect(ok.data.results).toEqual([
      { capability: 'mail_read', ok: true, code: null },
      { capability: 'calendar_read', ok: true, code: null },
      { capability: 'docs_read', ok: true, code: null },
    ]);
    fake.fail((x) => x.path === '/me/calendars', 403, 'ErrorAccessDenied');
    const bad = await call<{ results: { capability: string; ok: boolean; code: string | null }[] }>(s, 'POST', `/api/connections/${r.id}/test`);
    expect(bad.data.results.find((x) => x.capability === 'calendar_read')).toEqual({ capability: 'calendar_read', ok: false, code: 'FORBIDDEN' });
  });

  it('disconnecting deletes the tokens and says Microsoft could not be asked to revoke them', async () => {
    const s = await login('mconn-remove');
    const a = fake.addAccount({ email: `person-a10-${stamp}@example.test`, kind: 'personal' });
    const r = await connect(s, a, { capabilities: ['mail_read'] });
    const del = await call<{ revoked: boolean }>(s, 'DELETE', `/api/connections/${r.id}`);
    expect(del.statusCode).toBe(200);
    expect(del.data.revoked).toBe(false);
    expect(await prisma.connection.count({ where: { id: r.id } })).toBe(0);
    expect(await store.refreshToken(s.userId, r.id).catch(() => null)).toBeNull();
  });
});

describe('what the console said and wrote', () => {
  it('never contains an access token, a refresh token or the app secret', async () => {
    const everything = `${seen.join('\n')}\n${logged.join('\n')}`;
    expect(everything.length).toBeGreaterThan(1000);
    expect(everything).not.toMatch(/\bAT-[0-9a-f]{8}-\d+/);
    expect(everything).not.toMatch(/\bRT-[0-9a-f-]{36}/);
    expect(everything).not.toContain(APP_SECRET);
    expect(everything).not.toContain(FakeGraph.CONTENT_MARKER);
  });
});
