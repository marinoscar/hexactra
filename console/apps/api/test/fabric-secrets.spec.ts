import { inspect } from 'node:util';

import { FabricError, type FabricClient } from '../src/fabric/fabric.client';
import { FabricSession, secretsErrorOf, type FabricOperation } from '../src/runner/fabric-session';
import { SECRETS_ERROR_CODES, SecretBytes, SecretsProviderError, secretsErrorAction } from '../src/secrets/secrets-provider.port';

type Call = [string, string, Record<string, unknown> | undefined];

/** A FabricClient that records each request and answers with `answer(call)`. */
function fake(answer: (method: string, path: string, body?: Record<string, unknown>) => unknown) {
  const calls: Call[] = [];
  const client = {
    request: jest.fn(async (method: string, path: string, opts: { body?: Record<string, unknown> } = {}) => {
      calls.push([method, path, opts.body]);
      return answer(method, path, opts.body);
    }),
  } as unknown as FabricClient;
  return { client, calls, session: new FabricSession(client, async () => undefined) };
}

const ok = (result: Record<string, unknown>): FabricOperation => ({ id: 'op-1', state: 'succeeded', result });
const failed = (error: string): FabricOperation => ({ id: 'op-2', state: 'failed', error });

describe('secretsLookup', () => {
  it('posts a secrets_lookup action and maps the summaries', async () => {
    const { calls, session } = fake(() =>
      ok({
        origin: 'https://app.example.test',
        provider: 'test',
        items: [
          { id: 'i1', name: 'Shop login', username: 'person-a@example.test', origins: ['https://app.example.test'], match_kind: 'exact', has_code: true, updated_at: '2030-01-02T03:04:05Z' },
          { id: 'i2', name: 'Other', origins: [], match_kind: 'site' },
        ],
      }),
    );
    const r = await session.secretsLookup('s1', 'login', { provider: 'test', runId: 'run-1', clientLabel: 'Console', tabId: 4 });
    expect(calls).toEqual([
      ['POST', '/v1/sessions/s1/actions', { action: { type: 'secrets_lookup', kind: 'login', provider: 'test', run_id: 'run-1', client_label: 'Console', tab_id: 4 }, timeout_ms: 45_000 }],
    ]);
    expect(r.origin).toBe('https://app.example.test');
    expect(r.items[0]).toEqual({
      id: 'i1',
      name: 'Shop login',
      username: 'person-a@example.test',
      origins: ['https://app.example.test'],
      matchKind: 'exact',
      hasCode: true,
      updatedAt: new Date('2030-01-02T03:04:05Z'),
    });
    expect(r.items[1]).toMatchObject({ matchKind: 'site', hasCode: false, updatedAt: null });
    expect(r.items[1]).not.toHaveProperty('username');
  });

  it('defaults to a login lookup with no optional fields', async () => {
    const { calls, session } = fake(() => ok({ origin: 'https://a.example.test', provider: 'test', items: [] }));
    await session.secretsLookup('s1');
    expect(calls[0]![2]).toEqual({ action: { type: 'secrets_lookup', kind: 'login' }, timeout_ms: 45_000 });
  });
});

describe('typeFromProvider', () => {
  it('names the item and field, never a value, and answers only typed', async () => {
    const { calls, session } = fake(() => ok({ typed: true }));
    const r = await session.typeFromProvider('s1', { itemId: 'i1', field: 'password', selector: '#pw', submit: true, runId: 'run-1' });
    expect(r).toEqual({ typed: true });
    expect(calls[0]![2]).toEqual({
      action: { type: 'type_from_provider', item_id: 'i1', field: 'password', selector: '#pw', purpose: 'login', clear: true, submit: true, run_id: 'run-1' },
      timeout_ms: 45_000,
    });
    expect(JSON.stringify(calls)).not.toMatch(/"(text|value)"/);
  });

  it('targets a point, with a purpose', async () => {
    const { calls, session } = fake(() => ok({ typed: true }));
    await session.typeFromProvider('s1', { itemId: 'i1', field: 'username', point: { x: 3, y: 4 }, purpose: 'signup', clear: false, tabId: 9, timeoutMs: 5_000 });
    expect(calls[0]![2]).toEqual({
      action: { type: 'type_from_provider', item_id: 'i1', field: 'username', point: { x: 3, y: 4 }, purpose: 'signup', clear: false, submit: false, tab_id: 9 },
      timeout_ms: 5_000,
    });
  });
});

describe('typeCodeFromProvider', () => {
  it('returns when the code expires', async () => {
    const { calls, session } = fake(() => ok({ typed: true, expires_at: '2030-01-01T00:00:30Z' }));
    const r = await session.typeCodeFromProvider('s1', { itemId: 'i1', selector: '#otp', submit: true });
    expect(r).toEqual({ typed: true, expiresAt: new Date('2030-01-01T00:00:30Z') });
    expect(calls[0]![2]).toEqual({ action: { type: 'type_code_from_provider', item_id: 'i1', selector: '#otp', clear: false, submit: true }, timeout_ms: 45_000 });
  });
});

describe('error mapping', () => {
  it.each(SECRETS_ERROR_CODES.filter((c) => !['timed_out', 'cancelled', 'unknown', 'rate_limited'].includes(c)))('maps %s', async (code) => {
    const { session } = fake(() => failed(`${code}: something readable`));
    const err = await session.typeFromProvider('s1', { itemId: 'i1', field: 'password', selector: '#pw' }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(SecretsProviderError);
    expect(err).toMatchObject({ code, message: 'something readable', operationId: 'op-2' });
  });

  it('reads how long to wait from a rate limit', () => {
    const e = secretsErrorOf({ id: 'op', error: 'rate_limited: rate limited; retry in 7 s' });
    expect(e).toMatchObject({ code: 'rate_limited', retryAfterSeconds: 7 });
    expect(e.action).toBe('wait');
  });

  it('maps timed out and cancelled operations, and keeps the text of an unknown code', async () => {
    const timedOut = fake(() => ({ id: 'op-3', state: 'timed_out', error: 'no host picked up the action in time; it did not run' }));
    await expect(timedOut.session.secretsLookup('s1')).rejects.toMatchObject({ code: 'timed_out', operationId: 'op-3' });
    const cancelled = fake(() => ({ id: 'op-4', state: 'cancelled', error: 'session ended' }));
    await expect(cancelled.session.secretsLookup('s1')).rejects.toMatchObject({ code: 'cancelled' });
    const odd = secretsErrorOf({ id: 'op', error: 'something_new: later' });
    expect(odd).toMatchObject({ code: 'unknown', message: 'something_new: later' });
    expect(secretsErrorOf({ id: 'op' })).toMatchObject({ code: 'unknown' });
  });

  it('tells a run what to do about each failure', () => {
    expect(secretsErrorAction('origin_mismatch')).toBe('stop');
    expect(secretsErrorAction('cross_origin_frame')).toBe('stop');
    expect(secretsErrorAction('not_found')).toBe('ask_person');
    expect(secretsErrorAction('no_provider')).toBe('ask_person');
    expect(secretsErrorAction('unauthorized')).toBe('reconnect');
    expect(secretsErrorAction('rate_limited')).toBe('wait');
    expect(secretsErrorAction('unavailable')).toBe('retry_later');
    expect(secretsErrorAction('refused')).toBe('fail');
  });

  it('waits out a takeover by default and throws at once when asked', async () => {
    const takeover = () => new FabricError('api', 'a person is controlling this browser', 409, 'takeover_active');
    let n = 0;
    const waits = fake(() => {
      if (++n < 3) throw takeover();
      return ok({ typed: true });
    });
    await expect(waits.session.typeFromProvider('s1', { itemId: 'i1', field: 'password', selector: '#pw' })).resolves.toEqual({ typed: true });
    expect(n).toBe(3);
    const throws = fake(() => {
      throw takeover();
    });
    await expect(throws.session.typeFromProvider('s1', { itemId: 'i1', field: 'password', selector: '#pw', waitForTakeover: false })).rejects.toMatchObject({ code: 'takeover_active' });
  });
});

describe('registering a provider', () => {
  const view = { owner_id: 'user a', provider: 'vault', kind: 'vault', base_url: 'https://vault.example.test', registered_at: '2030-01-01T00:00:00Z', expires_at: '2030-01-01T01:00:00Z' };

  it('PUTs the owner-scoped resource and never reads a token back', async () => {
    const { calls, session } = fake(() => view);
    const r = await session.registerSecretsProvider('user a', {
      provider: 'vault',
      kind: 'vault',
      baseUrl: 'https://vault.example.test',
      accessToken: 'oat_canary',
      expiresAt: new Date('2030-01-01T01:00:00Z'),
    });
    expect(calls).toEqual([
      ['PUT', '/v1/secrets-providers/user%20a/vault', { kind: 'vault', base_url: 'https://vault.example.test', access_token: 'oat_canary', expires_at: '2030-01-01T01:00:00.000Z' }],
    ]);
    expect(r).toEqual({ ownerId: 'user a', provider: 'vault', kind: 'vault', baseUrl: 'https://vault.example.test', registeredAt: new Date('2030-01-01T00:00:00Z'), expiresAt: new Date('2030-01-01T01:00:00Z') });
    expect(JSON.stringify(r)).not.toContain('oat_canary');
  });

  it('unregisters and lists', async () => {
    const { calls, session } = fake((method) => (method === 'GET' ? { providers: [view] } : undefined));
    await session.unregisterSecretsProvider('user-a', 'vault');
    expect(await session.listSecretsProviders('user-a')).toHaveLength(1);
    expect(calls.map(([m, p]) => `${m} ${p}`)).toEqual(['DELETE /v1/secrets-providers/user-a/vault', 'GET /v1/secrets-providers/user-a']);
  });

  it('opens a session for an owner', async () => {
    const { calls, session } = fake(() => ({ id: 's9' }));
    expect(await session.create({ profile: 'default', hostId: null, label: 'run', ownerId: 'user-a' })).toBe('s9');
    expect(calls[0]![2]).toEqual({ profile: 'default', label: 'run', owner_id: 'user-a' });
    await session.create({ profile: 'default', hostId: null, label: 'run' });
    expect(calls[1]![2]).not.toHaveProperty('owner_id');
  });
});

describe('SecretBytes', () => {
  it('has no string, JSON or inspect form that shows the value', () => {
    const s = SecretBytes.from('canary-value');
    expect(`${s}`).toBe('[secret]');
    expect(JSON.stringify({ s })).toBe('{"s":"[secret]"}');
    expect(inspect(s)).toBe('[secret]');
    expect(inspect({ nested: s })).not.toContain('canary');
    expect(s.expose((b) => b.toString('utf8'))).toBe('canary-value');
  });

  it('wipes its bytes, including the buffer it took', () => {
    const buf = Buffer.from('canary-value');
    const s = SecretBytes.take(buf);
    s.wipe();
    expect(s.wiped).toBe(true);
    expect([...buf].every((b) => b === 0)).toBe(true);
    expect(() => s.expose((b) => b.length)).toThrow('wiped');
    s.wipe();
  });
});
