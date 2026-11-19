// The built-in secrets store's key ring (E37.5, #594).
//
// `SECRETS_STORE_KEY` is a dedicated 256-bit deployment secret. It is NOT the credential store's key
// (`SECRETS_ENCRYPTION_KEY`) and is not derived from it: a leak or rotation of one must never touch the other. It
// only ever WRAPS per-owner data keys (store.cipher.ts); it never encrypts a value directly. `SECRETS_STORE_KEY_PREVIOUS`
// is accepted while a rotation is in progress, so rows still wrapped under the old key stay readable until the
// maintenance job has re-wrapped them.
//
// This file is plain Node: it imports nothing of Nest, Prisma or the Vault packages, so reading the configuration
// (is the slice on? is the key usable?) loads none of them.
import { createHash } from 'node:crypto';

export const STORE_KEY_ENV = 'SECRETS_STORE_KEY';
export const STORE_KEY_PREVIOUS_ENV = 'SECRETS_STORE_KEY_PREVIOUS';
export const STORE_ENABLED_ENV = 'SECRETS_STORE_ENABLED';
/** The store key is 256 bits. */
export const STORE_KEY_BYTES = 32;

/** The configuration is unusable. The message names the variable and the problem, never a value. */
export class SecretsStoreConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SecretsStoreConfigError';
  }
}

type Env = Record<string, string | undefined>;

/** Whether the built-in store slice is switched on (deployment configuration, off by default). */
export function secretsStoreEnabled(env: Env = process.env): boolean {
  return (env[STORE_ENABLED_ENV] ?? '').trim().toLowerCase() === 'true';
}

/**
 * Decodes a 256-bit key given as 64 hex characters or as base64 / base64url (44 characters). Anything else is
 * refused. The error names `name` only.
 */
export function parseStoreKey(raw: string | undefined, name: string): Buffer {
  const value = (raw ?? '').trim();
  if (!value) throw new SecretsStoreConfigError(`${name} is not set`);
  let bytes: Buffer;
  if (/^[0-9a-fA-F]{64}$/.test(value)) bytes = Buffer.from(value, 'hex');
  else if (/^[A-Za-z0-9+/_-]{43}=?$/.test(value)) bytes = Buffer.from(value.replace(/-/g, '+').replace(/_/g, '/'), 'base64');
  else throw new SecretsStoreConfigError(`${name} must be 32 random bytes written as 64 hex characters or as base64 (for example: openssl rand -base64 32)`);
  if (bytes.length !== STORE_KEY_BYTES) throw new SecretsStoreConfigError(`${name} must decode to exactly ${STORE_KEY_BYTES} bytes`);
  return bytes;
}

/** The public identifier of a store key: the first 8 hex characters of its SHA-256. Identifies, reveals nothing. */
export function storeKeyId(key: Buffer): string {
  return createHash('sha256').update('hexactra.secrets-store.key-id').update(key).digest('hex').slice(0, 8);
}

export interface StoreKey {
  readonly id: string;
  readonly key: Buffer;
}

/** The current key and, during a rotation, the previous one. */
export class StoreKeyRing {
  private constructor(
    readonly current: StoreKey,
    readonly previous: StoreKey | null,
  ) {}

  static fromEnv(env: Env = process.env): StoreKeyRing {
    const current = parseStoreKey(env[STORE_KEY_ENV], STORE_KEY_ENV);
    const prevRaw = (env[STORE_KEY_PREVIOUS_ENV] ?? '').trim();
    const previous = prevRaw ? parseStoreKey(prevRaw, STORE_KEY_PREVIOUS_ENV) : null;
    if (previous && previous.equals(current)) throw new SecretsStoreConfigError(`${STORE_KEY_PREVIOUS_ENV} must differ from ${STORE_KEY_ENV}`);
    return new StoreKeyRing({ id: storeKeyId(current), key: current }, previous ? { id: storeKeyId(previous), key: previous } : null);
  }

  /** The key with this id, or null when the configuration no longer holds it (a rotation finished, or a wrong key). */
  keyFor(id: string): StoreKey | null {
    if (id === this.current.id) return this.current;
    if (this.previous && id === this.previous.id) return this.previous;
    return null;
  }

  /** Overwrite the key bytes (process shutdown, tests). */
  wipe(): void {
    this.current.key.fill(0);
    this.previous?.key.fill(0);
  }
}
