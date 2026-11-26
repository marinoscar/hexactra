// The service credentials port and its credential store binding (E50.2, #972), with in-memory stores: the tier order, `allowTiers`,
// an unregistered reference refused, the registry's rules, `status` without a value, and the envelope that keeps every character of
// a key out of the store's plaintext hint.
import { deriveHint, type CredentialsService, type OrgCredentialsService, type UserCredentialsService } from '@marinoscar/platform-api/credentials';

import { SecretBytes } from '../src/secrets/secrets-provider.port';
import { CredentialStoreServiceCredentials, seal, unseal } from '../src/service-credentials/credential-store.binding';
import type { Who } from '../src/service-credentials/service-credential.port';
import { apiKeyShape, ServiceCredentialRegistry } from '../src/service-credentials/service-credential.registry';
import { ServiceCredentialError } from '../src/service-credentials/service-credentials.errors';

interface Row {
  secret: string;
  updatedAt: Date;
}

function fakeStores() {
  const rows = new Map<string, Row>();
  const put = (k: string, secret: string) => rows.set(k, { secret, updatedAt: new Date() });
  const get = (k: string) => rows.get(k)?.secret ?? null;
  const info = (k: string) => (rows.has(k) ? { updatedAt: rows.get(k)!.updatedAt } : null);
  const users = {
    getSecret: async (u: string, p: string, n: string) => get(`user:${u}:${p}:${n}`),
    describe: async (u: string, p: string, n: string) => info(`user:${u}:${p}:${n}`),
    setSecret: async (u: string, p: string, n: string, s: string) => void put(`user:${u}:${p}:${n}`, s),
    deleteSecret: async (u: string, p: string, n: string) => void rows.delete(`user:${u}:${p}:${n}`),
  };
  const orgs = {
    getSecret: async (o: string, p: string, n: string) => get(`org:${o}:${p}:${n}`),
    describe: async (o: string, p: string, n: string) => info(`org:${o}:${p}:${n}`),
    setSecret: async (o: string, p: string, n: string, s: string) => void put(`org:${o}:${p}:${n}`, s),
    deleteSecret: async (o: string, p: string, n: string) => void rows.delete(`org:${o}:${p}:${n}`),
  };
  const system = {
    getSecret: async (p: string, n: string) => get(`system:${p}:${n}`),
    describe: async (p: string, n: string) => info(`system:${p}:${n}`),
    setSecret: async (p: string, n: string, s: string) => void put(`system:${p}:${n}`, s),
    deleteSecret: async (p: string, n: string) => void rows.delete(`system:${p}:${n}`),
  };
  return { rows, users, orgs, system };
}

const REF = { service: 'web_search', name: 'brave' };
const ALICE: Who = { userId: 'u-alice', orgId: 'o-acme' };
const BOB: Who = { userId: 'u-bob', orgId: null };
const key = (s: string) => SecretBytes.from(s);
const read = async (p: Promise<{ tier: string; value: SecretBytes } | null>) => {
  const r = await p;
  return r ? { tier: r.tier, value: r.value.expose((b) => b.toString('utf8')) } : null;
};

function setup() {
  const registry = new ServiceCredentialRegistry();
  registry.register({ ref: REF, label: 'Brave Search API key', tiers: ['user', 'organization', 'system'], validate: apiKeyShape });
  registry.register({ ref: { service: 'web_search', name: 'personal_only' }, label: 'Personal only', tiers: ['user'], validate: apiKeyShape });
  const s = fakeStores();
  const metrics = { add: jest.fn() };
  const port = new CredentialStoreServiceCredentials(registry, s.users as unknown as UserCredentialsService, s.orgs as unknown as OrgCredentialsService, s.system as unknown as CredentialsService, metrics as never);
  return { registry, port, metrics, ...s };
}

describe('the registry', () => {
  it('refuses a malformed reference, an empty label, no tier, an unknown tier and a duplicate', () => {
    const r = new ServiceCredentialRegistry();
    const ok = { ref: REF, label: 'x', tiers: ['user'] as const, validate: apiKeyShape };
    expect(() => r.register({ ...ok, ref: { service: 'Web', name: 'brave' } })).toThrow(/malformed/);
    expect(() => r.register({ ...ok, ref: { service: 'web_search', name: '1x' } })).toThrow(/malformed/);
    expect(() => r.register({ ...ok, ref: { service: 'a'.repeat(41), name: 'x' } })).toThrow(/malformed/);
    expect(() => r.register({ ...ok, label: ' ' })).toThrow(/label/);
    expect(() => r.register({ ...ok, tiers: [] })).toThrow(/tier/);
    expect(() => r.register({ ...ok, tiers: ['user', 'deployment' as never] })).toThrow(/tier/);
    r.register(ok);
    expect(() => r.register(ok)).toThrow(/already/);
    expect(r.get({ service: 'web_search', name: 'other' })).toBeNull();
    expect(r.get({ service: 'BAD', name: 'brave' })).toBeNull();
  });

  it('checks the shape of an API key without echoing it', () => {
    expect(apiKeyShape('short')).toBe('too_short');
    expect(apiKeyShape('x'.repeat(513))).toBe('too_long');
    expect(apiKeyShape('has a space in it')).toBe('bad_characters');
    expect(apiKeyShape('BSAabcdef0123456789')).toBeNull();
  });
});

describe('resolve', () => {
  it('answers user, then organization, then system', async () => {
    const { port } = setup();
    expect(await read(port.resolve(REF, ALICE))).toBeNull();
    await port.set(REF, 'system', ALICE, key('system-key-0001'));
    expect(await read(port.resolve(REF, ALICE))).toEqual({ tier: 'system', value: 'system-key-0001' });
    await port.set(REF, 'organization', ALICE, key('org-key-0000001'));
    expect(await read(port.resolve(REF, ALICE))).toEqual({ tier: 'organization', value: 'org-key-0000001' });
    await port.set(REF, 'user', ALICE, key('alice-own-key-1'));
    expect(await read(port.resolve(REF, ALICE))).toEqual({ tier: 'user', value: 'alice-own-key-1' });
    // Bob has no organization and no key of his own: the deployment's.
    expect(await read(port.resolve(REF, BOB))).toEqual({ tier: 'system', value: 'system-key-0001' });
    // Another member of the organization gets the organization's, not Alice's.
    expect(await read(port.resolve(REF, { userId: 'u-carol', orgId: 'o-acme' }))).toEqual({ tier: 'organization', value: 'org-key-0000001' });
    await port.delete(REF, 'user', ALICE);
    expect(await read(port.resolve(REF, ALICE))).toEqual({ tier: 'organization', value: 'org-key-0000001' });
  });

  it('allowTiers narrows the tiers without changing the order', async () => {
    const { port } = setup();
    await port.set(REF, 'system', ALICE, key('system-key-0001'));
    await port.set(REF, 'user', ALICE, key('alice-own-key-1'));
    expect(await read(port.resolve(REF, ALICE, { allowTiers: ['system', 'user'] }))).toEqual({ tier: 'user', value: 'alice-own-key-1' });
    expect(await read(port.resolve(REF, ALICE, { allowTiers: ['system'] }))).toEqual({ tier: 'system', value: 'system-key-0001' });
    expect(await read(port.resolve(REF, BOB, { allowTiers: ['user', 'organization'] }))).toBeNull();
    expect(await read(port.resolve(REF, BOB, { allowTiers: [] }))).toBeNull();
  });

  it('an unregistered reference resolves to nothing and cannot be written', async () => {
    const { port, rows } = setup();
    const unknown = { service: 'web_search', name: 'unknown' };
    expect(await port.resolve(unknown, ALICE)).toBeNull();
    await expect(port.set(unknown, 'user', ALICE, key('alice-own-key-1'))).rejects.toMatchObject({ code: 'SERVICE_CREDENTIAL_UNKNOWN' });
    await expect(port.delete(unknown, 'user', ALICE)).rejects.toBeInstanceOf(ServiceCredentialError);
    expect(rows.size).toBe(0);
  });

  it('refuses a tier the registration does not name, an organization write without one, and a value of the wrong shape', async () => {
    const { port, rows } = setup();
    const personal = { service: 'web_search', name: 'personal_only' };
    await expect(port.set(personal, 'system', ALICE, key('system-key-0001'))).rejects.toMatchObject({ code: 'SERVICE_CREDENTIAL_TIER_NOT_ALLOWED', details: { tier: 'system' } });
    await expect(port.set(REF, 'organization', BOB, key('org-key-0000001'))).rejects.toMatchObject({ code: 'SERVICE_CREDENTIAL_NO_ORGANIZATION' });
    const bad = await port.set(REF, 'user', ALICE, key('MARKER short')).catch((e: ServiceCredentialError) => e);
    expect(bad).toMatchObject({ code: 'SERVICE_CREDENTIAL_INVALID', details: { reason: 'bad_characters' } });
    expect(JSON.stringify((bad as ServiceCredentialError).getResponse())).not.toContain('MARKER');
    expect(rows.size).toBe(0);
  });

  it('counts each resolution by registered service and tier, never by a name a user typed', async () => {
    const { port, metrics } = setup();
    await port.resolve(REF, ALICE);
    await port.set(REF, 'user', ALICE, key('alice-own-key-1'));
    await port.resolve(REF, ALICE);
    await port.resolve({ service: 'typed_by_someone', name: 'x' }, ALICE);
    expect(metrics.add.mock.calls).toEqual([
      ['serviceCredentialsResolved', 1, { service: 'web_search', tier: 'none' }],
      ['serviceCredentialsResolved', 1, { service: 'web_search', tier: 'user' }],
    ]);
  });
});

describe('status', () => {
  it('says which tiers hold a key, which answers and when it was set; never a value', async () => {
    const { port } = setup();
    expect(await port.status(REF, ALICE)).toEqual({ tier: null, binding: 'credential_store', setAt: null, tiers: { user: false, organization: false, system: false } });
    await port.set(REF, 'system', ALICE, key('system-key-0001'));
    await port.set(REF, 'organization', ALICE, key('org-key-0000001'));
    const s = await port.status(REF, ALICE);
    expect(s).toMatchObject({ tier: 'organization', binding: 'credential_store', tiers: { user: false, organization: true, system: true } });
    expect(new Date(s.setAt!).toISOString()).toBe(s.setAt);
    expect(JSON.stringify(s)).not.toMatch(/system-key|org-key|0001/);
    expect((await port.status(REF, ALICE, { allowTiers: ['user', 'system'] })).tier).toBe('system');
    expect((await port.status(REF, BOB)).tiers).toEqual({ user: false, organization: false, system: true });
  });
});

describe('the envelope', () => {
  it('round-trips, and the store hint holds no character of the key', () => {
    const k = 'BSA-secret-tail-WXYZ';
    expect(unseal(seal(k))).toBe(k);
    expect(deriveHint(seal(k))).not.toMatch(/[WXYZ]/);
    expect(unseal(k)).toBeNull();
    expect(unseal('{"value":"x","v":2}')).toBeNull();
  });

  it('writes the sealed value to the store', async () => {
    const { port, rows } = setup();
    await port.set(REF, 'user', ALICE, key('alice-own-key-1'));
    expect([...rows.entries()]).toEqual([['user:u-alice:service_credential:web_search.brave', expect.objectContaining({ secret: seal('alice-own-key-1') })]]);
  });
});
