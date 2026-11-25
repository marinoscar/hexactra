// Hexactra passkeys in the built-in store (E47.2, #940), against a real database: the fabric saves a passkey, looks it up by RP ID,
// gets its private key back for one signature and counts the use, on the store's internal route with the owner-bound credential.
// Another site's RP ID, another owner and a session or no live run are refused; the private key is ciphertext only (a marker is
// nowhere in the database or a response but the release); the owner's list never holds a key; deleting the user removes the rows.
import './support/secrets-store-env';
import { randomUUID } from 'node:crypto';
import type { NestFastifyApplication } from '@nestjs/platform-fastify';

import { createApp } from '../src/main';
import { PrismaService } from '../src/prisma/prisma.service';
import { FABRIC_SECRETS_REGISTRY, type FabricSecretsRegistry, type SecretsProviderRegistration } from '../src/secrets/fabric-secrets-registry';
import { SecretsPolicyService } from '../src/secrets/secrets-policy.service';
import { SecretsProviderRegistrar } from '../src/secrets/secrets-provider.registrar';
import { StorePasskeys, rpIdAllowed } from '../src/secrets/builtin/store.passkeys';

let app: NestFastifyApplication;
let prisma: PrismaService;
let policy: SecretsPolicyService;
let registrar: SecretsProviderRegistrar;
let passkeys: StorePasskeys;
const stamp = `${Date.now()}`;
const CALLBACK = '/api/internal/secrets-store/v1';
const ORIGIN = 'https://login.example.com';
const KEY = Buffer.from(`MARKER-passkey-private-key-${randomUUID()}`);
const KEY_B64 = KEY.toString('base64url');
const fabricCalls: { ownerId: string; registration: SecretsProviderRegistration }[] = [];
const responses: string[] = [];

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
async function call(token: string | null, method: 'POST' | 'PATCH', url: string, payload?: object) {
  const res = await app.inject({ method, url, headers: token ? { authorization: `Bearer ${token}` } : {}, ...(payload ? { payload } : {}) });
  responses.push(res.body);
  const json = String(res.headers['content-type']).includes('json') ? (res.json() as Record<string, unknown>) : {};
  return { status: res.statusCode, json, raw: res.rawPayload };
}
const internal = (token: string, route: string, body: object) => call(token, 'POST', `${CALLBACK}/${route}`, body);
async function register(s: Session): Promise<string> {
  fabricCalls.length = 0;
  expect(await registrar.ensureRegistered(s.userId, { force: true })).toBe('registered');
  return fabricCalls.find((c) => c.ownerId === s.userId)!.registration.accessToken;
}
const liveRun = (userId: string) => prisma.run.create({ data: { userId, goal: 'Sign in with a passkey', status: 'running' } as never });

let admin: Session;
let owner: Session;
let other: Session;
let token: string;
let otherToken: string;
let runId: string;

beforeAll(async () => {
  app = await createApp();
  await app.init();
  await app.getHttpAdapter().getInstance().ready();
  prisma = app.get(PrismaService);
  policy = app.get(SecretsPolicyService, { strict: false });
  registrar = app.get(SecretsProviderRegistrar, { strict: false });
  passkeys = app.get(StorePasskeys, { strict: false });
  const fabric = app.get<FabricSecretsRegistry>(FABRIC_SECRETS_REGISTRY, { strict: false });
  jest.spyOn(fabric, 'registerSecretsProvider').mockImplementation(async (ownerId, registration) => void fabricCalls.push({ ownerId, registration: { ...registration } }));
  jest.spyOn(fabric, 'unregisterSecretsProvider').mockImplementation(async () => undefined);
  admin = await login('pk-admin', 'admin');
  owner = await login('pk-owner');
  other = await login('pk-other');
  expect((await call(admin.token, 'PATCH', '/api/system-settings', { secrets: { agentUse: { enabled: true } } })).status).toBe(200);
  policy.invalidate();
  for (const s of [owner, other]) expect((await call(s.token, 'PATCH', '/api/user-settings', { secrets: { provider: 'builtin', agentUse: { enabled: true } } })).status).toBe(200);
  runId = (await liveRun(owner.userId)).id;
  await liveRun(other.userId);
  token = await register(owner);
  otherToken = await register(other);
});

afterAll(async () => {
  jest.restoreAllMocks();
  await call(admin.token, 'PATCH', '/api/system-settings', { secrets: { agentUse: { enabled: false } } });
  await app?.close();
});

const save = (t: string, ownerId: string, over: object = {}) =>
  internal(t, 'passkey-save', { owner_id: ownerId, origin: ORIGIN, rp_id: 'example.com', credential_id: 'Y3JlZC0x', user_handle: 'dXNlci0x', user_name: 'person-a@example.test', public_key: 'cHVibGljLWtleQ', private_key: KEY_B64, run_id: runId, ...over });

describe('Hexactra passkeys in the built-in store (E47.2)', () => {
  let id: string;

  it('keeps a passkey the fabric made, as ciphertext only', async () => {
    const r = await save(token, owner.userId);
    expect(r.status).toBe(201);
    id = String(r.json.id);
    const row = await prisma.passkeyCredential.findUniqueOrThrow({ where: { id } });
    expect(row).toMatchObject({ ownerUserId: owner.userId, rpId: 'example.com', origin: ORIGIN, credentialId: 'Y3JlZC0x', signCount: 0, createdByRunId: runId });
    expect(row.keyCiphertext.startsWith(`ss1.${owner.userId}.`)).toBe(true);
    expect(JSON.stringify(row)).not.toContain(KEY_B64);
  });

  it('looks it up by RP ID from a page that may use it, and refuses another site', async () => {
    const r = await internal(token, 'passkey-lookup', { owner_id: owner.userId, origin: 'https://app.login.example.com', rp_id: 'example.com' });
    expect(r.status).toBe(200);
    expect(r.json).toEqual({ passkeys: [{ id, credential_id: 'Y3JlZC0x', user_handle: 'dXNlci0x', user_name: 'person-a@example.test', rp_id: 'example.com', sign_count: 0 }] });
    expect((await internal(token, 'passkey-lookup', { owner_id: owner.userId, origin: 'https://example.com.evil.com', rp_id: 'example.com' })).status).toBe(403);
    expect((await internal(token, 'passkey-lookup', { owner_id: owner.userId, origin: ORIGIN, rp_id: 'com' })).status).toBe(403);
  });

  it('releases the private key for one signature, and counts the use without ever going back', async () => {
    const r = await internal(token, 'passkey-release', { owner_id: owner.userId, origin: ORIGIN, rp_id: 'example.com', item_id: id, purpose: 'passkey', run_id: runId });
    expect(r.status).toBe(200);
    expect(r.raw.equals(KEY)).toBe(true);
    expect((await internal(token, 'passkey-used', { owner_id: owner.userId, item_id: id, sign_count: 3 })).status).toBe(200);
    expect((await internal(token, 'passkey-used', { owner_id: owner.userId, item_id: id, sign_count: 2 })).status).toBe(200);
    const row = await prisma.passkeyCredential.findUniqueOrThrow({ where: { id } });
    expect(row.signCount).toBe(3);
    expect(row.lastUsedAt).not.toBeNull();
  });

  it('refuses another RP ID, another owner, a session and a missing run', async () => {
    expect((await internal(token, 'passkey-release', { owner_id: owner.userId, origin: 'https://other.example.org', rp_id: 'other.example.org', item_id: id, purpose: 'passkey' })).status).toBe(403);
    // The other owner's own credential, naming the owner: refused as another owner.
    expect((await internal(otherToken, 'passkey-release', { owner_id: owner.userId, origin: ORIGIN, rp_id: 'example.com', item_id: id, purpose: 'passkey' })).status).toBe(401);
    // The other owner asking for the owner's passkey under their own name: not found.
    expect((await internal(otherToken, 'passkey-release', { owner_id: other.userId, origin: ORIGIN, rp_id: 'example.com', item_id: id, purpose: 'passkey' })).status).toBe(404);
    // A console session is not the fabric's credential.
    expect((await internal(owner.token, 'passkey-release', { owner_id: owner.userId, origin: ORIGIN, rp_id: 'example.com', item_id: id, purpose: 'passkey' })).status).toBe(401);
    // No live run: nothing is released.
    await prisma.run.updateMany({ where: { userId: owner.userId }, data: { status: 'succeeded' } as never });
    expect((await internal(token, 'passkey-release', { owner_id: owner.userId, origin: ORIGIN, rp_id: 'example.com', item_id: id, purpose: 'passkey' })).status).toBe(403);
    await prisma.run.update({ where: { id: runId }, data: { status: 'running' } as never });
  });

  it('lists the owner\'s passkeys without a key, and removes one for its owner only', async () => {
    const list = await passkeys.list(owner.userId);
    expect(list.map((p) => p.id)).toContain(id);
    expect(JSON.stringify(list)).not.toContain('key');
    expect(await passkeys.remove(other.userId, id)).toBe(false);
    const second = await save(token, owner.userId, { credential_id: 'Y3JlZC0y' });
    expect(await passkeys.remove(owner.userId, String(second.json.id))).toBe(true);
    expect(await prisma.passkeyCredential.count({ where: { id: String(second.json.id) } })).toBe(0);
  });

  it('never holds the key in plain text anywhere in the database, nor in any response but the release', async () => {
    const tables = await prisma.$queryRawUnsafe<{ table_name: string }[]>("SELECT table_name FROM information_schema.tables WHERE table_schema = 'public' AND table_type = 'BASE TABLE'");
    for (const { table_name } of tables) {
      const hit = await prisma.$queryRawUnsafe<{ n: bigint }[]>(`SELECT count(*) AS n FROM "${table_name}" t WHERE t::text LIKE $1 OR t::text LIKE $2`, `%${KEY.toString('utf8')}%`, `%${KEY_B64}%`);
      expect({ table: table_name, n: Number(hit[0]!.n) }).toEqual({ table: table_name, n: 0 });
    }
    expect(responses.filter((r) => r.includes(KEY_B64))).toEqual([]);
  });

  it('is deleted with its user', async () => {
    const gone = await login('pk-gone');
    expect((await call(gone.token, 'PATCH', '/api/user-settings', { secrets: { provider: 'builtin', agentUse: { enabled: true } } })).status).toBe(200);
    await liveRun(gone.userId);
    const t = await register(gone);
    const saved = await save(t, gone.userId, { run_id: undefined });
    expect({ status: saved.status, body: saved.json }).toMatchObject({ status: 201 });
    await prisma.user.delete({ where: { id: gone.userId } });
    expect(await prisma.passkeyCredential.count({ where: { ownerUserId: gone.userId } })).toBe(0);
  });
});

describe('the RP ID rule (the same as the fabric\'s)', () => {
  it('allows the host or a registrable parent, never a public suffix or another site', () => {
    expect(rpIdAllowed('login.example.com', 'https://login.example.com')).toBe(true);
    expect(rpIdAllowed('example.com', 'https://login.example.com')).toBe(true);
    expect(rpIdAllowed('example.co.uk', 'https://a.b.example.co.uk')).toBe(true);
    for (const [rp, o] of [['com', 'https://login.example.com'], ['co.uk', 'https://example.co.uk'], ['evil.com', 'https://login.example.com'], ['example.com', 'https://example.com.evil.com'], ['ample.com', 'https://login.example.com'], ['Example.com', 'https://example.com'], ['example.com', 'http://example.com']]) {
      expect({ rp, o, ok: rpIdAllowed(rp!, o!) }).toEqual({ rp, o, ok: false });
    }
    expect(rpIdAllowed('localhost', 'http://localhost:8080')).toBe(true);
  });
});
