// The built-in secrets store with the slice OFF, and its pure parts (E37.5, #594): with `SECRETS_STORE_ENABLED` unset
// no `@marinoscar/vault-*` code is loaded (every specifier below is mocked to throw if it is required); the key
// configuration refuses anything but one clear error; and the envelope cipher fails closed.
import { randomBytes } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

for (const specifier of ['@marinoscar/vault-api/core', '@marinoscar/vault-api/agent', '@marinoscar/vault-api/secrets', '@marinoscar/vault-api/secret-types', '@marinoscar/vault-api/ports', '@marinoscar/vault-api', '@marinoscar/vault-contract/agent', '@marinoscar/vault-contract/secret-types', '@marinoscar/vault-contract/secrets']) {
  jest.mock(specifier, () => {
    throw new Error(`A Vault package was loaded with the built-in store switched off: ${specifier}`);
  }, { virtual: false });
}

import { decryptValue, encryptValue, newDataKey, ownerOfCiphertext, rewrapDataKey, SecretsStoreCryptoError, unwrapDataKey, wrapDataKey } from '../src/secrets/builtin/store.cipher';
import { SecretsStoreConfigError, StoreKeyRing, parseStoreKey, secretsStoreEnabled, storeKeyId } from '../src/secrets/builtin/store.keys';
import { loadSecretsStoreModule, secretsStoreMounted } from '../src/secrets/builtin/secrets-store.loader';

const KEY = Buffer.alloc(32, 1).toString('base64');
const KEY2 = Buffer.alloc(32, 2).toString('base64');
const USER = '11111111-2222-4333-8444-555555555555';
const OTHER = '66666666-7777-4888-9999-000000000000';

describe('the slice is off by default', () => {
  it('is off unless SECRETS_STORE_ENABLED is "true"', () => {
    for (const v of [undefined, '', 'false', '0', 'yes', '1']) expect(secretsStoreEnabled({ SECRETS_STORE_ENABLED: v })).toBe(false);
    expect(secretsStoreEnabled({ SECRETS_STORE_ENABLED: 'true' })).toBe(true);
    expect(secretsStoreEnabled({ SECRETS_STORE_ENABLED: ' TRUE ' })).toBe(true);
    expect(secretsStoreMounted({})).toBe(false);
  });

  it('loads no Vault package: the app module, the registrations and the permissions import without one', () => {
    delete process.env.SECRETS_STORE_ENABLED;
    // Each of these would throw the mock's error if it reached a package.
    for (const path of ['../src/app.module', '../src/platform/registrations', '../src/platform/permissions', '../src/platform/user-data/user-data.manifest', '../src/secrets/builtin/store.ownership']) {
      jest.isolateModules(() => {
        // eslint-disable-next-line @typescript-eslint/no-require-imports
        expect(() => require(path)).not.toThrow();
      });
    }
  });

  it('the guard itself works: requiring a store file that uses a package throws the mock’s error', () => {
    jest.isolateModules(() => {
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      expect(() => require('../src/secrets/builtin/store.ports')).toThrow(/switched off/);
    });
  });

  it('turning it on without a key is one clear error that names the variable and never a value', () => {
    const on = { SECRETS_STORE_ENABLED: 'true' };
    expect(() => loadSecretsStoreModule(on)).toThrow(SecretsStoreConfigError);
    expect(() => loadSecretsStoreModule(on)).toThrow(/^SECRETS_STORE_KEY is not set$/);
    expect(() => loadSecretsStoreModule({ ...on, SECRETS_STORE_KEY: 'not-a-key' })).toThrow(/SECRETS_STORE_KEY must be 32 random bytes/);
    expect(() => loadSecretsStoreModule({ ...on, SECRETS_STORE_KEY: 'not-a-key' })).not.toThrow(/not-a-key/);
    expect(() => loadSecretsStoreModule({ ...on, SECRETS_STORE_KEY: Buffer.alloc(16, 1).toString('base64') })).toThrow(/SECRETS_STORE_KEY must be 32 random bytes/);
    expect(() => loadSecretsStoreModule({ ...on, SECRETS_STORE_KEY: KEY, SECRETS_STORE_KEY_PREVIOUS: KEY })).toThrow(/SECRETS_STORE_KEY_PREVIOUS must differ/);
  });
});

describe('the store key', () => {
  it('takes 64 hex characters or base64, exactly 256 bits', () => {
    const bytes = randomBytes(32);
    expect(parseStoreKey(bytes.toString('hex'), 'K').equals(bytes)).toBe(true);
    expect(parseStoreKey(bytes.toString('base64'), 'K').equals(bytes)).toBe(true);
    expect(parseStoreKey(bytes.toString('base64url'), 'K').equals(bytes)).toBe(true);
    for (const bad of ['', '   ', 'abc', 'g'.repeat(64), bytes.subarray(0, 31).toString('base64'), Buffer.concat([bytes, bytes]).toString('base64')]) expect(() => parseStoreKey(bad, 'K')).toThrow(SecretsStoreConfigError);
  });

  it('identifies a key by a public id that reveals nothing, and holds the previous key during a rotation', () => {
    const ring = StoreKeyRing.fromEnv({ SECRETS_STORE_KEY: KEY2, SECRETS_STORE_KEY_PREVIOUS: KEY });
    expect(ring.current.id).toBe(storeKeyId(Buffer.from(KEY2, 'base64')));
    expect(ring.current.id).toMatch(/^[0-9a-f]{8}$/);
    expect(ring.keyFor(storeKeyId(Buffer.from(KEY, 'base64')))?.key.equals(Buffer.from(KEY, 'base64'))).toBe(true);
    expect(ring.keyFor('deadbeef')).toBeNull();
    expect(JSON.stringify(ring.current.id)).not.toContain(KEY2);
  });
});

describe('the envelope', () => {
  const ring = StoreKeyRing.fromEnv({ SECRETS_STORE_KEY: KEY });

  it('wraps a data key under the store key and unwraps it; the wrapped form is not the key', () => {
    const dk = newDataKey();
    const { keyId, wrapped } = wrapDataKey(ring, USER, dk);
    expect(keyId).toBe(ring.current.id);
    expect(Buffer.from(wrapped, 'base64').includes(dk)).toBe(false);
    expect(unwrapDataKey(ring, USER, keyId, wrapped).equals(dk)).toBe(true);
  });

  it('fails closed: a wrong store key, another owner’s data key, a tampered wrapped key, an unknown key id', () => {
    const dk = newDataKey();
    const { keyId, wrapped } = wrapDataKey(ring, USER, dk);
    const wrong = StoreKeyRing.fromEnv({ SECRETS_STORE_KEY: KEY2 });
    expect(() => unwrapDataKey(wrong, USER, keyId, wrapped)).toThrow(SecretsStoreCryptoError); // key id not held
    const sameIdWrongKey = { ...wrong, keyFor: () => wrong.current } as unknown as StoreKeyRing;
    expect(() => unwrapDataKey(sameIdWrongKey, USER, keyId, wrapped)).toThrow(/wrong_key/);
    expect(() => unwrapDataKey(ring, OTHER, keyId, wrapped)).toThrow(/wrong_key/); // bound to its owner
    const raw = Buffer.from(wrapped, 'base64');
    raw[raw.length - 1] ^= 1;
    expect(() => unwrapDataKey(ring, USER, keyId, raw.toString('base64'))).toThrow(/wrong_key/);
    expect(() => unwrapDataKey(ring, USER, keyId, 'AAAA')).toThrow(/malformed/);
  });

  it('re-wraps under a new key without changing the data key', () => {
    const dk = newDataKey();
    const old = wrapDataKey(ring, USER, dk);
    const rotated = StoreKeyRing.fromEnv({ SECRETS_STORE_KEY: KEY2, SECRETS_STORE_KEY_PREVIOUS: KEY });
    const next = rewrapDataKey(rotated, USER, old.keyId, old.wrapped);
    expect(next.keyId).toBe(rotated.current.id);
    expect(next.dataKey.equals(dk)).toBe(true);
    expect(unwrapDataKey(rotated, USER, next.keyId, next.wrapped).equals(dk)).toBe(true);
    // the old key alone can no longer open it
    expect(() => unwrapDataKey(ring, USER, next.keyId, next.wrapped)).toThrow(SecretsStoreCryptoError);
  });

  it('encrypts a value under the owner’s data key and names the owner in the ciphertext, never the value', () => {
    const dk = newDataKey();
    const enc = encryptValue(USER, dk, 'a seeded password');
    expect(ownerOfCiphertext(enc.ciphertext)).toBe(USER);
    expect(JSON.stringify(enc)).not.toContain('a seeded password');
    expect(decryptValue(USER, dk, enc.ciphertext, enc.iv, enc.authTag)).toBe('a seeded password');
    // a fresh IV per call
    expect(encryptValue(USER, dk, 'a seeded password').iv).not.toBe(enc.iv);
  });

  it('a value does not decrypt under another key, for another owner, or after tampering', () => {
    const dk = newDataKey();
    const enc = encryptValue(USER, dk, 'secret');
    expect(() => decryptValue(USER, newDataKey(), enc.ciphertext, enc.iv, enc.authTag)).toThrow(SecretsStoreCryptoError);
    // the same bytes presented as another owner's value (AAD binds the owner)
    const moved = enc.ciphertext.replace(USER, OTHER);
    expect(ownerOfCiphertext(moved)).toBe(OTHER);
    expect(() => decryptValue(OTHER, dk, moved, enc.iv, enc.authTag)).toThrow(SecretsStoreCryptoError);
    expect(() => decryptValue(USER, dk, enc.ciphertext, enc.iv, Buffer.alloc(16).toString('base64'))).toThrow(SecretsStoreCryptoError);
    expect(ownerOfCiphertext('plain text')).toBeNull();
    expect(ownerOfCiphertext('ss1.not-a-uuid.abc')).toBeNull();
  });
});

describe('the public proxy', () => {
  it('answers 404 for the internal release route prefix, and does not log it', () => {
    const conf = readFileSync(join(__dirname, '..', '..', '..', 'infra', 'nginx', 'app.d', 'locations', 'secrets-store-internal.conf'), 'utf8')
      .split('\n')
      .filter((l) => !l.trim().startsWith('#'))
      .join('\n');
    expect(conf).toMatch(/location \^~ \/api\/internal\/ \{\s*return 404;\s*\}/);
  });
});
