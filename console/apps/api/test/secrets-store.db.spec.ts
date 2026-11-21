// The built-in secrets store against a real, migrated and seeded database (E37.5, #594): a login created through
// Vault's own controller, opened to the agent, looked up by exact origin and released one field at a time through the
// provider and through the fabric's internal route; the identical not-found, the origin refusal, the two console
// switches and Vault's kill switch; no role reads another owner's value; ciphertext only in the database (a seeded
// marker is nowhere in it), rotation, a wrong key failing closed; the internal route unreachable with a session, a
// personal access token and an AI app's OAuth token; the user's secrets and data key removed with them; and a scan of
// every response, audit row and log line for the seeded markers.
import './support/secrets-store-env';
import { randomUUID } from 'node:crypto';
import { createOAuthTestClient, mintOAuthTestToken } from '@marinoscar/platform-api/identity/testing';
import { ConfigService } from '@nestjs/config';
import type { NestFastifyApplication } from '@nestjs/platform-fastify';

import { createApp } from '../src/main';
import { PrismaService } from '../src/prisma/prisma.service';
import { FABRIC_SECRETS_REGISTRY, type FabricSecretsRegistry, type SecretsProviderRegistration } from '../src/secrets/fabric-secrets-registry';
import { SecretsPolicyService } from '../src/secrets/secrets-policy.service';
import { SecretsProviderRegistrar } from '../src/secrets/secrets-provider.registrar';
import { SecretsProviderError } from '../src/secrets/secrets-provider.port';
import { BuiltinSecretsProvider } from '../src/secrets/builtin/store.provider';
import { SecretsStoreKeys } from '../src/secrets/builtin/store.data-keys';
import { SecretsStoreMaintenance } from '../src/secrets/builtin/store.maintenance';
import { StoreKeyCheck } from '../src/secrets/builtin/store.doctor';
import { StoreKeyRing } from '../src/secrets/builtin/store.keys';
import { TEST_STORE_KEY, TEST_STORE_KEY_2 } from './support/secrets-store-env';

const stamp = `${Date.now()}`;
const PASSWORD = `MARKER-password-${randomUUID()}`;
const USERNAME = `marker-user-${randomUUID().slice(0, 8)}@example.test`;
const TOTP_SEED = 'JBSWY3DPEHPK3PXP';
const ORIGIN = 'https://shop.example.test';
const CALLBACK = '/api/internal/secrets-store/v1';

let app: NestFastifyApplication;
let prisma: PrismaService;
let policy: SecretsPolicyService;
let registrar: SecretsProviderRegistrar;
let provider: BuiltinSecretsProvider;
let keys: SecretsStoreKeys;
let fabric: FabricSecretsRegistry;
let credentialTypeId: string;

const responses: string[] = [];
const logged: string[] = [];
const fabricCalls: { op: 'register' | 'unregister'; ownerId: string; registration?: SecretsProviderRegistration }[] = [];

interface Session {
  token: string;
  userId: string;
}

async function login(name: string, role: 'contributor' | 'viewer' | 'admin' | 'org_admin' = 'contributor'): Promise<Session> {
  const res = await app.inject({ method: 'POST', url: '/api/auth/test/login', payload: { email: `${name}-${stamp}@example.test`, role } });
  const token = new URL(String(res.headers.location)).searchParams.get('token')!;
  const me = await app.inject({ method: 'GET', url: '/api/auth/me', headers: { authorization: `Bearer ${token}` } });
  return { token, userId: me.json<{ data: { id: string } }>().data.id };
}

async function call<T = unknown>(s: Session | null, method: 'GET' | 'PATCH' | 'PUT' | 'DELETE' | 'POST', url: string, payload?: unknown, headers: Record<string, string> = {}) {
  const res = await app.inject({ method, url, headers: { ...(s ? { authorization: `Bearer ${s.token}` } : {}), ...headers }, ...(payload === undefined ? {} : { payload: payload as object }) });
  responses.push(`${res.statusCode} ${JSON.stringify(res.headers)} ${res.body}`);
  const body = res.body && String(res.headers['content-type']).includes('json') ? (res.json() as { data?: T; error?: { code?: string }; code?: string }) : {};
  return { statusCode: res.statusCode, data: body.data as T, code: body.error?.code ?? body.code ?? '', headers: res.headers, raw: res.rawPayload as Buffer, text: res.body };
}

const setDeployment = async (admin: Session, enabled: boolean) => {
  expect((await call(admin, 'PATCH', '/api/system-settings', { secrets: { agentUse: { enabled } } })).statusCode).toBe(200);
  policy.invalidate();
};
const setOwner = async (s: Session, body: { enabled?: boolean; provider?: 'vault' | 'builtin' }) =>
  expect((await call(s, 'PATCH', '/api/user-settings', { secrets: { ...(body.provider ? { provider: body.provider } : {}), ...(body.enabled !== undefined ? { agentUse: { enabled: body.enabled } } : {}) } })).statusCode).toBe(200);

async function saveLogin(s: Session, over: { name?: string; url?: string; password?: string } = {}) {
  const r = await call<{ id: string }>(s, 'POST', '/api/secrets', { name: over.name ?? `Shop ${randomUUID().slice(0, 6)}`, typeId: credentialTypeId, data: { username: USERNAME, password: over.password ?? PASSWORD, url: over.url ?? ORIGIN, totp: TOTP_SEED } });
  expect(r.statusCode).toBe(201);
  return r.data.id;
}
const open = async (s: Session, id: string, agentAccess: 'fill' | 'none' = 'fill') => expect((await call(s, 'PATCH', `/api/secrets/${id}/agent-access`, { agentAccess })).statusCode).toBe(200);

/** The fabric's registration for the owner (what the runner does when a run starts), and the credential it was handed. */
async function register(s: Session): Promise<string> {
  fabricCalls.length = 0;
  expect(await registrar.ensureRegistered(s.userId, { force: true })).toBe('registered');
  const call = fabricCalls.find((c) => c.op === 'register' && c.ownerId === s.userId)!;
  expect(call.registration).toMatchObject({ kind: 'console' });
  return call.registration!.accessToken;
}
const liveRun = (userId: string) => prisma.run.create({ data: { userId, goal: 'Sign in to the shop', status: 'running' } as never });
const internal = (token: string | null, route: 'lookup' | 'release' | 'code' | 'save', body: Record<string, unknown>) =>
  call(null, 'POST', `${CALLBACK}/${route}`, body, token ? { authorization: `Bearer ${token}` } : {});

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
  policy = app.get(SecretsPolicyService, { strict: false });
  registrar = app.get(SecretsProviderRegistrar, { strict: false });
  provider = app.get(BuiltinSecretsProvider, { strict: false });
  keys = app.get(SecretsStoreKeys, { strict: false });
  fabric = app.get<FabricSecretsRegistry>(FABRIC_SECRETS_REGISTRY, { strict: false });
  jest.spyOn(fabric, 'registerSecretsProvider').mockImplementation(async (ownerId, registration) => {
    fabricCalls.push({ op: 'register', ownerId, registration: { ...registration } });
  });
  jest.spyOn(fabric, 'unregisterSecretsProvider').mockImplementation(async (ownerId) => {
    fabricCalls.push({ op: 'unregister', ownerId });
  });
  const s = await login('store-types');
  const types = await call<{ id: string; name: string }[]>(s, 'GET', '/api/secret-types');
  credentialTypeId = types.data.find((t) => t.name === 'Credential')!.id;
});

afterAll(async () => {
  jest.restoreAllMocks();
  const admin = await login('store-reset', 'admin');
  await call(admin, 'PATCH', '/api/system-settings', { secrets: { agentUse: { enabled: false } } });
  await app?.close();
});

describe('the store as the owner uses it', () => {
  it('only the Credential type exists, and the parts of Vault the console does not mount answer 404', async () => {
    const s = await login('store-parts');
    const types = await call<{ name: string }[]>(s, 'GET', '/api/secret-types');
    expect(types.data.map((t) => t.name)).toEqual(['Credential']);
    const id = await saveLogin(s);
    for (const [m, url] of [
      ['POST', '/api/secrets/export'],
      ['GET', '/api/secrets/cards/summary'],
      ['POST', `/api/secrets/${id}/renew`],
      ['GET', `/api/secrets/${id}/attachments`],
      ['POST', `/api/secrets/${id}/attachments`],
    ] as const) {
      expect([m, url, (await call(s, m, url, {})).statusCode]).toEqual([m, url, 404]);
    }
    // Not mounted at all: the agent HTTP API, Vault's MCP, media, backups, card scanning.
    for (const url of ['/api/agent/v1/whoami', '/api/media/folders', '/api/backups/me', '/api/agent-activity']) expect([url, (await call(s, 'GET', url)).statusCode >= 400]).toEqual([url, true]);
  });

  it('refuses a secret of any type but Credential', async () => {
    const s = await login('store-type-only');
    const card = await prisma.secretType.create({ data: { name: `Card-${stamp}`, fields: [], isSystem: false } });
    const r = await call(s, 'POST', '/api/secrets', { name: 'A card', typeId: card.id, data: {} });
    expect(r.statusCode).toBe(422);
    await prisma.secretType.delete({ where: { id: card.id } });
  });

  it('creates a login and reads it back decrypted; versions work; another owner cannot read it', async () => {
    const a = await login('store-a');
    const b = await login('store-b');
    const id = await saveLogin(a);
    const read = await call<{ values: { username: string; password: string } }>(a, 'GET', `/api/secrets/${id}`);
    expect(read.statusCode).toBe(200);
    expect(read.data).toMatchObject({ values: { username: USERNAME, password: PASSWORD } });
    const upd = await call(a, 'PUT', `/api/secrets/${id}`, { data: { username: USERNAME, password: `${PASSWORD}-2`, url: ORIGIN } });
    expect(upd.statusCode).toBe(200);
    const versions = await call<{ items?: unknown[] } | unknown[]>(a, 'GET', `/api/secrets/${id}/versions`);
    expect(versions.statusCode).toBe(200);
    // Another owner of the same organization: refused, and nothing of the value in the body.
    const other = await call(b, 'GET', `/api/secrets/${id}`);
    expect([403, 404]).toContain(other.statusCode);
    expect(other.text).not.toContain(PASSWORD);
    expect((await call(b, 'GET', '/api/secrets')).text).not.toContain(id);
  });
});

describe('no role reads another owner’s secret value', () => {
  it('no `*_any` permission exists, and every role is refused (HTTP and in the database)', async () => {
    const owner = await login('store-any-owner');
    const id = await saveLogin(owner, { password: `${PASSWORD}-any` });
    await open(owner, id);

    // The permissions that would allow it are not registered, so no role can hold them.
    const any = await prisma.permission.findMany({ where: { name: { in: ['secrets:read_any', 'secrets:write_any', 'secrets:delete_any', 'media:read_any'] } } });
    expect(any).toEqual([]);
    const roles = await prisma.role.findMany({ select: { name: true, rolePermissions: { select: { permission: { select: { name: true } } } } } });
    expect(roles.length).toBeGreaterThanOrEqual(3);
    for (const role of roles) {
      for (const p of role.rolePermissions) expect([role.name, p.permission.name, /^(secrets|secret_types|media):.*_any$/.test(p.permission.name)]).toEqual([role.name, p.permission.name, false]);
    }

    for (const role of ['admin', 'org_admin', 'contributor', 'viewer'] as const) {
      const s = await login(`store-any-${role}`, role).catch(() => null);
      if (!s) continue; // a role the test login does not offer is covered by the database check above
      for (const [m, url, body] of [
        ['GET', `/api/secrets/${id}`, undefined],
        ['GET', `/api/secrets/${id}/versions`, undefined],
        ['PUT', `/api/secrets/${id}`, { name: 'taken over' }],
        ['DELETE', `/api/secrets/${id}`, undefined],
        ['POST', `/api/secrets/${id}/totp`, undefined],
        ['PATCH', `/api/secrets/${id}/agent-access`, { agentAccess: 'none' }],
      ] as const) {
        const r = await call(s, m, url, body);
        expect([role, m, url, r.statusCode >= 400]).toEqual([role, m, url, true]);
        expect(r.text).not.toContain(`${PASSWORD}-any`);
      }
      expect((await call(s, 'GET', '/api/secrets')).text).not.toContain(id);
    }
    expect(await prisma.secret.count({ where: { id } })).toBe(1);
  });
});

describe('the agent path: the provider and Vault’s rules', () => {
  let admin: Session;
  let owner: Session;
  let other: Session;
  let openId: string;
  let closedId: string;
  let otherId: string;

  beforeAll(async () => {
    admin = await login('store-agent-admin', 'admin');
    owner = await login('store-agent-owner');
    other = await login('store-agent-other');
    openId = await saveLogin(owner, { name: `Open ${stamp}` });
    closedId = await saveLogin(owner, { name: `Closed ${stamp}`, url: 'https://closed.example.test' });
    otherId = await saveLogin(other, { name: `Other ${stamp}` });
    await open(owner, openId);
    await open(other, otherId);
    await setDeployment(admin, true);
    await setOwner(owner, { enabled: true, provider: 'builtin' });
    await setOwner(other, { enabled: true, provider: 'builtin' });
  });

  afterAll(async () => {
    await setDeployment(admin, false);
  });

  const releaseField = async (itemId: string, field: 'username' | 'password', origin = ORIGIN) =>
    provider.release({ ownerId: owner.userId, itemId, field, origin, purpose: 'login' });
  const text = (b: { expose: <R>(fn: (x: Buffer) => R) => R }) => b.expose((x) => x.toString('utf8'));

  it('looks up by exact origin and releases the username and the password one field at a time', async () => {
    const items = await provider.lookup(owner.userId, ORIGIN, 'login');
    expect(items.map((i) => i.id)).toEqual([openId]);
    expect(items[0]).toMatchObject({ matchKind: 'exact', hasCode: true, username: USERNAME });
    expect(JSON.stringify(items)).not.toContain(PASSWORD);
    const u = await releaseField(openId, 'username');
    const p = await releaseField(openId, 'password');
    expect([text(u), text(p)]).toEqual([USERNAME, PASSWORD]);
    u.wipe();
    p.wipe();
    expect(u.wiped).toBe(true);
    const code = await provider.oneTimeCode({ ownerId: owner.userId, itemId: openId, origin: ORIGIN, purpose: 'login' });
    expect(text(code.value)).toMatch(/^\d{6}$/);
    code.value.wipe();
    // one field per call: anything else is not a login field of this provider
    await expect(provider.release({ ownerId: owner.userId, itemId: openId, field: 'card_number', origin: ORIGIN, purpose: 'login' })).rejects.toMatchObject({ code: 'unsupported' });
  });

  it('a closed login and another owner’s login give the identical not-found', async () => {
    const errors: SecretsProviderError[] = [];
    for (const id of [closedId, otherId, randomUUID()]) {
      const e = await releaseField(id, 'password', id === closedId ? 'https://closed.example.test' : ORIGIN).catch((x: SecretsProviderError) => x);
      expect(e).toBeInstanceOf(SecretsProviderError);
      errors.push(e as SecretsProviderError);
    }
    expect(new Set(errors.map((e) => `${e.code}|${e.message}`)).size).toBe(1);
    expect(errors[0]!.code).toBe('not_found');
    // and a lookup never lists them
    // (a login of the same site may be listed as a `site` match: listed, never fillable)
    const listed = await provider.lookup(owner.userId, 'https://closed.example.test', 'login');
    expect(listed.filter((i) => i.matchKind === 'exact')).toEqual([]);
    expect(listed.map((i) => i.id)).not.toContain(closedId);
  });

  it('a different origin is refused, and a look-alike is never released to', async () => {
    for (const origin of ['https://shop.example.test.evil.test', 'https://sub.shop.example.test', 'https://other.example.test']) {
      const e = await releaseField(openId, 'password', origin).catch((x: SecretsProviderError) => x);
      expect([origin, (e as SecretsProviderError).code]).toEqual([origin, 'origin_mismatch']);
    }
    // a downgraded scheme is not even a valid origin for Vault's agent contract
    const plain = await releaseField(openId, 'password', 'http://shop.example.test').catch((x: SecretsProviderError) => x);
    expect((plain as SecretsProviderError).code).toBe('refused');
  });

  it('the kill switches close everything: deployment, owner, and the chosen provider', async () => {
    await setDeployment(admin, false);
    await expect(releaseField(openId, 'password')).rejects.toMatchObject({ code: 'disabled' });
    await expect(provider.lookup(owner.userId, ORIGIN, 'login')).rejects.toMatchObject({ code: 'disabled' });
    await setDeployment(admin, true);
    await setOwner(owner, { enabled: false });
    await expect(releaseField(openId, 'password')).rejects.toMatchObject({ code: 'disabled' });
    await setOwner(owner, { enabled: true, provider: 'vault' });
    await expect(releaseField(openId, 'password')).rejects.toMatchObject({ code: 'disabled' });
    await setOwner(owner, { provider: 'builtin' });
    expect(text(await releaseField(openId, 'username'))).toBe(USERNAME);
    // Vault's own switch (agentAccess.enabled) is the deployment's: off there means off in Vault's pipeline too (above).
    // Closing a login to the agent takes effect at once.
    await open(owner, openId, 'none');
    await expect(releaseField(openId, 'password')).rejects.toMatchObject({ code: 'not_found' });
    await open(owner, openId, 'fill');
  });

  it('every use is audited (Vault’s rows, credential "embedded", the console’s label) and never carries a value', async () => {
    const rows = await prisma.auditEvent.findMany({ where: { action: { startsWith: 'agent.credential.' }, actorUserId: owner.userId }, orderBy: { createdAt: 'asc' } });
    expect(rows.length).toBeGreaterThan(0);
    expect(rows.some((r) => r.action === 'agent.credential.fill')).toBe(true);
    const meta = JSON.stringify(rows.map((r) => r.meta));
    expect(meta).toContain('hexactra-agent');
    expect(meta).not.toContain(PASSWORD);
    expect(meta).not.toContain(USERNAME);
  });

  it('rate-limits per minute like Vault (429 as rate_limited with a wait)', async () => {
    const limited = await login('store-rate');
    await setOwner(limited, { enabled: true, provider: 'builtin' });
    const id = await saveLogin(limited);
    await open(limited, id);
    let last: unknown;
    for (let i = 0; i < 70; i += 1) last = await provider.lookup(limited.userId, ORIGIN, 'login').catch((e: SecretsProviderError) => e);
    expect(last).toBeInstanceOf(SecretsProviderError);
    expect((last as SecretsProviderError).code).toBe('rate_limited');
  });

  describe('the fabric’s internal release route', () => {
    let token: string;
    let run: { id: string };

    beforeAll(async () => {
      // `other`'s account has a run of its own only in the "no live run" test below.
      run = await liveRun(owner.userId);
      token = await register(owner);
    });

    it('registers as kind "console" with an owner-bound credential and the callback address, never anything else', () => {
      expect(token).toMatch(/^sct_[A-Za-z0-9_-]{43}$/);
      const reg = fabricCalls.find((c) => c.op === 'register')!;
      expect(reg.registration).toMatchObject({ kind: 'console', baseUrl: expect.stringMatching(/\/api\/internal\/secrets-store\/v1$/) });
      expect(new Date(reg.registration!.expiresAt).getTime()).toBeGreaterThan(Date.now());
    });

    it('saves a login the owner typed by hand (#712): open to the agent, bound to the page, its password released again; a taken name is 409', async () => {
      const name = `Typed ${stamp}`;
      const typed = `MARKER-typed-${randomUUID()}`;
      // No live run is needed: the owner presses Save on the card when they like.
      const r = await internal(token, 'save', { owner_id: owner.userId, name, username: 'person-a@example.test', origin: 'https://typed-login.test', password: typed, purpose: 'save_login', client_label: 'Hexactra' });
      expect(r.statusCode).toBe(201);
      expect(r.headers['cache-control']).toBe('no-store');
      const id = (JSON.parse(r.text) as { id: string }).id;
      expect(r.text).not.toContain(typed);
      // The agent finds it on that page, and the store gives back what was typed.
      const found = await provider.lookup(owner.userId, 'https://typed-login.test', 'login');
      expect(found.map((f) => f.id)).toContain(id);
      expect(text(await provider.release({ ownerId: owner.userId, itemId: id, field: 'password', origin: 'https://typed-login.test', purpose: 'login' }))).toBe(typed);
      // The same name again: 409 name_taken, nothing created.
      const again = await internal(token, 'save', { owner_id: owner.userId, name, username: 'x@example.test', origin: 'https://typed-login.test', password: 'other', purpose: 'save_login' });
      expect(again.statusCode).toBe(409);
      expect((JSON.parse(again.text) as { code: string }).code).toBe('name_taken');
      // Another owner's id with this credential: refused.
      expect((await internal(token, 'save', { owner_id: other.userId, name: `X ${stamp}`, username: 'x@example.test', origin: 'https://typed-login.test', password: 'p', purpose: 'save_login' })).statusCode).toBe(401);
      // Ciphertext only in the database.
      const rows = await prisma.$queryRawUnsafe<{ t: string }[]>(`SELECT (SELECT row_to_json(s)::text FROM secrets s WHERE id = $1::uuid) || (SELECT coalesce(string_agg(row_to_json(v)::text, ''), '') FROM secret_versions v WHERE v.secret_id = $1::uuid) AS t`, id);
      expect(rows[0]!.t).not.toContain(typed);
    });

    it('releases one field as raw bytes, no-store, and nothing else', async () => {
      const r = await internal(token, 'release', { owner_id: owner.userId, item_id: openId, field: 'password', origin: ORIGIN, purpose: 'login', run_id: run.id });
      expect(r.statusCode).toBe(200);
      expect(r.headers['cache-control']).toBe('no-store');
      expect(String(r.headers['content-type'])).toContain('application/octet-stream');
      expect(r.raw.toString('utf8')).toBe(PASSWORD);
      const l = await internal(token, 'lookup', { owner_id: owner.userId, origin: ORIGIN });
      expect(l.statusCode).toBe(200);
      expect(l.headers['cache-control']).toBe('no-store');
      expect(JSON.parse(l.text).items).toHaveLength(1);
      expect(l.text).not.toContain(PASSWORD);
      const c = await internal(token, 'code', { owner_id: owner.userId, item_id: openId, origin: ORIGIN, purpose: 'login' });
      expect(c.statusCode).toBe(200);
      expect(c.raw.toString('utf8')).toMatch(/^\d{6}$/);
      expect(c.headers['x-expires-at']).toBeDefined();
    });

    it('the same refusals as the provider, with the contract’s codes', async () => {
      const bodyOf = (over: Record<string, unknown>) => ({ owner_id: owner.userId, item_id: openId, field: 'password', origin: ORIGIN, purpose: 'login', ...over });
      expect((await internal(token, 'release', bodyOf({ origin: 'https://evil.example.test' }))).statusCode).toBe(403);
      expect(JSON.parse((await internal(token, 'release', bodyOf({ origin: 'https://evil.example.test' }))).text)).toEqual({ code: 'origin_mismatch' });
      const missing = await internal(token, 'release', bodyOf({ item_id: randomUUID() }));
      const foreign = await internal(token, 'release', bodyOf({ item_id: otherId }));
      expect([missing.statusCode, foreign.statusCode]).toEqual([404, 404]);
      expect(missing.text).toBe(foreign.text);
      expect((await internal(token, 'release', bodyOf({ field: 'card_number' }))).statusCode).toBe(422);
      expect((await internal(token, 'release', bodyOf({ unexpected: true }))).statusCode).toBe(400);
    });

    it('is unreachable with a session, a personal access token and an AI app’s OAuth token (the same 401)', async () => {
      const pat = await call<{ token: string }>(owner, 'POST', '/api/pat', { name: 'store test', durationValue: 1, durationUnit: 'days' });
      expect(pat.statusCode).toBe(201);
      const appUrl = app.get(ConfigService).get<string>('appUrl')!.replace(/\/+$/, '');
      const client = await createOAuthTestClient(prisma as never, { name: 'Store test app', redirectUris: ['https://assistant-store.example.test/callback'], host: 'assistant-store.example.test', tokenEndpointAuthMethod: 'none' });
      const oauth = await mintOAuthTestToken(prisma as never, { userId: owner.userId, resourceId: 'mcp', scopes: ['runs:read'], appUrl, client: { id: client.id } });
      const body = { owner_id: owner.userId, item_id: openId, field: 'password', origin: ORIGIN, purpose: 'login' };
      for (const [what, credential] of [['session', owner.token], ['personal access token', pat.data.token], ['OAuth app token', oauth.token], ['nothing', null], ['a made-up callback credential', `sct_${'A'.repeat(43)}`]] as const) {
        const r = await internal(credential, 'release', body);
        expect([what, r.statusCode, r.text]).toEqual([what, 401, '{"code":"unauthorized"}']);
        expect(r.headers['cache-control']).toBe('no-store');
      }
    });

    it('works only for the credential’s own owner, and only with a live run', async () => {
      // another owner named in the body
      expect((await internal(token, 'release', { owner_id: other.userId, item_id: otherId, field: 'password', origin: ORIGIN, purpose: 'login' })).statusCode).toBe(401);
      // the owner's run is over: nothing is answered
      await prisma.run.updateMany({ where: { userId: owner.userId }, data: { status: 'succeeded' as never } });
      const idle = await internal(token, 'release', { owner_id: owner.userId, item_id: openId, field: 'password', origin: ORIGIN, purpose: 'login' });
      expect([idle.statusCode, idle.text]).toEqual([403, '{"code":"refused"}']);
      await prisma.run.updateMany({ where: { userId: owner.userId }, data: { status: 'running' as never } });
      // a run id that is not the owner's
      expect((await internal(token, 'release', { owner_id: owner.userId, item_id: openId, field: 'password', origin: ORIGIN, purpose: 'login', run_id: 'not-a-run-of-theirs' })).statusCode).toBe(403);
    });

    it('a credential expires, is replaced by a new registration and is revoked when the owner leaves the built-in store', async () => {
      const body = { owner_id: owner.userId, item_id: openId, field: 'username', origin: ORIGIN, purpose: 'login' };
      const second = await register(owner);
      expect((await internal(token, 'release', body)).statusCode).toBe(401); // replaced
      expect((await internal(second, 'release', body)).statusCode).toBe(200);
      await prisma.secretsStoreCallbackToken.updateMany({ where: { userId: owner.userId, revokedAt: null }, data: { expiresAt: new Date(Date.now() - 1000) } });
      expect((await internal(second, 'release', body)).statusCode).toBe(401); // expired
      const third = await register(owner);
      await setOwner(owner, { provider: 'vault' });
      fabricCalls.length = 0;
      expect(await registrar.ensureRegistered(owner.userId, { force: true })).not.toBe('registered');
      expect((await internal(third, 'release', body)).statusCode).toBe(401); // revoked (and the gate is closed anyway)
      await setOwner(owner, { provider: 'builtin' });
    });
  });
});

describe('what is stored', () => {
  it('the database holds ciphertext only: the seeded password, user name and TOTP seed are nowhere in it', async () => {
    const s = await login('store-cipher');
    const id = await saveLogin(s, { password: `${PASSWORD}-db` });
    const dump = [
      ...(await prisma.$queryRawUnsafe<{ t: string }[]>('SELECT row_to_json(t)::text AS t FROM secret_versions t')),
      ...(await prisma.$queryRawUnsafe<{ t: string }[]>('SELECT row_to_json(t)::text AS t FROM secrets t')),
      ...(await prisma.$queryRawUnsafe<{ t: string }[]>('SELECT row_to_json(t)::text AS t FROM secrets_store_data_keys t')),
      ...(await prisma.$queryRawUnsafe<{ t: string }[]>('SELECT row_to_json(t)::text AS t FROM secrets_store_callback_tokens t')),
    ]
      .map((r) => r.t)
      .join('\n');
    for (const marker of [PASSWORD, USERNAME, TOTP_SEED, 'MARKER-password']) expect(dump).not.toContain(marker);
    const version = await prisma.secretVersion.findFirstOrThrow({ where: { secretId: id, isCurrent: true } });
    expect(version.encryptedData).toMatch(new RegExp(`^ss1\\.${s.userId}\\.`));
    const dk = await prisma.secretsStoreDataKey.findUniqueOrThrow({ where: { userId: s.userId } });
    expect(dk.keyId).toBe(keys.ring.current.id);
    expect(dk.wrapped).not.toContain(TEST_STORE_KEY);
    // The excerpt the issue asks for (ciphertext and a wrapped key only), printed for the pull request.
    process.stdout.write(`DB-EXCERPT secret_versions.encrypted_data=${version.encryptedData.slice(0, 64)}... iv=${version.iv} auth_tag=${version.authTag}\nDB-EXCERPT secrets_store_data_keys.key_id=${dk.keyId} wrapped=${dk.wrapped.slice(0, 40)}...\n`);
  });

  it('a value is bound to its owner: a ciphertext copied to another owner’s row does not decrypt', async () => {
    const a = await login('store-bind-a');
    const b = await login('store-bind-b');
    const ida = await saveLogin(a, { password: `${PASSWORD}-bind` });
    const idb = await saveLogin(b);
    const va = await prisma.secretVersion.findFirstOrThrow({ where: { secretId: ida, isCurrent: true } });
    await prisma.secretVersion.updateMany({ where: { secretId: idb, isCurrent: true }, data: { encryptedData: va.encryptedData, iv: va.iv, authTag: va.authTag } });
    const r = await call(b, 'GET', `/api/secrets/${idb}`);
    expect(r.statusCode).toBeGreaterThanOrEqual(400);
    expect(r.text).not.toContain(`${PASSWORD}-bind`);
  });

  it('a rotation re-wraps data keys under the new store key and every login still decrypts; a wrong key fails closed', async () => {
    const s = await login('store-rotate');
    const id = await saveLogin(s, { password: `${PASSWORD}-rot` });
    const before = await prisma.secretsStoreDataKey.findUniqueOrThrow({ where: { userId: s.userId } });
    const oldRing = keys.ring;

    // 1. The deployment's key changes with no previous key: the data key cannot be unwrapped, and nothing is returned.
    const wrongRing = StoreKeyRing.fromEnv({ SECRETS_STORE_KEY: TEST_STORE_KEY_2 });
    (keys as unknown as { ring: StoreKeyRing }).ring = wrongRing;
    const closed = await call(s, 'GET', `/api/secrets/${id}`);
    expect(closed.statusCode).toBeGreaterThanOrEqual(400);
    expect(closed.text).not.toContain(`${PASSWORD}-rot`);

    // 2. With the previous key configured, nothing breaks, the Doctor shows the unfinished rotation, and the job re-wraps.
    const ring = StoreKeyRing.fromEnv({ SECRETS_STORE_KEY: TEST_STORE_KEY_2, SECRETS_STORE_KEY_PREVIOUS: TEST_STORE_KEY });
    (keys as unknown as { ring: StoreKeyRing }).ring = ring;
    expect((await call<{ values: { password: string } }>(s, 'GET', `/api/secrets/${id}`)).data).toMatchObject({ values: { password: `${PASSWORD}-rot` } });
    const check = await app.get(StoreKeyCheck, { strict: false }).run();
    expect(check.status).toBe('warn');
    const result = await app.get(SecretsStoreMaintenance, { strict: false }).run();
    expect(result.rewrapped).toBeGreaterThan(0);
    const after = await prisma.secretsStoreDataKey.findUniqueOrThrow({ where: { userId: s.userId } });
    expect(after.keyId).toBe(ring.current.id);
    expect(after.keyId).not.toBe(before.keyId);
    expect(after.wrapped).not.toBe(before.wrapped);
    expect(after.rewrappedAt).not.toBeNull();
    // the values were not touched
    const ver = await prisma.secretVersion.findFirstOrThrow({ where: { secretId: id, isCurrent: true } });
    expect(ver.encryptedData).toMatch(/^ss1\./);

    // 3. Without the previous key it still reads (everything is wrapped under the new one), and the Doctor passes.
    (keys as unknown as { ring: StoreKeyRing }).ring = StoreKeyRing.fromEnv({ SECRETS_STORE_KEY: TEST_STORE_KEY_2 });
    expect((await call<{ values: { password: string } }>(s, 'GET', `/api/secrets/${id}`)).data).toMatchObject({ values: { password: `${PASSWORD}-rot` } });
    expect((await app.get(StoreKeyCheck, { strict: false }).run()).status).toBe('pass');
    // the old key alone no longer reads it
    (keys as unknown as { ring: StoreKeyRing }).ring = oldRing;
    expect((await call(s, 'GET', `/api/secrets/${id}`)).statusCode).toBeGreaterThanOrEqual(400);

    // put everything back for the other tests: re-wrap under the original key
    (keys as unknown as { ring: StoreKeyRing }).ring = StoreKeyRing.fromEnv({ SECRETS_STORE_KEY: TEST_STORE_KEY, SECRETS_STORE_KEY_PREVIOUS: TEST_STORE_KEY_2 });
    await app.get(SecretsStoreMaintenance, { strict: false }).run();
    (keys as unknown as { ring: StoreKeyRing }).ring = oldRing;
    expect((await call(s, 'GET', `/api/secrets/${id}`)).statusCode).toBe(200);
  });

  it('the Doctor reports an owner key wrapped under a key the deployment no longer has', async () => {
    const s = await login('store-lost');
    await saveLogin(s);
    const prev = keys.ring;
    (keys as unknown as { ring: StoreKeyRing }).ring = StoreKeyRing.fromEnv({ SECRETS_STORE_KEY: TEST_STORE_KEY_2 });
    const r = await app.get(StoreKeyCheck, { strict: false }).run();
    (keys as unknown as { ring: StoreKeyRing }).ring = prev;
    expect(r.status).toBe('fail');
    expect(JSON.stringify(r)).not.toContain(TEST_STORE_KEY);
  });
});

describe('deleting a user', () => {
  it('removes their secrets, versions and data key (the data key with the user, the ownerless secrets by the upkeep job)', async () => {
    const s = await login('store-gone');
    const id = await saveLogin(s);
    expect(await prisma.secretsStoreDataKey.count({ where: { userId: s.userId } })).toBe(1);
    await prisma.user.delete({ where: { id: s.userId } });
    expect(await prisma.secretsStoreDataKey.count({ where: { userId: s.userId } })).toBe(0);
    // The foreign key is Vault's (SET NULL): the ownerless secret has no key any more and the upkeep job removes it.
    expect(await prisma.secret.findUnique({ where: { id } })).toMatchObject({ createdById: null });
    await app.get(SecretsStoreMaintenance, { strict: false }).run();
    expect(await prisma.secret.count({ where: { id } })).toBe(0);
    expect(await prisma.secretVersion.count({ where: { secretId: id } })).toBe(0);
  });
});

describe('nothing seeded leaks', () => {
  it('the seeded password, user name and TOTP seed appear in no log line, no audit row and no response but the explicit reads', async () => {
    const audit = JSON.stringify(await prisma.auditEvent.findMany({ orderBy: { createdAt: 'desc' }, take: 2000 }));
    for (const marker of [PASSWORD, USERNAME, TOTP_SEED]) expect(audit).not.toContain(marker);
    const log = logged.join('');
    for (const marker of [PASSWORD, USERNAME, TOTP_SEED, 'sct_']) expect(log).not.toContain(marker);
    // Responses: only the owner's own explicit reads (GET /api/secrets/:id, the internal release route) carry values.
    const leaking = responses.filter((r) => r.includes(PASSWORD) || r.includes(TOTP_SEED));
    for (const r of leaking) expect(r).toMatch(/^20[01] /);
    expect(responses.filter((r) => r.includes('"sct_')).length).toBe(0);
  });
});
