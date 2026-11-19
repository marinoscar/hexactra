import { FabricError, type FabricClient } from '../src/fabric/fabric.client';
import { FabricSecretsUnavailable, FabricSessionSecretsRegistry } from '../src/secrets/fabric-secrets-registry';

const TOKEN = 'oat_canary-token-5d41402abc4b2a76b9719d911017c592';
const REG = { kind: 'vault' as const, baseUrl: 'https://vault.example.test', accessToken: TOKEN, expiresAt: '2030-01-02T03:04:05.000Z' };

type Call = [string, string, Record<string, unknown> | undefined];

function fake(answer: (method: string, path: string) => unknown) {
  const calls: Call[] = [];
  const client = {
    request: jest.fn(async (method: string, path: string, opts: { body?: Record<string, unknown> } = {}) => {
      calls.push([method, path, opts.body]);
      return answer(method, path);
    }),
  } as unknown as FabricClient;
  return { calls, registry: new FabricSessionSecretsRegistry(client) };
}

const view = { owner_id: 'user-a', provider: 'vault', kind: 'vault', base_url: 'https://vault.example.test', registered_at: '2030-01-01T00:00:00Z', expires_at: '2030-01-02T03:04:05Z' };

describe('FabricSessionSecretsRegistry', () => {
  it('registers the owner\'s Vault through the fabric\'s secrets-provider resource, token in the body only', async () => {
    const { calls, registry } = fake(() => view);
    await registry.registerSecretsProvider('user-a', REG);
    expect(calls).toEqual([
      ['PUT', '/v1/secrets-providers/user-a/vault', { kind: 'vault', base_url: 'https://vault.example.test', access_token: TOKEN, expires_at: '2030-01-02T03:04:05.000Z' }],
    ]);
  });

  it('percent-encodes the owner id in the path', async () => {
    const { calls, registry } = fake(() => view);
    await registry.registerSecretsProvider('user/a b', REG);
    expect(calls[0]![1]).toBe('/v1/secrets-providers/user%2Fa%20b/vault');
  });

  it('replaces the token by registering again', async () => {
    const { calls, registry } = fake(() => view);
    await registry.registerSecretsProvider('user-a', REG);
    await registry.registerSecretsProvider('user-a', { ...REG, accessToken: 'oat_second', expiresAt: '2030-01-02T03:09:05.000Z' });
    expect(calls.map((c) => [c[0], c[1], c[2]?.access_token])).toEqual([
      ['PUT', '/v1/secrets-providers/user-a/vault', TOKEN],
      ['PUT', '/v1/secrets-providers/user-a/vault', 'oat_second'],
    ]);
  });

  it('forgets the provider with a DELETE', async () => {
    const { calls, registry } = fake(() => undefined);
    await registry.unregisterSecretsProvider('user-a', 'vault');
    expect(calls).toEqual([['DELETE', '/v1/secrets-providers/user-a/vault', undefined]]);
  });

  it('maps every fabric failure to a reason, never carrying the token', async () => {
    const cases: [FabricError, FabricSecretsUnavailable['reason']][] = [
      [new FabricError('not_configured', `no fabric, token ${TOKEN}`), 'not_wired'],
      [new FabricError('unreachable', `Cannot reach the fabric: ${TOKEN}`), 'unreachable'],
      [new FabricError('api', `provider kind unsupported ${TOKEN}`, 501, 'provider_kind_unsupported'), 'refused'],
      [new FabricError('api', 'invalid', 400, 'invalid_request'), 'refused'],
      [new FabricError('unauthorized', 'service token refused', 401), 'refused'],
    ];
    for (const [error, reason] of cases) {
      const { registry } = fake(() => {
        throw error;
      });
      const e = await registry.registerSecretsProvider('user-a', REG).then(
        () => null,
        (x: unknown) => x,
      );
      expect(e).toBeInstanceOf(FabricSecretsUnavailable);
      expect((e as FabricSecretsUnavailable).reason).toBe(reason);
      expect(JSON.stringify(e) + String((e as Error).message) + String((e as Error).stack)).not.toContain(TOKEN);
      expect((e as Error).cause).toBeUndefined();
      // unregister fails the same way
      const u = await registry.unregisterSecretsProvider('user-a', 'vault').then(
        () => null,
        (x: unknown) => x,
      );
      expect((u as FabricSecretsUnavailable).reason).toBe(reason);
    }
  });

  it('refuses an unreadable expiry without calling the fabric', async () => {
    const { calls, registry } = fake(() => view);
    await expect(registry.registerSecretsProvider('user-a', { ...REG, expiresAt: 'tomorrow-ish' })).rejects.toMatchObject({ reason: 'refused' });
    expect(calls).toEqual([]);
  });
});
