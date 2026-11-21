// The built-in store is switched on and off in Administration → Secrets (#711), never by an environment variable. With a key
// configured and no on/off variable, it is mounted but not offered until the administrator turns `secrets.store.enabled` on,
// which takes effect without a restart; turning it off again keeps the owner's choice and data but stops using the store.
import './support/secrets-store-key-only-env';
import type { NestFastifyApplication } from '@nestjs/platform-fastify';

import { createApp } from '../src/main';
import { PrismaService } from '../src/prisma/prisma.service';
import { SecretsPolicyService } from '../src/secrets/secrets-policy.service';
import { storeKeyId, StoreKeyRing } from '../src/secrets/builtin/store.keys';

const stamp = `${Date.now()}`;
let app: NestFastifyApplication;
let policy: SecretsPolicyService;
let skew = 0;

beforeAll(async () => {
  app = await createApp();
  await app.init();
  await app.getHttpAdapter().getInstance().ready();
  policy = app.get(SecretsPolicyService, { strict: false });
});
afterAll(async () => {
  // Leave the deployment as other specs expect it: the switch never set (the store specs that use the deprecated variable rely on it).
  await app?.get(PrismaService).$executeRawUnsafe(`UPDATE system_settings SET value = value #- '{secrets,store}'`);
  await app?.close();
});

async function login(name: string, role: 'contributor' | 'admin'): Promise<{ token: string; userId: string }> {
  const res = await app.inject({ method: 'POST', url: '/api/auth/test/login', payload: { email: `switch-${name}-${stamp}@example.test`, role } });
  const token = new URL(String(res.headers.location)).searchParams.get('token')!;
  const me = await app.inject({ method: 'GET', url: '/api/auth/me', headers: { authorization: `Bearer ${token}` } });
  return { token, userId: me.json<{ data: { id: string } }>().data.id };
}
const call = (method: 'GET' | 'PATCH' | 'PUT', url: string, token: string, payload?: unknown, headers: Record<string, string> = {}) =>
  app.inject({ method, url: `/api${url}`, headers: { authorization: `Bearer ${token}`, ...headers }, ...(payload !== undefined ? { payload: payload as object } : {}) });

async function setSwitch(admin: string, enabled: boolean) {
  const doc = (await call('GET', '/system-settings', admin)).json<{ data: { version: number } }>().data;
  const res = await call('PATCH', '/system-settings', admin, { secrets: { store: { enabled } } }, { 'if-match': String(doc.version) });
  expect(res.statusCode).toBe(200);
  // The policy caches the settings a few seconds: move its clock past that each time, as time would.
  skew += 60_000;
  const now = Date.now() + skew;
  policy.clock = () => now;
}

describe('the built-in store switch (#711)', () => {
  it('is mounted by its key, offered only once the administrator switches it on, without a restart, and stops when switched off', async () => {
    const admin = await login('admin', 'admin');
    const owner = await login('owner', 'contributor');

    // Mounted (a key), not offered: the owner's status route answers 404, the administrator sees why.
    expect((await call('GET', '/secrets/store/status', owner.token)).statusCode).toBe(404);
    const state = (await call('GET', '/secrets/store/state', admin.token)).json<{ data: Record<string, unknown> }>().data;
    expect(state).toEqual({ keyConfigured: true, mounted: true, enabled: false, keyId: StoreKeyRing.fromEnv().current.id, legacyEnv: false });
    expect(state.keyId).toBe(storeKeyId(Buffer.from(process.env.SECRETS_STORE_KEY!, 'base64')));
    // The owner cannot read it, and nothing in it is a key.
    expect((await call('GET', '/secrets/store/state', owner.token)).statusCode).toBe(403);
    expect(JSON.stringify(state)).not.toContain(process.env.SECRETS_STORE_KEY!);

    // The owner chose the store earlier: while it is off, their provider is the Vault path (nothing goes through the store).
    expect((await call('PATCH', '/user-settings', owner.token, { secrets: { provider: 'builtin' } })).statusCode).toBeLessThan(300);
    expect(await policy.activeProvider(owner.userId)).toBe('vault');

    // On in the admin panel: offered at once.
    await setSwitch(admin.token, true);
    expect((await call('GET', '/secrets/store/state', admin.token)).json<{ data: { enabled: boolean } }>().data.enabled).toBe(true);
    const status = await call('GET', '/secrets/store/status', owner.token);
    expect(status.statusCode).toBe(200);
    expect(status.json<{ data: { provider: string } }>().data.provider).toBe('builtin');
    expect(await policy.activeProvider(owner.userId)).toBe('builtin');

    // Off again: the owner's choice is kept, the store is not used.
    await setSwitch(admin.token, false);
    expect((await call('GET', '/secrets/store/status', owner.token)).statusCode).toBe(404);
    expect(await policy.activeProvider(owner.userId)).toBe('vault');
  });
});
