// The pure parts of signing in from a saved login (E37.3, #592): references, masking, the lookup the model reads, the
// error-to-instruction table, and the list of logins a run used.
import { FabricError, type FabricClient } from '../src/fabric/fabric.client';
import { FabricClientSecretsRegistry } from '../src/secrets/fabric-client-secrets-registry';
import { FabricSecretsUnavailable } from '../src/secrets/fabric-secrets-registry';
import { SECRETS_ERROR_CODES, type ItemSummary } from '../src/secrets/secrets-provider.port';
import { appendUsedSavedLogin, failureOf, loginLabel, lookupOf, lookupText, maskUsername, readUsedSavedLogins, refFor, MAX_USED_SAVED_LOGINS } from '../src/runner/saved-logins';

const item = (id: string, name: string, matchKind: 'exact' | 'site', hasCode = false, username = `${id}@example.test`): ItemSummary => ({ id, name, username, origins: ['https://a.example.test'], matchKind, hasCode });

describe('references', () => {
  it('hands out one short reference per item per run, never the item id', () => {
    const memory = { refs: {} as Record<string, string> };
    expect(refFor(memory, 'item-x')).toBe('login-1');
    expect(refFor(memory, 'item-y')).toBe('login-2');
    expect(refFor(memory, 'item-x')).toBe('login-1');
  });

  it('lists exact matches first and says what to do for none, a site-only match, one and several', () => {
    const memory = { refs: {} as Record<string, string> };
    const none = lookupOf(memory, { origin: 'https://a.example.test', provider: 'test', items: [] });
    expect(lookupText(none)).toMatch(/^none: no saved login/);

    const siteOnly = lookupOf(memory, { origin: 'https://a.example.test', provider: 'test', items: [item('s', 'Site', 'site')] });
    expect(siteOnly.ambiguous).toBe(false);
    expect(lookupText(siteOnly)).toContain('None of these is saved for this exact address');

    const one = lookupOf(memory, { origin: 'https://a.example.test', provider: 'test', items: [item('s', 'Site', 'site'), item('e', 'Exact', 'exact', true)] });
    expect(one.logins.map((l) => [l.name, l.exact])).toEqual([
      ['Exact', true],
      ['Site', false],
    ]);
    const text = lookupText(one);
    expect(text).toContain('Exactly one login is saved for this address');
    expect(text).toContain('type_saved_code');
    // Never the provider's id.
    expect(text).not.toMatch(/"(id|itemId)"/);
    expect(text).not.toContain('"s"');

    const several = lookupOf(memory, { origin: 'https://a.example.test', provider: 'test', items: [item('e1', 'One', 'exact'), item('e2', 'Two', 'exact')] });
    expect(several.ambiguous).toBe(true);
    expect(lookupText(several)).toContain('do not pick one yourself');
    expect(lookupText(several)).toContain('One (e1@example.test)');
  });
});

describe('masking', () => {
  it('keeps the first character and the domain of an email, and the first character of any other name', () => {
    expect(maskUsername('person-a@example.test')).toBe('p•••@example.test');
    expect(maskUsername('oscar')).toBe('o•••');
    expect(maskUsername('x')).toBe('•••');
    expect(maskUsername('')).toBe('not shown');
    expect(maskUsername(maskUsername('person-a@example.test'))).toBe('p•••@example.test');
    expect(loginLabel('Shop login', 'person-a@example.test')).toBe("'Shop login' (username p•••@example.test)");
  });
});

describe('the error to instruction table', () => {
  it('stops and asks with a warning on a mismatch, in every wording the model reads', () => {
    const f = failureOf('origin_mismatch');
    expect(f.warn).toBe(true);
    expect(f.text).toBe('Stop. This page is not the site this login is saved for. Do not try another login. Tell the owner.');
    expect(failureOf('cross_origin_frame').warn).toBe(true);
  });

  it.each(['disabled', 'unauthorized', 'unavailable', 'rate_limited', 'not_found', 'no_provider', 'unknown'] as const)('%s: saved logins are not available, ask the owner', (code) => {
    const f = failureOf(code);
    expect(f.warn).toBe(false);
    expect(f.text).toContain('Saved logins are not available right now.');
    expect(f.text).toContain('request_human');
  });

  it('reports the provider outcomes that change the connection and none that does not', () => {
    expect(failureOf('unauthorized').outcome).toBe('UNAUTHORIZED');
    expect(failureOf('disabled').outcome).toBe('DISABLED');
    expect(failureOf('origin_mismatch').outcome).toBe('ORIGIN_MISMATCH');
    expect(failureOf('typing_failed').outcome).toBeNull();
  });

  it('knows every error code of the fabric and never repeats the provider\'s message', () => {
    for (const code of SECRETS_ERROR_CODES) {
      const f = failureOf(code, 7);
      expect(f.text.length).toBeGreaterThan(10);
      expect(f.summary.length).toBeGreaterThan(3);
    }
  });
});

describe('what a run used', () => {
  it('records a login once per site, caps the list, and drops what is malformed', () => {
    const at = new Date('2030-01-01T00:00:00Z');
    const first = appendUsedSavedLogin(null, { provider: 'vault', itemName: 'Shop login', origin: 'https://shop.example.test', at });
    expect(first).toEqual([{ provider: 'vault', itemName: 'Shop login', origin: 'https://shop.example.test', at: at.toISOString() }]);
    expect(appendUsedSavedLogin(first, { provider: 'vault', itemName: 'Shop login', origin: 'https://shop.example.test', at })).toHaveLength(1);
    expect(appendUsedSavedLogin(first, { provider: 'vault', itemName: 'Shop login', origin: 'https://other.example.test', at })).toHaveLength(2);
    let many: unknown = [];
    for (let i = 0; i < MAX_USED_SAVED_LOGINS + 5; i++) many = appendUsedSavedLogin(many, { provider: 'vault', itemName: `Login ${i}`, origin: 'https://shop.example.test', at });
    expect(readUsedSavedLogins(many)).toHaveLength(MAX_USED_SAVED_LOGINS);
    expect(readUsedSavedLogins([{ provider: 'vault' }, null, 3, ...first])).toEqual(first);
    expect(readUsedSavedLogins(null)).toEqual([]);
  });
});

describe('the fabric registry adapter', () => {
  const fabricOf = (answer: (method: string, path: string, body?: unknown) => unknown) => {
    const calls: [string, string, unknown][] = [];
    const client = {
      request: jest.fn(async (method: string, path: string, opts: { body?: unknown } = {}) => {
        calls.push([method, path, opts.body]);
        return answer(method, path, opts.body);
      }),
    } as unknown as FabricClient;
    return { client, calls };
  };

  it('registers the owner\'s vault with its address, access token and expiry, and forgets it', async () => {
    const { client, calls } = fabricOf(() => ({ owner_id: 'u1', provider: 'vault', kind: 'vault', registered_at: '2030-01-01T00:00:00Z' }));
    const registry = new FabricClientSecretsRegistry(client);
    await registry.registerSecretsProvider('u 1', { kind: 'vault', baseUrl: 'https://vault.example.test', accessToken: 'oat_x', expiresAt: '2030-01-01T00:05:00.000Z' });
    expect(calls[0]).toEqual(['PUT', '/v1/secrets-providers/u%201/vault', { kind: 'vault', base_url: 'https://vault.example.test', access_token: 'oat_x', expires_at: '2030-01-01T00:05:00.000Z' }]);
    await registry.unregisterSecretsProvider('u 1', 'vault');
    expect(calls[1]).toEqual(['DELETE', '/v1/secrets-providers/u%201/vault', undefined]);
  });

  it('says the fabric cannot take the provider without carrying the token, and treats a missing registration as forgotten', async () => {
    const refused = fabricOf(() => {
      throw new FabricError('api', 'provider_kind_unsupported oat_secret', 501, 'provider_kind_unsupported');
    });
    const err = await new FabricClientSecretsRegistry(refused.client).registerSecretsProvider('u1', { kind: 'vault', baseUrl: 'https://v.example.test', accessToken: 'oat_secret', expiresAt: '2030-01-01T00:00:00Z' }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(FabricSecretsUnavailable);
    expect(JSON.stringify(err) + String((err as Error).message)).not.toContain('oat_secret');
    const gone = fabricOf(() => {
      throw new FabricError('api', 'not found', 404, 'not_found');
    });
    await expect(new FabricClientSecretsRegistry(gone.client).unregisterSecretsProvider('u1', 'vault')).resolves.toBeUndefined();
  });
});
