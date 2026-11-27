// The second binding of the service credentials port (E50.3, #973), with in-memory stores and a fake secrets side: the user tier
// asks the owner's secrets provider only when they chose it, the organization and deployment tiers never; an unavailable provider
// (down, switched off) falls to the next tier or answers PROVIDER_UNAVAILABLE and never throws; the kill switch is read before the
// cache; the cache keeps a copy for at most 60 s and wipes it; a move both ways, and a failed write that leaves the key where it was.
import type { CredentialsService, OrgCredentialsService, UserCredentialsService } from '@marinoscar/platform-api/credentials';

import { SecretBytes } from '../src/secrets/secrets-provider.port';
import type { SecretsServiceKeys, ServiceKeyMiss, ServiceKeyRelease } from '../src/secrets/service-keys';
import { CredentialStoreServiceCredentials } from '../src/service-credentials/credential-store.binding';
import { RoutedServiceCredentials } from '../src/service-credentials/routed-service-credentials';
import { SERVICE_KEY_CACHE_MS, SecretsProviderServiceCredentials } from '../src/service-credentials/secrets-provider.binding';
import type { Who } from '../src/service-credentials/service-credential.port';
import { apiKeyShape, ServiceCredentialRegistry } from '../src/service-credentials/service-credential.registry';
import { ServiceCredentialError } from '../src/service-credentials/service-credentials.errors';

const REF = { service: 'web_search', name: 'brave' };
const ALICE: Who = { userId: 'u-alice', orgId: 'o-acme' };
const PROVIDER_KEY = 'PROVIDER-KEY-0123456789';
const CONSOLE_KEY = 'CONSOLE-KEY-0123456789';
const SYSTEM_KEY = 'SYSTEM-KEY-0123456789';

function fakeStores() {
  const rows = new Map<string, string>();
  const at = new Map<string, Date>();
  const users = {
    getSecret: async (u: string, p: string, n: string) => rows.get(`user:${u}:${p}:${n}`) ?? null,
    describe: async (u: string, p: string, n: string) => (at.has(`user:${u}:${p}:${n}`) ? { updatedAt: at.get(`user:${u}:${p}:${n}`)! } : null),
    setSecret: jest.fn(async (u: string, p: string, n: string, s: string) => {
      rows.set(`user:${u}:${p}:${n}`, s);
      at.set(`user:${u}:${p}:${n}`, new Date());
    }),
    deleteSecret: async (u: string, p: string, n: string) => {
      rows.delete(`user:${u}:${p}:${n}`);
      at.delete(`user:${u}:${p}:${n}`);
    },
  };
  const orgs = { getSecret: async () => null, describe: async () => null, setSecret: async () => undefined, deleteSecret: async () => undefined };
  const system = {
    getSecret: async (p: string, n: string) => rows.get(`system:${p}:${n}`) ?? null,
    describe: async (p: string, n: string) => (at.has(`system:${p}:${n}`) ? { updatedAt: at.get(`system:${p}:${n}`)! } : null),
    setSecret: async (p: string, n: string, s: string) => {
      rows.set(`system:${p}:${n}`, s);
      at.set(`system:${p}:${n}`, new Date());
    },
    deleteSecret: async () => undefined,
  };
  return { rows, users, orgs, system };
}

/** The secrets side: a provider holding at most one key, which can be down, switched off, or refuse writes. */
function fakeSecrets(provider: 'vault' | 'builtin' = 'builtin') {
  const state = { provider, value: null as string | null, at: null as Date | null, releases: true, down: false, failWrite: false, releaseCalls: 0 };
  const keys = {
    activeProvider: async () => state.provider,
    releasesEnabled: async () => state.releases,
    release: jest.fn(async (): Promise<ServiceKeyRelease> => {
      state.releaseCalls++;
      const miss = (reason: ServiceKeyMiss): ServiceKeyRelease => ({ ok: false, provider: state.provider, reason });
      if (!state.releases) return miss('disabled');
      if (state.down) return miss('unavailable');
      if (state.value === null) return miss('not_found');
      return { ok: true, provider: state.provider, value: SecretBytes.from(state.value) };
    }),
    describe: async () => ({ provider: state.provider, setAt: state.provider === 'builtin' ? state.at : null, writable: state.provider === 'builtin' }),
    save: async (_u: string, _r: unknown, _l: string, v: SecretBytes) => {
      if (state.provider !== 'builtin') return 'read_only' as const;
      if (state.failWrite) return 'unavailable' as const;
      state.value = v.expose((b) => b.toString('utf8'));
      state.at = new Date();
      return 'saved' as const;
    },
    remove: async () => {
      if (state.provider !== 'builtin') return 'read_only' as const;
      state.value = null;
      state.at = null;
      return 'removed' as const;
    },
    vaultHasScope: async () => true,
    builtinWritable: async () => state.provider === 'builtin',
  };
  return { state, keys };
}

function setup(provider: 'vault' | 'builtin' = 'builtin', binding: 'credential_store' | 'secrets_provider' = 'secrets_provider') {
  const registry = new ServiceCredentialRegistry();
  registry.register({ ref: REF, label: 'Brave Search API key', tiers: ['user', 'organization', 'system'], validate: apiKeyShape });
  const s = fakeStores();
  const store = new CredentialStoreServiceCredentials(registry, s.users as unknown as UserCredentialsService, s.orgs as unknown as OrgCredentialsService, s.system as unknown as CredentialsService);
  const secrets = fakeSecrets(provider);
  const binder = new SecretsProviderServiceCredentials(secrets.keys as unknown as SecretsServiceKeys);
  const settings = { doc: { serviceCredentials: { binding } } as Record<string, unknown> };
  const prisma = { userSettings: { findUnique: async () => ({ value: settings.doc }) } };
  const userSettings = {
    patchSettings: jest.fn(async (_u: string, patch: { serviceCredentials: { keys: Record<string, string> } }) => {
      const cur = settings.doc.serviceCredentials as { binding: string; keys?: Record<string, string> };
      settings.doc = { serviceCredentials: { ...cur, keys: { ...(cur.keys ?? {}), ...patch.serviceCredentials.keys } } };
    }),
  };
  const port = new RoutedServiceCredentials(registry, store, binder, prisma as never, userSettings as never);
  return { port, store, binder, secrets, settings, ...s };
}

const text = (v: SecretBytes) => v.expose((b) => b.toString('utf8'));

describe('which binding answers', () => {
  it('the user tier asks the secrets provider when the owner chose it, and the credential store when not', async () => {
    const a = setup('builtin', 'secrets_provider');
    a.secrets.state.value = PROVIDER_KEY;
    const r = await a.port.resolveDetailed(REF, ALICE);
    expect(r.found?.tier).toBe('user');
    expect(text(r.found!.value)).toBe(PROVIDER_KEY);

    const b = setup('builtin', 'credential_store');
    b.secrets.state.value = PROVIDER_KEY;
    await b.store.set(REF, 'user', ALICE, SecretBytes.from(CONSOLE_KEY));
    expect(text((await b.port.resolve(REF, ALICE))!.value)).toBe(CONSOLE_KEY);
    expect(b.secrets.keys.release).not.toHaveBeenCalled();
  });

  it('the organization and deployment tiers never ask the provider', async () => {
    const a = setup('builtin', 'secrets_provider');
    await a.store.set(REF, 'system', ALICE, SecretBytes.from(SYSTEM_KEY));
    const r = await a.port.resolveDetailed(REF, ALICE, { allowTiers: ['organization', 'system'] });
    expect(r.found?.tier).toBe('system');
    expect(a.secrets.keys.release).not.toHaveBeenCalled();
  });

  it('a provider with no key is "none", and the next tier answers', async () => {
    const a = setup();
    expect(await a.port.resolveDetailed(REF, ALICE)).toEqual({ found: null, reason: 'NONE' });
    await a.store.set(REF, 'system', ALICE, SecretBytes.from(SYSTEM_KEY));
    expect((await a.port.resolve(REF, ALICE))?.tier).toBe('system');
  });
});

describe('a provider that cannot answer', () => {
  it('down: falls to the deployment key, or answers PROVIDER_UNAVAILABLE; never throws', async () => {
    const a = setup();
    a.secrets.state.value = PROVIDER_KEY;
    a.secrets.state.down = true;
    expect(await a.port.resolveDetailed(REF, ALICE)).toEqual({ found: null, reason: 'PROVIDER_UNAVAILABLE' });
    await a.store.set(REF, 'system', ALICE, SecretBytes.from(SYSTEM_KEY));
    const r = await a.port.resolveDetailed(REF, ALICE);
    expect(r.found?.tier).toBe('system');
    expect(text(r.found!.value)).toBe(SYSTEM_KEY);
  });

  it('the kill switch off: no release is asked for, the cached value is wiped and not handed out', async () => {
    const a = setup();
    a.secrets.state.value = PROVIDER_KEY;
    expect(text((await a.port.resolve(REF, ALICE))!.value)).toBe(PROVIDER_KEY);
    expect(a.binder.cached).toBe(1);
    a.secrets.state.releases = false;
    a.secrets.keys.release.mockClear();
    expect(await a.port.resolveDetailed(REF, ALICE)).toEqual({ found: null, reason: 'PROVIDER_UNAVAILABLE' });
    expect(a.secrets.keys.release).not.toHaveBeenCalled();
    expect(a.binder.cached).toBe(0);
  });
});

describe('the cache', () => {
  it('keeps a copy for at most 60 s; each caller gets its own copy to wipe', async () => {
    const a = setup();
    let now = 1_000_000;
    a.binder.clock = () => now;
    a.secrets.state.value = PROVIDER_KEY;
    const first = (await a.port.resolve(REF, ALICE))!.value;
    first.wipe();
    const second = (await a.port.resolve(REF, ALICE))!.value;
    expect(text(second)).toBe(PROVIDER_KEY);
    expect(a.secrets.state.releaseCalls).toBe(1);
    now += SERVICE_KEY_CACHE_MS + 1;
    await a.port.resolve(REF, ALICE);
    expect(a.secrets.state.releaseCalls).toBe(2);
    a.binder.forget(ALICE.userId);
    expect(a.binder.cached).toBe(0);
  });
});

describe('moving a key', () => {
  it('to the built-in store and back; the old copy goes only after the write', async () => {
    const a = setup('builtin', 'credential_store');
    await a.store.set(REF, 'user', ALICE, SecretBytes.from(CONSOLE_KEY));
    expect(await a.port.move(REF, ALICE, 'secrets_provider')).toEqual({ binding: 'builtin', sourceRemoved: true });
    expect(a.secrets.state.value).toBe(CONSOLE_KEY);
    expect(await a.store.readTier(REF, 'user', ALICE)).toBeNull();
    expect(text((await a.port.resolve(REF, ALICE))!.value)).toBe(CONSOLE_KEY);

    expect(await a.port.move(REF, ALICE, 'credential_store')).toEqual({ binding: 'credential_store', sourceRemoved: true });
    expect(a.secrets.state.value).toBeNull();
    expect(text((await a.store.readTier(REF, 'user', ALICE))!)).toBe(CONSOLE_KEY);
    expect(a.binder.cached).toBe(0);
  });

  it('a failed write leaves the key where it was, both ways', async () => {
    const a = setup('builtin', 'credential_store');
    await a.store.set(REF, 'user', ALICE, SecretBytes.from(CONSOLE_KEY));
    a.secrets.state.failWrite = true;
    await expect(a.port.move(REF, ALICE, 'secrets_provider')).rejects.toMatchObject({ code: 'SERVICE_CREDENTIAL_PROVIDER_UNAVAILABLE' });
    expect(text((await a.store.readTier(REF, 'user', ALICE))!)).toBe(CONSOLE_KEY);
    expect(await a.port.userBinding(REF, ALICE.userId)).toBe('credential_store');

    const b = setup('builtin', 'secrets_provider');
    b.secrets.state.value = PROVIDER_KEY;
    b.users.setSecret.mockRejectedValueOnce(new Error('database down'));
    await expect(b.port.move(REF, ALICE, 'credential_store')).rejects.toThrow('database down');
    expect(b.secrets.state.value).toBe(PROVIDER_KEY);
    expect(await b.port.userBinding(REF, ALICE.userId)).toBe('secrets_provider');
  });

  it('into a remote Vault: only when the Vault answers with the key; out of it, the Vault copy stays', async () => {
    const a = setup('vault', 'credential_store');
    await a.store.set(REF, 'user', ALICE, SecretBytes.from(CONSOLE_KEY));
    await expect(a.port.move(REF, ALICE, 'secrets_provider')).rejects.toMatchObject({ code: 'SERVICE_CREDENTIAL_NOT_IN_PROVIDER' });
    expect(text((await a.store.readTier(REF, 'user', ALICE))!)).toBe(CONSOLE_KEY);
    a.secrets.state.value = PROVIDER_KEY;
    expect(await a.port.move(REF, ALICE, 'secrets_provider')).toEqual({ binding: 'vault', sourceRemoved: true });
    expect(await a.store.readTier(REF, 'user', ALICE)).toBeNull();
    expect(await a.port.move(REF, ALICE, 'credential_store')).toEqual({ binding: 'credential_store', sourceRemoved: false });
    expect(text((await a.store.readTier(REF, 'user', ALICE))!)).toBe(PROVIDER_KEY);
  });

  it('setting a key kept in a remote Vault is refused: the owner changes it in Vault', async () => {
    const a = setup('vault', 'secrets_provider');
    await expect(a.port.set(REF, 'user', ALICE, SecretBytes.from(CONSOLE_KEY))).rejects.toBeInstanceOf(ServiceCredentialError);
    await expect(a.port.set(REF, 'user', ALICE, SecretBytes.from(CONSOLE_KEY))).rejects.toMatchObject({ code: 'SERVICE_CREDENTIAL_PROVIDER_READ_ONLY' });
  });
});
