// The Vault connection against a real, migrated and seeded database and the FAKE VAULT (E37.2, #591): the connect
// flow end to end (state, PKCE, `resource` on both requests, tokens stored encrypted, the row), a wrong or reused
// state, the browser binding, disconnect, refresh rotation (one refresh however many callers, across two service
// instances), a replayed refresh token (needs_reconnect, one notification), the two kill switches, the fabric
// registration (access token only, never the refresh token), SSRF refusals, the status route, the Doctor line,
// and a seeded-marker scan of every response, audit row, notification and log line.
import { randomUUID } from 'node:crypto';
import { NotificationsService } from '@marinoscar/platform-api/notifications';
import type { NestFastifyApplication } from '@nestjs/platform-fastify';

import { createApp } from '../src/main';
import { PrismaService } from '../src/prisma/prisma.service';
import { FABRIC_SECRETS_REGISTRY, type FabricSecretsRegistry, type SecretsProviderRegistration } from '../src/secrets/fabric-secrets-registry';
import { SecretsPolicyService } from '../src/secrets/secrets-policy.service';
import { SecretsProviderRegistrar } from '../src/secrets/secrets-provider.registrar';
import { VaultConnectionsCheck } from '../src/secrets/secrets.doctor';
import { VaultKeepFresh, VaultKeepFreshHandler } from '../src/secrets/secrets.jobs';
import { VaultClientConfigs } from '../src/secrets/vault-client.config';
import { VaultConnectionService, BINDING_COOKIE } from '../src/secrets/vault-connection.service';
import { VaultGrantStore } from '../src/secrets/vault-grant.store';
import { VaultAccessError, VaultTokenService } from '../src/secrets/vault-token.service';
import { OAuthClientService } from '../src/oauth-client';
import { SecretsEvents } from '../src/secrets/secrets.events';
import { FakeVault, startFakeVault } from './support/fake-vault';

const savedKey = process.env.SECRETS_ENCRYPTION_KEY;
process.env.SECRETS_ENCRYPTION_KEY ||= Buffer.alloc(32, 7).toString('base64');
const stamp = `${Date.now()}`;
const CLIENT_SECRET = `MARKER-client-secret-${randomUUID()}`;

let app: NestFastifyApplication;
let prisma: PrismaService;
let vault: FakeVault;
let connection: VaultConnectionService;
let tokens: VaultTokenService;
let store: VaultGrantStore;
let registrar: SecretsProviderRegistrar;
let policy: SecretsPolicyService;
let fabric: FabricSecretsRegistry;

/** Everything the console said or wrote, scanned for the seeded markers at the end. */
const responses: string[] = [];
const logged: string[] = [];
const fabricCalls: { op: 'register' | 'unregister'; ownerId: string; registration?: SecretsProviderRegistration }[] = [];

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

interface StatusView {
  agentUse: { deployment: boolean; user: boolean; effective: boolean };
  providers: { vault: { status: string; configured: boolean; source: string; baseUrl: string | null; clientId: string | null; hasClientSecret: boolean; scopes: string[]; agentAccess: string; connectedAt: string | null; lastSuccessAt: string | null; lastErrorCode: string | null; connecting: boolean; redirectUri: string; vaultUserId: string | null } };
}
const status = async (s: Session) => (await call<StatusView>(s, 'GET', '/api/secrets/status')).data.providers.vault;

async function saveClient(s: Session, over: Record<string, unknown> = {}) {
  return call(s, 'PUT', '/api/secrets/vault/client', { baseUrl: vault.baseUrl, clientId: vault.options.clientId, clientSecret: CLIENT_SECRET, ...over });
}

/** The browser: GET the callback with the state and code Vault redirected with, carrying the binding cookie. */
async function callback(location: string, cookie: string | null) {
  const u = new URL(location);
  const res = await app.inject({ method: 'GET', url: `${u.pathname}${u.search}`, headers: cookie ? { cookie: `${BINDING_COOKIE}=${cookie}` } : {} });
  responses.push(`${res.statusCode} ${JSON.stringify(res.headers)} ${res.body}`);
  return res;
}

function bindingOf(setCookie: unknown): string {
  const raw = Array.isArray(setCookie) ? String(setCookie[0]) : String(setCookie);
  return new RegExp(`${BINDING_COOKIE}=([^;]+)`).exec(raw)![1]!;
}

/** The whole connect flow as the browser does it. */
async function connect(s: Session, body: Record<string, unknown> = {}) {
  const start = await call<{ authorizeUrl: string; expiresAt: string }>(s, 'POST', '/api/secrets/vault/connect', body);
  expect(start.statusCode).toBe(200);
  const location = await vault.consent(start.data.authorizeUrl);
  const res = await callback(location, bindingOf(start.headers['set-cookie']));
  return { start, location, res };
}

async function connected(name: string): Promise<Session> {
  const s = await login(name);
  expect((await saveClient(s)).statusCode).toBe(200);
  const { res } = await connect(s);
  expect(res.headers.location).toBe('/settings/secrets?vault=connected');
  return s;
}

const expireAccess = (userId: string, when = new Date(Date.now() - 1000)) => prisma.secretsConnection.update({ where: { userId_provider: { userId, provider: 'vault' } }, data: { accessExpiresAt: when } });
const rowOf = (userId: string) => prisma.secretsConnection.findUniqueOrThrow({ where: { userId_provider: { userId, provider: 'vault' } } });

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
  connection = app.get(VaultConnectionService, { strict: false });
  tokens = app.get(VaultTokenService, { strict: false });
  store = app.get(VaultGrantStore, { strict: false });
  registrar = app.get(SecretsProviderRegistrar, { strict: false });
  policy = app.get(SecretsPolicyService, { strict: false });
  fabric = app.get<FabricSecretsRegistry>(FABRIC_SECRETS_REGISTRY, { strict: false });
  // The fabric path of E37.1 is not on main yet: record what the console hands the fabric.
  jest.spyOn(fabric, 'registerSecretsProvider').mockImplementation(async (ownerId, registration) => {
    fabricCalls.push({ op: 'register', ownerId, registration: { ...registration } });
  });
  jest.spyOn(fabric, 'unregisterSecretsProvider').mockImplementation(async (ownerId) => {
    fabricCalls.push({ op: 'unregister', ownerId });
  });
  vault = await startFakeVault({ clientSecret: CLIENT_SECRET, redirectUris: [connection.redirectUri()] });
});

afterAll(async () => {
  jest.restoreAllMocks();
  // leave the shared settings as found
  const admin = await login('sec-reset', 'admin');
  await call(admin, 'PATCH', '/api/system-settings', { secrets: { agentUse: { enabled: false }, vault: { baseUrl: null, clientId: null } } });
  await vault?.stop();
  await app?.close();
  if (savedKey === undefined) delete process.env.SECRETS_ENCRYPTION_KEY;
  else process.env.SECRETS_ENCRYPTION_KEY = savedKey;
});

describe('status before anything is set', () => {
  it('is not_configured, with both switches off and the redirect URI to register at the Vault', async () => {
    const s = await login('sec-fresh');
    const v = await status(s);
    expect(v).toMatchObject({ status: 'not_configured', configured: false, source: 'none', hasClientSecret: false, scopes: [], agentAccess: 'unknown', connecting: false });
    expect(v.redirectUri).toBe(connection.redirectUri());
    expect(v.redirectUri).toMatch(/\/api\/secrets\/vault\/callback$/);
    expect((await call<StatusView>(s, 'GET', '/api/secrets/status')).data.agentUse).toEqual({ deployment: false, user: false, effective: false });
  });

  it('connect without a configuration is 409 SECRETS_VAULT_NOT_CONFIGURED', async () => {
    const s = await login('sec-noconf');
    const r = await call(s, 'POST', '/api/secrets/vault/connect', {});
    expect([r.statusCode, r.code]).toEqual([409, 'SECRETS_VAULT_NOT_CONFIGURED']);
  });

  it('a viewer reads the status but cannot configure, connect or disconnect', async () => {
    const v = await login('sec-viewer', 'viewer');
    expect((await call(v, 'GET', '/api/secrets/status')).statusCode).toBe(200);
    for (const [m, p] of [['PUT', '/api/secrets/vault/client'], ['POST', '/api/secrets/vault/connect'], ['POST', '/api/secrets/vault/disconnect']] as const) {
      expect((await call(v, m, p, p.endsWith('client') ? { baseUrl: vault.baseUrl, clientId: 'x' } : {})).statusCode).toBe(403);
    }
    expect((await app.inject({ method: 'GET', url: '/api/secrets/status' })).statusCode).toBe(401);
  });
});

describe('the Vault address (SSRF)', () => {
  it.each([
    ['http://vault.example.test', 'scheme_not_allowed'],
    ['https://10.0.0.5', 'private_target'],
    ['https://169.254.169.254', 'private_target'],
    ['https://192.168.0.10:8443', 'private_target'],
    ['https://user:secret@vault.example.test', 'userinfo_not_allowed'],
    ['https://vault.example.test:22', 'port_not_allowed'],
  ])('refuses %s', async (baseUrl, reason) => {
    const s = await login(`sec-ssrf-${reason}`);
    const r = await call<unknown>(s, 'PUT', '/api/secrets/vault/client', { baseUrl, clientId: 'c', clientSecret: 's' });
    expect([r.statusCode, r.code]).toEqual([422, 'SECRETS_VAULT_URL_REFUSED']);
    expect(r.details).toMatchObject({ reason });
    // nothing was saved
    expect(await prisma.secretsConnection.count({ where: { userId: s.userId } })).toBe(0);
  });

  it('accepts the loopback fake in development, and refuses an address that stops being allowed at connect time', async () => {
    const s = await login('sec-ssrf-later');
    expect((await saveClient(s)).statusCode).toBe(200);
    // the stored address is checked again at connect time: point the row at a private address behind the API's back
    await prisma.secretsConnection.update({ where: { userId_provider: { userId: s.userId, provider: 'vault' } }, data: { baseUrl: 'https://10.1.2.3' } });
    const r = await call(s, 'POST', '/api/secrets/vault/connect', {});
    expect([r.statusCode, r.code]).toEqual([422, 'SECRETS_VAULT_URL_REFUSED']);
  });
});

describe('connecting', () => {
  it('runs the authorization code flow with PKCE end to end and stores the grant encrypted', async () => {
    const s = await login('sec-connect');
    const saved = await saveClient(s);
    expect(saved.statusCode).toBe(200);
    expect(JSON.stringify(saved.data)).not.toContain(CLIENT_SECRET);
    expect(await status(s)).toMatchObject({ status: 'disconnected', configured: true, source: 'user', hasClientSecret: true, baseUrl: vault.baseUrl, clientId: vault.options.clientId });

    const authorizesBefore = vault.stats.authorize;
    const { start, res } = await connect(s);
    expect(start.headers['set-cookie']).toEqual(expect.stringMatching(new RegExp(`${BINDING_COOKIE}=.+HttpOnly.+SameSite=Lax`)));
    expect(start.headers['cache-control']).toBe('no-store');
    // The redirect URL: the resource indicator, S256 PKCE, exactly the three scopes (no write).
    const url = new URL(start.data.authorizeUrl);
    expect(url.origin).toBe(vault.baseUrl);
    expect(Object.fromEntries(url.searchParams)).toMatchObject({
      response_type: 'code',
      client_id: vault.options.clientId,
      redirect_uri: connection.redirectUri(),
      scope: 'vault:items_read vault:items_fill offline_access',
      code_challenge_method: 'S256',
      resource: vault.resource,
    });
    expect(url.searchParams.get('state')!.length).toBeGreaterThanOrEqual(40);
    expect(url.searchParams.get('code_challenge')).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(vault.stats.authorize).toBe(authorizesBefore + 1);

    // The callback: back to the return page, cookie cleared, nothing but the outcome on the URL.
    expect(res.statusCode).toBe(302);
    expect(res.headers.location).toBe('/settings/secrets?vault=connected');
    expect(String(res.headers['set-cookie'])).toContain('Max-Age=0');
    expect(res.headers['cache-control']).toBe('no-store');

    // `resource` and the client's secret were sent on the TOKEN request; whoami proved the token.
    const tokenReq = vault.requests.filter((r) => r.path === '/api/oauth/token').at(-1)!;
    expect(tokenReq.params).toMatchObject({ grant_type: 'authorization_code', resource: vault.resource, redirect_uri: connection.redirectUri(), has_client_secret_in_body: 'true' });
    expect(vault.requests.filter((r) => r.path === '/api/agent/v1/whoami').at(-1)).toMatchObject({ method: 'GET', status: 200 });

    // The row, and what the owner reads.
    const row = await rowOf(s.userId);
    expect(row).toMatchObject({ status: 'connected', agentAccess: 'on', providerUserId: vault.userId, pendingStateHash: null, pendingBindingHash: null, reconnectNotifiedAt: null, lastErrorCode: null });
    expect(row.scopes).toEqual(['vault:items_read', 'vault:items_fill', 'offline_access']);
    const v = await status(s);
    expect(v).toMatchObject({ status: 'connected', scopes: ['vault:items_read', 'vault:items_fill', 'offline_access'], agentAccess: 'on', vaultUserId: vault.userId, connecting: false, lastErrorCode: null });
    expect(v.connectedAt).toEqual(expect.any(String));
    expect(v.lastSuccessAt).toEqual(expect.any(String));

    // The grant is encrypted: the store hands back the plaintext the Vault issued; the database never holds it.
    const refresh = (await store.refreshToken(s.userId))!;
    const access = (await store.accessToken(s.userId))!;
    expect(refresh).toMatch(/^ort_/);
    expect(access).toMatch(/^oat_/);
    const creds = await prisma.userCredential.findMany({ where: { userId: s.userId } });
    expect(creds.map((c) => `${c.purpose}/${c.name}`).sort()).toEqual(['secrets_vault_client/default', 'secrets_vault_grant/access', 'secrets_vault_grant/refresh']);
    const dump = JSON.stringify([creds, row]);
    for (const secret of [refresh, access, CLIENT_SECRET]) expect(dump).not.toContain(secret);
    // The pending flow (the verifier) is gone.
    expect(creds.some((c) => c.name === 'pending')).toBe(false);
    // Audit: who, where (host only), which scopes; never a token.
    const ev = await prisma.auditEvent.findFirstOrThrow({ where: { actorUserId: s.userId, action: 'secrets.vault.connected' } });
    expect(ev.meta).toMatchObject({ provider: 'vault', host: new URL(vault.baseUrl).host, agentAccess: 'on' });
  });

  it('asks for vault:items_write only when the owner asks, and replaces (and revokes) the earlier grant', async () => {
    const s = await connected('sec-write-scope');
    const first = (await store.refreshToken(s.userId))!;
    const { start, res } = await connect(s, { allowWrite: true });
    expect(new URL(start.data.authorizeUrl).searchParams.get('scope')).toBe('vault:items_read vault:items_fill vault:items_write offline_access');
    expect(res.headers.location).toBe('/settings/secrets?vault=connected');
    expect((await rowOf(s.userId)).scopes).toContain('vault:items_write');
    const second = (await store.refreshToken(s.userId))!;
    expect(second).not.toBe(first);
    // the old grant was revoked at the Vault
    await expect(new OAuthClientService((app.get(VaultConnectionService, { strict: false }) as unknown as { http: never }).http).refresh(
      { issuer: vault.baseUrl, authorizationEndpoint: '', tokenEndpoint: `${vault.baseUrl}/api/oauth/token`, revocationEndpoint: null, issuerInResponse: false },
      { clientId: vault.options.clientId, clientSecret: CLIENT_SECRET },
      { refreshToken: first },
    )).rejects.toMatchObject({ kind: 'invalid_grant' });
  });

  it('refuses a callback with a wrong state, and one with no state', async () => {
    const s = await login('sec-wrong-state');
    await saveClient(s);
    const start = await call<{ authorizeUrl: string }>(s, 'POST', '/api/secrets/vault/connect', {});
    const location = new URL(await vault.consent(start.data.authorizeUrl));
    location.searchParams.set('state', 'not-the-state');
    const wrong = await callback(location.toString(), bindingOf(start.headers['set-cookie']));
    expect(wrong.headers.location).toBe('/settings/secrets?vault=state_invalid');
    location.searchParams.delete('state');
    expect((await callback(location.toString(), bindingOf(start.headers['set-cookie']))).headers.location).toBe('/settings/secrets?vault=state_invalid');
    expect((await status(s)).status).toBe('disconnected');
    expect(await prisma.userCredential.count({ where: { userId: s.userId, purpose: 'secrets_vault_grant', name: { in: ['refresh', 'access'] } } })).toBe(0);
  });

  it('binds the flow to the browser that started it: the right state without the cookie (or with another) is refused and leaves the flow pending', async () => {
    const s = await login('sec-binding');
    await saveClient(s);
    const start = await call<{ authorizeUrl: string }>(s, 'POST', '/api/secrets/vault/connect', {});
    const location = await vault.consent(start.data.authorizeUrl);
    expect((await callback(location, null)).headers.location).toBe('/settings/secrets?vault=binding_invalid');
    expect((await callback(location, 'another-browsers-cookie')).headers.location).toBe('/settings/secrets?vault=binding_invalid');
    expect((await status(s)).connecting).toBe(true);
    // the real browser can still finish it
    expect((await callback(location, bindingOf(start.headers['set-cookie']))).headers.location).toBe('/settings/secrets?vault=connected');
  });

  it('a state is used once', async () => {
    const s = await login('sec-once');
    await saveClient(s);
    const start = await call<{ authorizeUrl: string }>(s, 'POST', '/api/secrets/vault/connect', {});
    const location = await vault.consent(start.data.authorizeUrl);
    const cookie = bindingOf(start.headers['set-cookie']);
    expect((await callback(location, cookie)).headers.location).toBe('/settings/secrets?vault=connected');
    expect((await callback(location, cookie)).headers.location).toBe('/settings/secrets?vault=state_invalid');
  });

  it('an expired flow is refused', async () => {
    const s = await login('sec-expired');
    await saveClient(s);
    const start = await call<{ authorizeUrl: string }>(s, 'POST', '/api/secrets/vault/connect', {});
    const location = await vault.consent(start.data.authorizeUrl);
    await prisma.secretsConnection.update({ where: { userId_provider: { userId: s.userId, provider: 'vault' } }, data: { pendingExpiresAt: new Date(Date.now() - 1000) } });
    expect((await callback(location, bindingOf(start.headers['set-cookie']))).headers.location).toBe('/settings/secrets?vault=expired');
    expect((await status(s)).connecting).toBe(false);
  });

  it('refuses a callback whose iss is not the Vault', async () => {
    const s = await login('sec-iss');
    await saveClient(s);
    const start = await call<{ authorizeUrl: string }>(s, 'POST', '/api/secrets/vault/connect', {});
    const location = new URL(await vault.consent(start.data.authorizeUrl));
    location.searchParams.set('iss', 'https://evil.example.test');
    expect((await callback(location.toString(), bindingOf(start.headers['set-cookie']))).headers.location).toBe('/settings/secrets?vault=issuer_mismatch');
    expect((await status(s)).status).toBe('disconnected');
  });

  it('reports a denied consent, and records nothing', async () => {
    const s = await login('sec-denied');
    await saveClient(s);
    const start = await call<{ authorizeUrl: string }>(s, 'POST', '/api/secrets/vault/connect', {});
    vault.denyNextAuthorization();
    const location = await vault.consent(start.data.authorizeUrl);
    expect(new URL(location).searchParams.get('error')).toBe('access_denied');
    expect((await callback(location, bindingOf(start.headers['set-cookie']))).headers.location).toBe('/settings/secrets?vault=denied');
    expect((await status(s)).status).toBe('disconnected');
  });

  it('connects even when Vault\'s own agent access is switched off, and says so', async () => {
    vault.setAgentAccess(false);
    try {
      const s = await connected('sec-vault-off');
      expect(await status(s)).toMatchObject({ status: 'connected', agentAccess: 'off', lastErrorCode: 'AGENT_ACCESS_DISABLED' });
    } finally {
      vault.setAgentAccess(true);
    }
  });

  it('a return path is only ever a path on this console', async () => {
    const s = await login('sec-return');
    await saveClient(s);
    const start = await call<{ authorizeUrl: string }>(s, 'POST', '/api/secrets/vault/connect', { returnTo: '/settings/secrets?tab=vault' });
    const location = await vault.consent(start.data.authorizeUrl);
    expect((await callback(location, bindingOf(start.headers['set-cookie']))).headers.location).toBe('/settings/secrets?tab=vault&vault=connected');
    const evil = await call<{ authorizeUrl: string }>(s, 'POST', '/api/secrets/vault/connect', { returnTo: 'https://evil.example.test/' });
    const l2 = await vault.consent(evil.data.authorizeUrl);
    expect((await callback(l2, bindingOf(evil.headers['set-cookie']))).headers.location).toBe('/settings/secrets?vault=connected');
  });

  it('a client the Vault does not know fails the exchange and stores no grant', async () => {
    const s = await login('sec-badclient');
    await saveClient(s, { clientSecret: 'a-wrong-client-secret' });
    const start = await call<{ authorizeUrl: string }>(s, 'POST', '/api/secrets/vault/connect', {});
    const location = await vault.consent(start.data.authorizeUrl);
    expect((await callback(location, bindingOf(start.headers['set-cookie']))).headers.location).toBe('/settings/secrets?vault=exchange_failed');
    expect((await status(s)).status).toBe('disconnected');
    expect((await status(s)).lastErrorCode).toBe('CONNECT_EXCHANGE_FAILED');
  });

  it('the address cannot change while connected; it can after disconnecting', async () => {
    const s = await connected('sec-change');
    const r = await saveClient(s, { baseUrl: `${vault.baseUrl}/other` });
    expect([r.statusCode, r.code]).toEqual([409, 'SECRETS_VAULT_DISCONNECT_FIRST']);
    expect((await call(s, 'POST', '/api/secrets/vault/disconnect', {})).statusCode).toBe(200);
    expect((await saveClient(s, { baseUrl: vault.baseUrl })).statusCode).toBe(200);
  });
});

describe('disconnecting', () => {
  it('revokes at the Vault, deletes the stored tokens, tells the fabric and marks the row disconnected', async () => {
    const s = await connected('sec-disconnect');
    const refresh = (await store.refreshToken(s.userId))!;
    const revokesBefore = vault.stats.revoke;
    fabricCalls.length = 0;
    const r = await call<{ revoked: boolean; status: StatusView }>(s, 'POST', '/api/secrets/vault/disconnect', {});
    expect(r.statusCode).toBe(200);
    expect(r.data.revoked).toBe(true);
    expect(r.data.status.providers.vault).toMatchObject({ status: 'disconnected', scopes: [], vaultUserId: null });
    expect(vault.stats.revoke).toBeGreaterThan(revokesBefore);
    // the grant is really gone at the Vault: its refresh token no longer works
    const probe = await fetch(`${vault.baseUrl}/api/oauth/token`, { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ grant_type: 'refresh_token', refresh_token: refresh, client_id: vault.options.clientId, client_secret: CLIENT_SECRET }).toString() });
    expect(probe.status).toBe(400);
    expect(await prisma.userCredential.count({ where: { userId: s.userId, purpose: 'secrets_vault_grant' } })).toBe(0);
    expect(await store.refreshToken(s.userId)).toBeNull();
    expect(await rowOf(s.userId)).toMatchObject({ status: 'disconnected', accessExpiresAt: null, connectedAt: null });
    expect(fabricCalls).toEqual([{ op: 'unregister', ownerId: s.userId }]);
    expect(await prisma.auditEvent.count({ where: { actorUserId: s.userId, action: 'secrets.vault.disconnected' } })).toBe(1);
    // the client entry stays so Connect is one click; forgetClient removes it
    expect((await status(s)).configured).toBe(true);
    const forget = await call<{ status: StatusView }>(s, 'POST', '/api/secrets/vault/disconnect', { forgetClient: true });
    expect(forget.data.status.providers.vault).toMatchObject({ status: 'not_configured', hasClientSecret: false, baseUrl: null });
  });

  it('deletes the tokens even when the Vault cannot be reached, and says it could not revoke', async () => {
    const down = await startFakeVault({ clientSecret: CLIENT_SECRET, redirectUris: [connection.redirectUri()] });
    const s = await login('sec-disconnect-down');
    await saveClient(s, { baseUrl: down.baseUrl });
    const start = await call<{ authorizeUrl: string }>(s, 'POST', '/api/secrets/vault/connect', {});
    await callback(await down.consent(start.data.authorizeUrl), bindingOf(start.headers['set-cookie']));
    expect((await status(s)).status).toBe('connected');
    await down.stop();
    const r = await call<{ revoked: boolean; status: StatusView }>(s, 'POST', '/api/secrets/vault/disconnect', {});
    expect(r.statusCode).toBe(200);
    expect(r.data.revoked).toBe(false);
    expect(r.data.status.providers.vault.status).toBe('disconnected');
    expect(await store.refreshToken(s.userId)).toBeNull();
  });

  it('is idempotent for an owner who never connected', async () => {
    const s = await login('sec-disconnect-none');
    const r = await call<{ revoked: boolean }>(s, 'POST', '/api/secrets/vault/disconnect', {});
    expect(r.statusCode).toBe(200);
  });
});

describe('refresh rotation', () => {
  it('concurrent callers in one process share one refresh, and the new refresh token is stored', async () => {
    const s = await connected('sec-single-flight');
    const before = vault.stats.refresh;
    const oldRefresh = (await store.refreshToken(s.userId))!;
    await expireAccess(s.userId);
    vault.options.refreshDelayMs = 250;
    try {
      const results = await Promise.all(Array.from({ length: 8 }, () => tokens.getAccess(s.userId)));
      expect(vault.stats.refresh).toBe(before + 1);
      expect(new Set(results.map((r) => r.accessToken)).size).toBe(1);
      expect(results[0]!.expiresAt.getTime()).toBeGreaterThan(Date.now() + 200_000);
    } finally {
      vault.options.refreshDelayMs = 0;
    }
    const newRefresh = (await store.refreshToken(s.userId))!;
    expect(newRefresh).toBe(vault.issuedRefreshTokens.at(-1));
    expect(newRefresh).not.toBe(oldRefresh);
    // a fresh token is served without calling the Vault again
    await tokens.getAccess(s.userId);
    expect(vault.stats.refresh).toBe(before + 1);
  });

  it('two API instances never refresh the same grant at once: the lease makes the second wait for the first\'s result', async () => {
    const s = await connected('sec-lease');
    const second = new VaultTokenService(prisma, store, app.get(VaultClientConfigs, { strict: false }), app.get(OAuthClientService, { strict: false }), app.get(SecretsEvents, { strict: false }), fabric);
    second.sleep = (ms) => new Promise((r) => setTimeout(r, Math.min(ms, 20)));
    const before = vault.stats.refresh;
    await expireAccess(s.userId);
    vault.options.refreshDelayMs = 300;
    try {
      const [a, b, c] = await Promise.all([tokens.getAccess(s.userId), second.getAccess(s.userId), second.getAccess(s.userId)]);
      expect(vault.stats.refresh).toBe(before + 1);
      expect(new Set([a.accessToken, b.accessToken, c.accessToken]).size).toBe(1);
    } finally {
      vault.options.refreshDelayMs = 0;
    }
    expect((await rowOf(s.userId)).refreshLeaseUntil).toBeNull();
  });

  it('a lease left behind by a crashed instance expires and a refresh goes on', async () => {
    const s = await connected('sec-stale-lease');
    await expireAccess(s.userId);
    await prisma.secretsConnection.update({ where: { userId_provider: { userId: s.userId, provider: 'vault' } }, data: { refreshLeaseUntil: new Date(Date.now() - 1000) } });
    await expect(tokens.getAccess(s.userId)).resolves.toMatchObject({ accessToken: expect.stringMatching(/^oat_/) });
  });

  it('a Vault that is down changes nothing: the connection stays connected, the caller is told, the next try works', async () => {
    const s = await connected('sec-refresh-down');
    await expireAccess(s.userId);
    vault.failNextRefresh(503);
    await expect(tokens.getAccess(s.userId)).rejects.toMatchObject({ kind: 'unavailable', code: 'UNAVAILABLE' });
    expect(await rowOf(s.userId)).toMatchObject({ status: 'connected', lastErrorCode: 'UNAVAILABLE' });
    expect(await store.refreshToken(s.userId)).not.toBeNull();
    await expect(tokens.getAccess(s.userId)).resolves.toBeDefined();
    expect((await rowOf(s.userId)).lastErrorCode).toBeNull();
  });

  it('a replayed refresh token revokes the grant at the Vault: the connection needs_reconnect, the tokens are deleted and the owner is notified ONCE', async () => {
    const s = await connected('sec-replay');
    const retired = (await store.refreshToken(s.userId))!;
    await expireAccess(s.userId);
    await tokens.getAccess(s.userId); // a normal rotation: `retired` is now a used refresh token
    fabricCalls.length = 0;
    // Someone replays the retired token: Vault treats it as reuse and revokes the whole grant.
    const replay = await fetch(`${vault.baseUrl}/api/oauth/token`, { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ grant_type: 'refresh_token', refresh_token: retired, client_id: vault.options.clientId, client_secret: CLIENT_SECRET }).toString() });
    expect(replay.status).toBe(400);
    // The console's next refresh finds the grant gone.
    await expireAccess(s.userId);
    await expect(tokens.getAccess(s.userId)).rejects.toMatchObject({ kind: 'needs_reconnect', code: 'GRANT_REVOKED' });
    expect(await rowOf(s.userId)).toMatchObject({ status: 'needs_reconnect', lastErrorCode: 'GRANT_REVOKED', accessExpiresAt: null });
    expect(await prisma.userCredential.count({ where: { userId: s.userId, purpose: 'secrets_vault_grant' } })).toBe(0);
    expect(fabricCalls).toEqual([{ op: 'unregister', ownerId: s.userId }]);
    // Later callers get the same answer and the owner is not told again.
    await expect(tokens.getAccess(s.userId)).rejects.toBeInstanceOf(VaultAccessError);
    await Promise.all([tokens.markNeedsReconnect(s.userId, 'GRANT_REVOKED'), tokens.markNeedsReconnect(s.userId, 'UNAUTHORIZED')]);
    await app.get(NotificationsService).flush();
    expect(await prisma.notification.count({ where: { userId: s.userId, eventKey: 'secrets.needs_reconnect' } })).toBe(1);
    expect(await prisma.auditEvent.count({ where: { actorUserId: s.userId, action: 'secrets.vault.needs_reconnect' } })).toBe(1);
    expect(await status(s)).toMatchObject({ status: 'needs_reconnect', scopes: expect.any(Array), lastErrorCode: 'GRANT_REVOKED' });
    // Connecting again clears it, and a later episode may notify again.
    const again = await connect(s);
    expect(again.res.headers.location).toBe('/settings/secrets?vault=connected');
    expect(await rowOf(s.userId)).toMatchObject({ status: 'connected', reconnectNotifiedAt: null, lastErrorCode: null });
  });

  it('an administrator removing the app at the Vault is the same: needs_reconnect, one notification', async () => {
    const s = await connected('sec-admin-revoke');
    vault.revokeAllGrants();
    await expireAccess(s.userId);
    await expect(tokens.getAccess(s.userId)).rejects.toMatchObject({ kind: 'needs_reconnect' });
    await app.get(NotificationsService).flush();
    expect(await prisma.notification.count({ where: { userId: s.userId, eventKey: 'secrets.needs_reconnect' } })).toBe(1);
  });

  it('a 401 the fabric reports marks needs_reconnect; other codes are recorded and the status stays', async () => {
    const s = await connected('sec-outcome');
    await connection.recordOutcome(s.userId, { ok: true });
    expect((await status(s)).lastSuccessAt).toEqual(expect.any(String));
    await connection.recordOutcome(s.userId, { ok: false, code: 'ORIGIN_MISMATCH' });
    expect(await status(s)).toMatchObject({ status: 'connected', lastErrorCode: 'ORIGIN_MISMATCH' });
    await connection.recordOutcome(s.userId, { ok: false, code: 'DISABLED' });
    expect(await status(s)).toMatchObject({ status: 'connected', agentAccess: 'off', lastErrorCode: 'DISABLED' });
    await connection.recordOutcome(s.userId, { ok: false, code: 'a message that could carry data: hunter2' });
    expect((await status(s)).lastErrorCode).toBe('UNKNOWN');
    await connection.recordOutcome(s.userId, { ok: true });
    expect(await status(s)).toMatchObject({ lastErrorCode: null, agentAccess: 'on' });
    await connection.recordOutcome(s.userId, { ok: false, code: 'UNAUTHORIZED' });
    expect((await status(s)).status).toBe('needs_reconnect');
    await app.get(NotificationsService).flush();
    expect(await prisma.notification.count({ where: { userId: s.userId, eventKey: 'secrets.needs_reconnect' } })).toBe(1);
  });
});

describe('the kill switches and the fabric registration', () => {
  let admin: Session;
  beforeAll(async () => {
    admin = await login('sec-admin', 'admin');
  });
  const setDeployment = async (enabled: boolean) => {
    const r = await call(admin, 'PATCH', '/api/system-settings', { secrets: { agentUse: { enabled } } });
    expect(r.statusCode).toBe(200);
    policy.invalidate();
  };
  const setUser = async (s: Session, enabled: boolean) => {
    expect((await call(s, 'PATCH', '/api/user-settings', { secrets: { agentUse: { enabled } } })).statusCode).toBe(200);
  };

  it('is OFF by default for the deployment and for the owner: nothing is handed to the fabric, and the fabric is told to hold nothing', async () => {
    const s = await connected('sec-switch-default');
    fabricCalls.length = 0;
    expect(await registrar.ensureRegistered(s.userId)).toBe('not_enabled');
    expect(fabricCalls).toEqual([{ op: 'unregister', ownerId: s.userId }]);
    const view = (await call<StatusView>(s, 'GET', '/api/secrets/status')).data.agentUse;
    expect(view).toEqual({ deployment: false, user: false, effective: false });
  });

  it('both switches are needed, whatever the Vault allows', async () => {
    const s = await connected('sec-switch-both');
    await setUser(s, true);
    fabricCalls.length = 0;
    expect(await registrar.ensureRegistered(s.userId)).toBe('not_enabled'); // the deployment is still off
    expect(fabricCalls.filter((c) => c.op === 'register')).toEqual([]);
    await setDeployment(true);
    try {
      await setUser(s, false);
      expect(await registrar.ensureRegistered(s.userId)).toBe('not_enabled'); // the owner is off
      expect(fabricCalls.filter((c) => c.op === 'register')).toEqual([]);
      expect((await call<StatusView>(s, 'GET', '/api/secrets/status')).data.agentUse).toEqual({ deployment: true, user: false, effective: false });
    } finally {
      await setDeployment(false);
    }
  });

  it('with both on, hands the fabric the base URL and a short-lived access token with its expiry, and NEVER the refresh token', async () => {
    const s = await connected('sec-switch-on');
    await setUser(s, true);
    await setDeployment(true);
    try {
      fabricCalls.length = 0;
      expect(await registrar.ensureRegistered(s.userId)).toBe('registered');
      const regs = fabricCalls.filter((c) => c.op === 'register');
      expect(regs).toHaveLength(1);
      expect(regs[0]!.ownerId).toBe(s.userId);
      expect(regs[0]!.registration).toMatchObject({ kind: 'vault', baseUrl: vault.baseUrl, accessToken: (await store.accessToken(s.userId))!, expiresAt: expect.stringMatching(/^\d{4}-\d\d-\d\dT/) });
      // The refresh token (and the client secret) are in NOTHING the fabric was given.
      const refresh = (await store.refreshToken(s.userId))!;
      const sent = JSON.stringify(fabricCalls);
      expect(sent).not.toContain(refresh);
      expect(sent).not.toContain(CLIENT_SECRET);
      expect(Object.keys(regs[0]!.registration!).sort()).toEqual(['accessToken', 'baseUrl', 'expiresAt', 'kind']);
      // Still fresh: not pushed again.
      expect(await registrar.ensureRegistered(s.userId)).toBe('registered');
      expect(fabricCalls.filter((c) => c.op === 'register')).toHaveLength(1);
      // Near expiry: refreshed and replaced.
      await expireAccess(s.userId, new Date(Date.now() + 20_000));
      expect(await registrar.ensureRegistered(s.userId)).toBe('registered');
      const replaced = fabricCalls.filter((c) => c.op === 'register');
      expect(replaced).toHaveLength(2);
      expect(replaced[1]!.registration!.accessToken).not.toBe(replaced[0]!.registration!.accessToken);
      expect(JSON.stringify(fabricCalls)).not.toContain((await store.refreshToken(s.userId))!);
      // Turning the owner's switch off takes the provider away from the fabric.
      await setUser(s, false);
      expect(await registrar.ensureRegistered(s.userId)).toBe('not_enabled');
      expect(fabricCalls.at(-1)).toEqual({ op: 'unregister', ownerId: s.userId });
    } finally {
      await setDeployment(false);
    }
  });

  it('reports needs_reconnect and not_connected without calling the fabric', async () => {
    await setDeployment(true);
    try {
      const gone = await connected('sec-reg-gone');
      await setUser(gone, true);
      vault.revokeAllGrants();
      await expireAccess(gone.userId);
      expect(await registrar.ensureRegistered(gone.userId)).toBe('needs_reconnect');
      const never = await login('sec-reg-never');
      await setUser(never, true);
      expect(await registrar.ensureRegistered(never.userId)).toBe('not_connected');
    } finally {
      await setDeployment(false);
    }
  });

  it('the fabric not being wired yet is reported as unavailable, not as registered', async () => {
    const s = await connected('sec-reg-unwired');
    await setUser(s, true);
    await setDeployment(true);
    try {
      (fabric.registerSecretsProvider as jest.Mock).mockRejectedValueOnce(Object.assign(new Error('x'), { name: 'FabricSecretsUnavailable' }));
      expect(await registrar.ensureRegistered(s.userId)).toBe('unavailable');
    } finally {
      await setDeployment(false);
    }
  });

  it('the keep-fresh job renews the token for an owner with a live run, and only for them', async () => {
    const live = await connected('sec-keep-live');
    const idle = await connected('sec-keep-idle');
    for (const s of [live, idle]) await setUser(s, true);
    await setDeployment(true);
    try {
      await expireAccess(live.userId, new Date(Date.now() + 30_000));
      await expireAccess(idle.userId, new Date(Date.now() + 30_000));
      await prisma.run.create({ data: { userId: live.userId, goal: 'Sign in', status: 'running' } as never });
      const due = app.get(VaultKeepFresh, { strict: false });
      const ids = await due.dueUserIds();
      expect(ids).toContain(live.userId);
      expect(ids).not.toContain(idle.userId);
      fabricCalls.length = 0;
      const before = vault.stats.refresh;
      await app.get(VaultKeepFreshHandler, { strict: false }).process();
      expect(vault.stats.refresh).toBeGreaterThanOrEqual(before + 1);
      expect(fabricCalls.filter((c) => c.op === 'register' && c.ownerId === live.userId)).toHaveLength(1);
      expect(fabricCalls.some((c) => c.ownerId === idle.userId)).toBe(false);
      // the job is server-only: it declares no node result
      const handler = app.get(VaultKeepFreshHandler, { strict: false }) as unknown as Record<string, unknown>;
      expect(handler.nodeResultSchema).toBeUndefined();
      expect(handler.persistNodeResult).toBeUndefined();
    } finally {
      await setDeployment(false);
      await prisma.run.deleteMany({ where: { userId: live.userId } });
    }
  });
});

describe('the deployment default client', () => {
  it('lets an administrator set it so an owner only presses Connect; an owner\'s own entry wins; a non-admin cannot', async () => {
    const admin = await login('sec-admin-default', 'admin');
    const contributor = await login('sec-not-admin');
    expect((await call(contributor, 'PUT', '/api/secrets/vault/default-client', { baseUrl: vault.baseUrl })).statusCode).toBe(403);
    expect((await call(contributor, 'GET', '/api/secrets/vault/default-client')).statusCode).toBe(403);

    const refused = await call(admin, 'PUT', '/api/secrets/vault/default-client', { baseUrl: 'https://10.0.0.9' });
    expect([refused.statusCode, refused.code]).toEqual([422, 'SECRETS_VAULT_URL_REFUSED']);

    const set = await call<{ baseUrl: string; clientId: string; hasClientSecret: boolean; redirectUri: string }>(admin, 'PUT', '/api/secrets/vault/default-client', { baseUrl: vault.baseUrl, clientId: vault.options.clientId, clientSecret: CLIENT_SECRET });
    try {
      expect(set.statusCode).toBe(200);
      expect(set.data).toMatchObject({ baseUrl: vault.baseUrl, clientId: vault.options.clientId, hasClientSecret: true, redirectUri: connection.redirectUri() });
      expect(JSON.stringify(set.data)).not.toContain(CLIENT_SECRET);

      const owner = await login('sec-default-owner');
      policy.invalidate();
      expect(await status(owner)).toMatchObject({ status: 'disconnected', configured: true, source: 'deployment', hasClientSecret: true });
      const { res } = await connect(owner); // no own configuration at all
      expect(res.headers.location).toBe('/settings/secrets?vault=connected');
      expect(await prisma.userCredential.count({ where: { userId: owner.userId, purpose: 'secrets_vault_client' } })).toBe(0);
      expect(await prisma.auditEvent.count({ where: { actorUserId: admin.userId, action: 'secrets.vault.default_client_saved' } })).toBeGreaterThan(0);
    } finally {
      const removed = await call<{ baseUrl: string | null; hasClientSecret: boolean }>(admin, 'DELETE', '/api/secrets/vault/default-client');
      expect(removed.data).toMatchObject({ baseUrl: null, hasClientSecret: false });
    }
  });
});

describe('the Doctor', () => {
  it('warns while a connection needs reconnecting, and passes otherwise', async () => {
    const s = await connected('sec-doctor');
    const check = app.get(VaultConnectionsCheck, { strict: false });
    await prisma.secretsConnection.updateMany({ where: { provider: 'vault', status: 'needs_reconnect' }, data: { status: 'disconnected' } });
    expect((await check.run()).status).toBe('pass');
    vault.revokeAllGrants();
    await expireAccess(s.userId);
    await expect(tokens.getAccess(s.userId)).rejects.toBeInstanceOf(VaultAccessError);
    const out = await check.run();
    expect(out.status).toBe('warn');
    expect(out.detail).toContain('need');
    expect(JSON.stringify(out)).not.toContain(s.userId);
  });
});

describe('the user\'s deletion', () => {
  it('deletes the connection and the stored tokens with the user', async () => {
    const s = await connected('sec-delete-user');
    expect(await prisma.secretsConnection.count({ where: { userId: s.userId } })).toBe(1);
    await prisma.user.delete({ where: { id: s.userId } });
    expect(await prisma.secretsConnection.count({ where: { userId: s.userId } })).toBe(0);
    expect(await prisma.userCredential.count({ where: { userId: s.userId } })).toBe(0);
  });
});

describe('no secret leaks (seeded markers)', () => {
  it('no token, client secret, verifier or authorization code is in any API response, audit event, notification, connection row or log line', async () => {
    const s = await connected('sec-marker');
    const access = (await store.accessToken(s.userId))!;
    const refresh = (await store.refreshToken(s.userId))!;
    await call(s, 'GET', '/api/secrets/status');
    await call(s, 'POST', '/api/secrets/vault/disconnect', {});
    const codes = vault.requests; // the fake saw them; the console must not echo them
    expect(codes.length).toBeGreaterThan(0);
    const audit = JSON.stringify(await prisma.auditEvent.findMany({ where: { actorUserId: s.userId } }));
    const notes = JSON.stringify(await prisma.notification.findMany({ where: { userId: s.userId } }));
    const rows = JSON.stringify(await prisma.secretsConnection.findMany({ where: { userId: s.userId } }));
    const everything = [responses.join('\n'), audit, notes, rows, logged.join('')];
    const markers = [CLIENT_SECRET, access, refresh, ...vault.issuedRefreshTokens, ...vault.canaries()];
    for (const marker of markers) for (const place of everything) expect(place).not.toContain(marker);
    // the authorization codes never appear either (the redirect carries only the outcome)
    expect(vault.issuedCodes.length).toBeGreaterThan(0);
    for (const code of vault.issuedCodes) for (const place of everything) expect(place).not.toContain(code);
  });
});
