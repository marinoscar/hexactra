// Keys of outside services in the owner's secrets provider (E50.3, #973) against a real, migrated and seeded database, the
// built-in store in-process and the FAKE VAULT (contract 1.4): a key moved into the built-in store and back, released through the
// service credentials port, the deployment's kill switch, a failed write that leaves the key where it was, the fabric unable to
// ask for an `api_key` item and the saved-login lookup never listing one; a key in the owner's remote Vault read with the owner's
// grant (scope `vault:service_keys_read`), cached, refused without the scope, and a Vault that is down making web search answer
// "not available" without failing anything; and a scan of every response, log line, audit row, activity row, settings row, stored
// row and span for the seeded values.
import './support/secrets-store-env';
import { randomUUID } from 'node:crypto';
import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import { WebToolError } from '@marinoscar/hexactra-web-agent';

import { createApp } from '../src/main';
import { PrismaService } from '../src/prisma/prisma.service';
import { BuiltinSecretsProvider } from '../src/secrets/builtin/store.provider';
import { FABRIC_SECRETS_REGISTRY, type FabricSecretsRegistry, type SecretsProviderRegistration } from '../src/secrets/fabric-secrets-registry';
import { SecretsPolicyService } from '../src/secrets/secrets-policy.service';
import { SecretsProviderRegistrar } from '../src/secrets/secrets-provider.registrar';
import { VaultConnectionService, BINDING_COOKIE } from '../src/secrets/vault-connection.service';
import { CredentialStoreServiceCredentials } from '../src/service-credentials/credential-store.binding';
import { SecretsProviderServiceCredentials } from '../src/service-credentials/secrets-provider.binding';
import { SERVICE_CREDENTIAL_PORT, type ServiceCredentialPort, type Who } from '../src/service-credentials/service-credential.port';
import { WebSearchService } from '../src/web-search/web-search.service';
import { FakeVault, startFakeVault } from './support/fake-vault';
import { installMemoryTracing, spanText } from './helpers/otel-memory';

const stamp = randomUUID().slice(0, 8);
const MARKER = `MARKERKEY${randomUUID().replace(/-/g, '')}`;
const SYSTEM_MARKER = `MARKERSYS${randomUUID().replace(/-/g, '')}`;
const CLIENT_SECRET = `MARKER-client-secret-${randomUUID()}`;
const REF = { service: 'web_search', name: 'brave' };
const OWN = '/api/service-credentials/web_search/brave';
const CALLBACK = '/api/internal/secrets-store/v1';

let app: NestFastifyApplication;
let prisma: PrismaService;
let policy: SecretsPolicyService;
let port: ServiceCredentialPort;
let binder: SecretsProviderServiceCredentials;
let store: CredentialStoreServiceCredentials;
let vault: FakeVault;
let connection: VaultConnectionService;
let admin: Session;
const trace = installMemoryTracing();
const responses: string[] = [];
const logged: string[] = [];
const userIds: string[] = [];
const fabricCalls: { ownerId: string; registration?: SecretsProviderRegistration }[] = [];

interface Session {
  token: string;
  userId: string;
  orgId: string | null;
}

async function login(name: string, role: 'contributor' | 'admin' = 'contributor'): Promise<Session> {
  const res = await app.inject({ method: 'POST', url: '/api/auth/test/login', payload: { email: `${name}-${stamp}@example.test`, role } });
  const token = new URL(String(res.headers.location)).searchParams.get('token')!;
  const me = await app.inject({ method: 'GET', url: '/api/auth/me', headers: { authorization: `Bearer ${token}` } });
  const data = me.json<{ data: { id: string; activeOrg?: { id: string } | null } }>().data;
  userIds.push(data.id);
  return { token, userId: data.id, orgId: data.activeOrg?.id ?? null };
}

async function call<T = unknown>(s: Session | null, method: 'GET' | 'PATCH' | 'PUT' | 'DELETE' | 'POST', url: string, payload?: unknown, headers: Record<string, string> = {}) {
  const res = await app.inject({ method, url, headers: { ...(s ? { authorization: `Bearer ${s.token}` } : {}), ...headers }, ...(payload === undefined ? {} : { payload: payload as object }) });
  responses.push(`${res.statusCode} ${JSON.stringify(res.headers)} ${res.body}`);
  const body = res.body && String(res.headers['content-type']).includes('json') ? (res.json() as { data?: T; error?: { code?: string; details?: Record<string, unknown> }; code?: string; details?: Record<string, unknown> }) : {};
  return { statusCode: res.statusCode, data: body.data as T, code: body.error?.code ?? body.code ?? '', details: body.error?.details ?? body.details, headers: res.headers };
}

const who = (s: Session): Who => ({ userId: s.userId, orgId: s.orgId });
const valueOf = async (s: Session) => {
  const r = await port.resolveDetailed(REF, who(s), { allowTiers: ['user', 'system'] });
  if (!r.found) return { reason: r.reason };
  const text = r.found.value.expose((b) => b.toString('utf8'));
  r.found.value.wipe();
  return { tier: r.found.tier, text };
};
const setDeployment = async (body: { agentUse?: boolean; store?: boolean }) => {
  expect((await call(admin, 'PATCH', '/api/system-settings', { secrets: { ...(body.agentUse !== undefined ? { agentUse: { enabled: body.agentUse } } : {}), ...(body.store !== undefined ? { store: { enabled: body.store } } : {}) } })).statusCode).toBe(200);
  policy.invalidate();
};
const setOwner = async (s: Session, body: { enabled?: boolean; provider?: 'vault' | 'builtin' }) =>
  expect((await call(s, 'PATCH', '/api/user-settings', { secrets: { ...(body.provider ? { provider: body.provider } : {}), ...(body.enabled !== undefined ? { agentUse: { enabled: body.enabled } } : {}) } })).statusCode).toBe(200);

interface View {
  service: string;
  name: string;
  userBinding: string;
  tier: string | null;
  tiers: { user: { set: boolean; setAt: string | null } };
  secretsProvider: { id: string; writable: boolean; releasesEnabled: boolean; ready: boolean } | null;
}
const viewOf = async (s: Session) => (await call<View[]>(s, 'GET', '/api/service-credentials')).data.find((v) => v.service === 'web_search' && v.name === 'brave')!;

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
  port = app.get<ServiceCredentialPort>(SERVICE_CREDENTIAL_PORT, { strict: false });
  binder = app.get(SecretsProviderServiceCredentials, { strict: false });
  store = app.get(CredentialStoreServiceCredentials, { strict: false });
  connection = app.get(VaultConnectionService, { strict: false });
  const fabric = app.get<FabricSecretsRegistry>(FABRIC_SECRETS_REGISTRY, { strict: false });
  jest.spyOn(fabric, 'registerSecretsProvider').mockImplementation(async (ownerId, registration) => {
    fabricCalls.push({ ownerId, registration: { ...registration } });
  });
  jest.spyOn(fabric, 'unregisterSecretsProvider').mockImplementation(async () => undefined);
  vault = await startFakeVault({ clientSecret: CLIENT_SECRET, redirectUris: [connection.redirectUri()], contract: '1.4' });
  admin = await login('svckey-admin', 'admin');
  await setDeployment({ agentUse: true, store: true });
});

afterAll(async () => {
  jest.restoreAllMocks();
  await call(admin, 'PATCH', '/api/system-settings', { secrets: { agentUse: { enabled: false } } });
  await call(admin, 'DELETE', '/api/service-credentials/admin/web_search/brave');
  // Leave the deployment as other specs expect it: the store's switch never set (secrets-store-switch.db.spec.ts relies on it).
  await prisma.$executeRawUnsafe(`UPDATE system_settings SET value = value #- '{secrets,store}'`);
  await vault?.stop();
  await trace.uninstall();
  await app?.close();
});

describe('the built-in store', () => {
  let owner: Session;

  beforeAll(async () => {
    owner = await login('svckey-builtin');
    await setOwner(owner, { provider: 'builtin' });
  });

  it('moves the owner\'s key into the store, where it is ciphertext, and the port releases it from there', async () => {
    expect((await call(owner, 'PUT', OWN, { value: MARKER })).statusCode).toBe(204);
    expect((await viewOf(owner)).userBinding).toBe('credential_store');
    const moved = await call<{ binding: string; sourceRemoved: boolean }>(owner, 'POST', `${OWN}/move`, { to: 'secrets_provider' });
    expect([moved.statusCode, moved.data]).toEqual([200, { binding: 'builtin', sourceRemoved: true }]);
    // The console's copy is gone; the store holds a Service Key opened to the agent.
    expect(await store.readTier(REF, 'user', who(owner))).toBeNull();
    const item = await prisma.secret.findFirstOrThrow({ where: { createdById: owner.userId, type: { name: 'Service Key', isSystem: true } }, include: { versions: true } });
    expect(item.agentAccess).toBe('fill');
    expect(JSON.stringify(item)).not.toContain(MARKER);

    const v = await viewOf(owner);
    expect(v).toMatchObject({ userBinding: 'builtin', tier: 'user', tiers: { user: { set: true } }, secretsProvider: { id: 'builtin', writable: true, releasesEnabled: true, ready: true } });
    expect(v.tiers.user.setAt).not.toBeNull();

    binder.forget(owner.userId);
    expect(await valueOf(owner)).toEqual({ tier: 'user', text: MARKER });
    // Audited on the owner's Activity (never the value) and in the store's own trail.
    const rows = await prisma.secretsActivity.findMany({ where: { userId: owner.userId, event: 'service_key' } });
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ provider: 'builtin', itemId: 'web_search.brave', purpose: 'service_call', outcome: 'ok', released: true });
    const activity = await call<{ items: { event: string; serviceKey: string | null; outcome: string }[] }>(owner, 'GET', '/api/secrets/activity');
    expect(activity.data.items[0]).toMatchObject({ event: 'service_key', serviceKey: 'web_search.brave', outcome: 'ok' });
  });

  it('is never offered as a login, and the fabric cannot ask for an api_key item', async () => {
    const provider = app.get(BuiltinSecretsProvider, { strict: false });
    await setOwner(owner, { enabled: true });
    const listed = await provider.lookup(owner.userId, 'https://search.example.test', 'login');
    expect(listed).toEqual([]);
    fabricCalls.length = 0;
    expect(await app.get(SecretsProviderRegistrar, { strict: false }).ensureRegistered(owner.userId, { force: true })).toBe('registered');
    const token = fabricCalls.find((c) => c.ownerId === owner.userId)!.registration!.accessToken!;
    const r = await call(null, 'POST', `${CALLBACK}/lookup`, { owner_id: owner.userId, origin: 'https://search.example.test', kind: 'api_key' }, { authorization: `Bearer ${token}` });
    expect(r.statusCode).toBe(400);
    await setOwner(owner, { enabled: false });
  });

  it('the deployment\'s kill switch stops the release: the next tier answers, or "not available"', async () => {
    await valueOf(owner); // cached
    await setDeployment({ agentUse: false });
    expect(await valueOf(owner)).toEqual({ reason: 'PROVIDER_UNAVAILABLE' });
    expect(binder.cached).toBe(0);
    expect((await call(admin, 'PUT', '/api/service-credentials/admin/web_search/brave', { value: SYSTEM_MARKER })).statusCode).toBe(204);
    expect(await valueOf(owner)).toEqual({ tier: 'system', text: SYSTEM_MARKER });
    await setDeployment({ agentUse: true });
    expect(await valueOf(owner)).toEqual({ tier: 'user', text: MARKER });
    expect((await call(admin, 'DELETE', '/api/service-credentials/admin/web_search/brave')).statusCode).toBe(204);
  });

  it('a failed write leaves the key in the store; the move back then works and removes the store\'s copy', async () => {
    const spy = jest.spyOn(store, 'set').mockRejectedValueOnce(new Error('the credential store is down'));
    const failed = await call(owner, 'POST', `${OWN}/move`, { to: 'credential_store' });
    expect(failed.statusCode).toBe(500);
    spy.mockRestore();
    expect((await viewOf(owner)).userBinding).toBe('builtin');
    binder.forget(owner.userId);
    expect(await valueOf(owner)).toEqual({ tier: 'user', text: MARKER });

    const back = await call<{ binding: string; sourceRemoved: boolean }>(owner, 'POST', `${OWN}/move`, { to: 'credential_store' });
    expect([back.statusCode, back.data]).toEqual([200, { binding: 'credential_store', sourceRemoved: true }]);
    expect(await prisma.secret.count({ where: { createdById: owner.userId, type: { name: 'Service Key', isSystem: true } } })).toBe(0);
    expect(await valueOf(owner)).toEqual({ tier: 'user', text: MARKER });
    expect((await viewOf(owner)).userBinding).toBe('credential_store');
    expect(await prisma.auditEvent.count({ where: { actorUserId: owner.userId, action: 'service_credential.moved' } })).toBe(2);
  });

  it('the store switched off: a write into it is refused and nothing moves', async () => {
    await setDeployment({ store: false });
    const r = await call(owner, 'POST', `${OWN}/move`, { to: 'secrets_provider' });
    // With the store off the owner's provider is Vault (not connected): the key has nowhere to go.
    expect(r.statusCode).toBe(409);
    expect(await valueOf(owner)).toEqual({ tier: 'user', text: MARKER });
    await setDeployment({ store: true });
  });
});

describe('the remote Vault', () => {
  async function connected(name: string, allowServiceKeys: boolean): Promise<Session> {
    const s = await login(name);
    expect((await call(s, 'PUT', '/api/secrets/vault/client', { baseUrl: vault.baseUrl, clientId: vault.options.clientId, clientSecret: CLIENT_SECRET })).statusCode).toBe(200);
    const start = await call<{ authorizeUrl: string }>(s, 'POST', '/api/secrets/vault/connect', allowServiceKeys ? { allowServiceKeys: true } : {});
    expect(start.statusCode).toBe(200);
    expect(new URL(start.data.authorizeUrl).searchParams.get('scope')!.split(' ').includes('vault:service_keys_read')).toBe(allowServiceKeys);
    const location = await vault.consent(start.data.authorizeUrl);
    const raw = start.headers['set-cookie'];
    const binding = new RegExp(`${BINDING_COOKIE}=([^;]+)`).exec(Array.isArray(raw) ? String(raw[0]) : String(raw))![1]!;
    const u = new URL(location);
    const res = await app.inject({ method: 'GET', url: `${u.pathname}${u.search}`, headers: { cookie: `${BINDING_COOKIE}=${binding}` } });
    expect(res.headers.location).toBe('/settings/secrets?vault=connected');
    return s;
  }
  const brave = () => vault.serviceKeys.find((k) => k.name === 'brave')!.value;
  const serviceKeyCalls = () => vault.requests.filter((r) => r.path.startsWith('/api/agent/v1/service-keys/')).length;

  it('without the scope, Move cannot find the key, and the key stays in the console', async () => {
    const s = await connected('svckey-noscope', false);
    expect((await call(s, 'PUT', OWN, { value: MARKER })).statusCode).toBe(204);
    expect((await viewOf(s)).secretsProvider).toMatchObject({ id: 'vault', writable: false, ready: false });
    const r = await call(s, 'POST', `${OWN}/move`, { to: 'secrets_provider' });
    expect([r.statusCode, r.code, r.details?.reason]).toEqual([409, 'SERVICE_CREDENTIAL_NOT_IN_PROVIDER', 'needs_scope']);
    expect(await valueOf(s)).toEqual({ tier: 'user', text: MARKER });
  });

  it('with the scope: Move checks the Vault holds the key, the port reads it with the owner\'s grant and caches it', async () => {
    const s = await connected('svckey-vault', true);
    expect((await call(s, 'PUT', OWN, { value: MARKER })).statusCode).toBe(204);
    expect((await viewOf(s)).secretsProvider).toMatchObject({ id: 'vault', writable: false, ready: true });
    const moved = await call<{ binding: string; sourceRemoved: boolean }>(s, 'POST', `${OWN}/move`, { to: 'secrets_provider' });
    expect([moved.statusCode, moved.data]).toEqual([200, { binding: 'vault', sourceRemoved: true }]);
    expect(await store.readTier(REF, 'user', who(s))).toBeNull();
    expect(await viewOf(s)).toMatchObject({ userBinding: 'vault', tier: 'user', tiers: { user: { set: true, setAt: null } } });
    // Setting it here is refused: the owner changes it in Vault.
    const put = await call(s, 'PUT', OWN, { value: MARKER });
    expect([put.statusCode, put.code]).toEqual([409, 'SERVICE_CREDENTIAL_PROVIDER_READ_ONLY']);

    binder.forget(s.userId);
    const before = serviceKeyCalls();
    expect(await valueOf(s)).toEqual({ tier: 'user', text: brave() });
    expect(await valueOf(s)).toEqual({ tier: 'user', text: brave() });
    expect(serviceKeyCalls()).toBe(before + 1);
    expect(await prisma.secretsActivity.count({ where: { userId: s.userId, event: 'service_key', provider: 'vault', outcome: 'ok' } })).toBe(2); // the check of Move, and the first read (the second came from the cache)

    // Vault's own switch off: not available, the run would continue.
    binder.forget(s.userId);
    vault.setAgentAccess(false);
    expect(await valueOf(s)).toEqual({ reason: 'PROVIDER_UNAVAILABLE' });
    vault.setAgentAccess(true);
  });

  it('a Vault that is down: web search answers UNAVAILABLE (the agent may use the browser), nothing throws anything else', async () => {
    const s = await connected('svckey-down', true);
    expect((await call(s, 'POST', `${OWN}/move`, { to: 'secrets_provider' })).statusCode).toBe(200);
    const search = app.get(WebSearchService, { strict: false });
    expect((await search.status(s.userId, s.orgId)).enabled).toBe(true);
    binder.forget(s.userId);
    await vault.stop();
    try {
      expect(await valueOf(s)).toEqual({ reason: 'PROVIDER_UNAVAILABLE' });
      const err = await search.search(who(s), { query: 'example widgets', count: 1, freshness: null, site: null, signal: new AbortController().signal }).catch((e: unknown) => e);
      expect(err).toBeInstanceOf(WebToolError);
      expect((err as WebToolError).code).toBe('UNAVAILABLE');
      // The port a run binds (E50.7, `forUser`) answers the same: the agent is told search is not available.
      const runPort = await search.forUser(s.userId, s.orgId);
      expect(runPort).not.toBeNull();
      const viaRun = await runPort!.search({ query: 'example widgets', count: 1, freshness: null, site: null, signal: new AbortController().signal }).catch((e: unknown) => e);
      expect((viaRun as WebToolError).code).toBe('UNAVAILABLE');
      // The connection is not marked broken by an outage.
      expect((await prisma.secretsConnection.findUniqueOrThrow({ where: { userId_provider: { userId: s.userId, provider: 'vault' } } })).status).toBe('connected');
    } finally {
      const port0 = Number(new URL(vault.baseUrl).port);
      await vault.start(port0);
    }
  });
});

describe('nothing secret is ever shown', () => {
  it('no response, log line, audit row, activity row, settings row, stored row or span holds a seeded value', async () => {
    const markers = [MARKER, SYSTEM_MARKER, CLIENT_SECRET, ...vault.serviceKeys.map((k) => k.value)];
    const audits = JSON.stringify(await prisma.auditEvent.findMany({ where: { actorUserId: { in: userIds } } }));
    const activity = JSON.stringify(await prisma.secretsActivity.findMany({ where: { userId: { in: userIds } } }));
    const settings = JSON.stringify(await prisma.userSettings.findMany({ where: { userId: { in: userIds } } }));
    const stored = JSON.stringify(await prisma.secret.findMany({ where: { createdById: { in: userIds } }, include: { versions: true } }));
    const spans = trace.spans().map(spanText).join('\n');
    for (const m of markers) {
      for (const [where, text] of [['responses', responses.join('\n')], ['logs', logged.join('')], ['audit', audits], ['activity', activity], ['settings', settings], ['stored', stored], ['spans', spans]] as const) {
        expect({ where, leaked: text.includes(m) }).toEqual({ where, leaked: false });
      }
    }
  });
});
