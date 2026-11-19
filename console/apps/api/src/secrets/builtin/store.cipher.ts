// Envelope encryption of the built-in store (E37.5, #594). Plain Node crypto, no Nest, no Prisma, no Vault package.
//
//   store key (env, SECRETS_STORE_KEY)  --wraps-->  data key (random, one per owner, stored only wrapped)
//   data key                            --encrypts--> every value of that owner (AES-256-GCM)
//
// Associated data binds each ciphertext to its role and owner, so a wrapped key or a value copied to another row or
// another user fails authentication. The value's own item and field are NOT in the associated data: Vault's crypto
// port is `encrypt(plaintext)` and gives the adapter no item or field (marinoscar/vault upstream request). The owner
// is, because the adapter knows the user of the request (store.context.ts).
//
// The port's `ciphertext` string carries a version and the owner: `ss1.<userId>.<base64 ciphertext>`. `decrypt` reads
// the owner from it, takes that owner's data key from the request context and fails closed (throws) when the key is
// absent, wrong or the tag does not verify. No message here carries a key, a plaintext or a ciphertext.
import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';

import type { StoreKeyRing } from './store.keys';

const ALGORITHM = 'aes-256-gcm';
const IV_BYTES = 12;
const TAG_BYTES = 16;
export const DATA_KEY_BYTES = 32;
const VALUE_PREFIX = 'ss1';
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** A cryptographic failure: wrong key, tampered data, malformed input. Generic on purpose. */
export class SecretsStoreCryptoError extends Error {
  constructor(readonly reason: 'wrong_key' | 'key_unavailable' | 'malformed' | 'no_context' | 'foreign_owner') {
    super(`The secrets store could not process the value (${reason}).`);
    this.name = 'SecretsStoreCryptoError';
  }
}

const wrapAad = (userId: string, keyId: string) => Buffer.from(`hexactra.secrets-store.v1|dek|${userId}|${keyId}`, 'utf8');
const valueAad = (userId: string) => Buffer.from(`hexactra.secrets-store.v1|value|${userId}`, 'utf8');

/** A fresh random data key. */
export function newDataKey(): Buffer {
  return randomBytes(DATA_KEY_BYTES);
}

/** `base64(iv || authTag || ciphertext)` of `dataKey` under the ring's current key. */
export function wrapDataKey(ring: StoreKeyRing, userId: string, dataKey: Buffer): { keyId: string; wrapped: string } {
  const { id, key } = ring.current;
  const iv = randomBytes(IV_BYTES);
  const cipher = createCipheriv(ALGORITHM, key, iv);
  cipher.setAAD(wrapAad(userId, id));
  const ct = Buffer.concat([cipher.update(dataKey), cipher.final()]);
  return { keyId: id, wrapped: Buffer.concat([iv, cipher.getAuthTag(), ct]).toString('base64') };
}

/** The data key inside `wrapped`. Throws {@link SecretsStoreCryptoError}. */
export function unwrapDataKey(ring: StoreKeyRing, userId: string, keyId: string, wrapped: string): Buffer {
  const storeKey = ring.keyFor(keyId);
  if (!storeKey) throw new SecretsStoreCryptoError('key_unavailable');
  const raw = Buffer.from(wrapped, 'base64');
  if (raw.length !== IV_BYTES + TAG_BYTES + DATA_KEY_BYTES) throw new SecretsStoreCryptoError('malformed');
  try {
    const decipher = createDecipheriv(ALGORITHM, storeKey.key, raw.subarray(0, IV_BYTES));
    decipher.setAAD(wrapAad(userId, keyId));
    decipher.setAuthTag(raw.subarray(IV_BYTES, IV_BYTES + TAG_BYTES));
    return Buffer.concat([decipher.update(raw.subarray(IV_BYTES + TAG_BYTES)), decipher.final()]);
  } catch {
    throw new SecretsStoreCryptoError('wrong_key');
  }
}

/** Re-wraps a data key under the ring's current key. The data key never leaves memory; the result is what is stored. */
export function rewrapDataKey(ring: StoreKeyRing, userId: string, keyId: string, wrapped: string): { keyId: string; wrapped: string; dataKey: Buffer } {
  const dataKey = unwrapDataKey(ring, userId, keyId, wrapped);
  return { ...wrapDataKey(ring, userId, dataKey), dataKey };
}

export interface EncryptedValue {
  ciphertext: string;
  iv: string;
  authTag: string;
}

/** Encrypts `plaintext` under `userId`'s data key. */
export function encryptValue(userId: string, dataKey: Buffer, plaintext: string): EncryptedValue {
  const iv = randomBytes(IV_BYTES);
  const cipher = createCipheriv(ALGORITHM, dataKey, iv);
  cipher.setAAD(valueAad(userId));
  const ct = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  return { ciphertext: `${VALUE_PREFIX}.${userId}.${ct.toString('base64')}`, iv: iv.toString('base64'), authTag: cipher.getAuthTag().toString('base64') };
}

/** The owner a stored ciphertext names (without decrypting it), or null when it is not one of ours. */
export function ownerOfCiphertext(ciphertext: string): string | null {
  const [prefix, userId, body] = ciphertext.split('.');
  return prefix === VALUE_PREFIX && userId !== undefined && UUID.test(userId) && body !== undefined && body.length > 0 ? userId.toLowerCase() : null;
}

/** Decrypts with `dataKey`, which the caller took for {@link ownerOfCiphertext}'s owner. Throws {@link SecretsStoreCryptoError}. */
export function decryptValue(userId: string, dataKey: Buffer, ciphertext: string, iv: string, authTag: string): string {
  const body = ciphertext.slice(`${VALUE_PREFIX}.${userId}.`.length);
  try {
    const decipher = createDecipheriv(ALGORITHM, dataKey, Buffer.from(iv, 'base64'));
    decipher.setAAD(valueAad(userId));
    decipher.setAuthTag(Buffer.from(authTag, 'base64'));
    return Buffer.concat([decipher.update(Buffer.from(body, 'base64')), decipher.final()]).toString('utf8');
  } catch {
    throw new SecretsStoreCryptoError('wrong_key');
  }
}
