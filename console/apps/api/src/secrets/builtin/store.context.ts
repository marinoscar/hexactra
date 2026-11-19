// The owner's keys for one operation (E37.5, #594).
//
// Vault's crypto port is SYNCHRONOUS and context-free: `encrypt(plaintext)` / `decrypt(ciphertext, iv, authTag)`.
// The envelope needs the owner's data key, which is in the database, so it is loaded BEFORE the operation and held in
// an AsyncLocalStorage for exactly its duration: the request interceptor (store.interceptor.ts) does it for the
// embedded controllers, `SecretsStoreKeys.scope` for the in-process agent calls. Outside a scope the crypto port
// throws (fail closed): nothing encrypts or decrypts by accident.
//
// `current` is the owner whose request this is (encrypt uses their key); `keys` is every data key loaded (decrypt
// uses the key of the owner NAMED IN THE CIPHERTEXT and refuses a ciphertext whose owner is not in the scope, so a
// session can never decrypt another owner's row even if some query returned it). Key bytes are zeroed when the scope
// ends.
import { AsyncLocalStorage } from 'node:async_hooks';

export interface StoreKeyScope {
  readonly current: string;
  readonly keys: ReadonlyMap<string, Buffer>;
}

const storage = new AsyncLocalStorage<StoreKeyScope>();

/** The active scope, or undefined. */
export function currentKeyScope(): StoreKeyScope | undefined {
  return storage.getStore();
}

/** Runs `fn` with `scope` active, then zeroes the key bytes (also when `fn` throws). */
export async function runInKeyScope<R>(scope: StoreKeyScope, fn: () => Promise<R>): Promise<R> {
  try {
    return await storage.run(scope, fn);
  } finally {
    for (const key of scope.keys.values()) key.fill(0);
  }
}
