// The second binding of the service credentials port (E50.3, #973; decision record `docs/decisions/web-search.md` §3): the owner's
// own key (the USER tier only) kept in their secrets provider, their Vault or the built-in store, next to their saved logins.
//
// Which of the two answers is the owner's active provider (`secrets.provider`); the calls themselves are the secrets feature's
// (`apps/api/src/secrets/service-keys.ts`: the remote Vault's `GET /service-keys/{service}/{name}` with the owner's grant, or the
// built-in store's in-process release). This class adds:
//
//   - a cache of at most SERVICE_KEY_CACHE_MS (60 s) in this process's memory, so a run's searches are not one release each. A
//     cached value is a copy of bytes, wiped when it expires, when the key is set, moved or removed, and whenever the kill switch
//     is found off; every caller gets its own copy, which it wipes. The kill switch is read BEFORE the cache, so switching it off
//     stops releases at once;
//   - the mapping of a provider's miss to "no key" (`not_found`) or "not available" (everything else), which the router turns
//     into a fall to the next tier.
//
// The value never reaches a log line, a span, an audit row, a response or a model's context.
import { Injectable, Optional } from '@nestjs/common';

import { SecretBytes } from '../secrets/secrets-provider.port';
import { SecretsServiceKeys, type ServiceKeyMiss } from '../secrets/service-keys';
import type { SecretsProviderId } from '../secrets/secrets.settings';
import { storedName, type ServiceCredentialRef } from './service-credential.port';

/** The longest a released key is kept in memory. */
export const SERVICE_KEY_CACHE_MS = 60_000;

export type ProviderResolve = { status: 'found'; provider: SecretsProviderId; value: SecretBytes } | { status: 'none'; provider: SecretsProviderId | null } | { status: 'unavailable'; provider: SecretsProviderId | null; reason: ServiceKeyMiss | 'not_mounted' };

interface CacheEntry {
  bytes: Buffer;
  expiresAt: number;
  timer: ReturnType<typeof setTimeout> | null;
}

@Injectable()
export class SecretsProviderServiceCredentials {
  private readonly cache = new Map<string, CacheEntry>();

  /** The wall clock; tests replace it. */
  clock: () => number = Date.now;

  constructor(@Optional() private readonly keys?: SecretsServiceKeys) {}

  /** Whether the secrets feature is mounted at all (the credentials and notifications slices). */
  get mounted(): boolean {
    return this.keys !== undefined;
  }

  /** The owner's active provider, or null without the secrets feature. */
  async provider(userId: string): Promise<SecretsProviderId | null> {
    return this.keys ? this.keys.activeProvider(userId) : null;
  }

  private cacheKey(userId: string, provider: SecretsProviderId, ref: ServiceCredentialRef): string {
    return `${userId}|${provider}|${storedName(ref)}`;
  }

  /** The owner's key from their provider. `fresh` skips the cache (a move reads what is there now). */
  async resolve(ref: ServiceCredentialRef, userId: string, opts: { runId?: string; fresh?: boolean } = {}): Promise<ProviderResolve> {
    if (!this.keys) return { status: 'unavailable', provider: null, reason: 'not_mounted' };
    const provider = await this.keys.activeProvider(userId);
    // The kill switch first: a cached value is never handed out while releases are off.
    if (!(await this.keys.releasesEnabled())) {
      this.forget(userId);
      return { status: 'unavailable', provider, reason: 'disabled' };
    }
    const key = this.cacheKey(userId, provider, ref);
    if (!opts.fresh) {
      const hit = this.cache.get(key);
      if (hit && hit.expiresAt > this.clock()) return { status: 'found', provider, value: SecretBytes.from(hit.bytes) };
      if (hit) this.drop(key);
    }
    const r = await this.keys.release(userId, ref, opts.runId ? { runId: opts.runId } : {});
    if (!r.ok) return r.reason === 'not_found' ? { status: 'none', provider } : { status: 'unavailable', provider, reason: r.reason };
    this.remember(key, r.value);
    return { status: 'found', provider, value: r.value };
  }

  private remember(key: string, value: SecretBytes): void {
    this.drop(key);
    const bytes = value.expose((b) => Buffer.from(b));
    const timer = setTimeout(() => this.drop(key), SERVICE_KEY_CACHE_MS);
    timer.unref?.();
    this.cache.set(key, { bytes, expiresAt: this.clock() + SERVICE_KEY_CACHE_MS, timer });
  }

  private drop(key: string): void {
    const e = this.cache.get(key);
    if (!e) return;
    e.bytes.fill(0);
    if (e.timer) clearTimeout(e.timer);
    this.cache.delete(key);
  }

  /** Wipes the owner's cached keys (all of them, or one reference). */
  forget(userId: string, ref?: ServiceCredentialRef): void {
    for (const key of [...this.cache.keys()]) {
      if (!key.startsWith(`${userId}|`)) continue;
      if (ref && !key.endsWith(`|${storedName(ref)}`)) continue;
      this.drop(key);
    }
  }

  /** How many values are cached (tests). */
  get cached(): number {
    return this.cache.size;
  }

  describe(ref: ServiceCredentialRef, userId: string) {
    return this.keys ? this.keys.describe(userId, ref) : Promise.resolve(null);
  }

  async save(ref: ServiceCredentialRef, userId: string, label: string, value: SecretBytes) {
    this.forget(userId, ref);
    return this.keys ? this.keys.save(userId, ref, label, value) : ('disabled' as const);
  }

  async remove(ref: ServiceCredentialRef, userId: string) {
    this.forget(userId, ref);
    return this.keys ? this.keys.remove(userId, ref) : ('disabled' as const);
  }

  /** Whether the built-in store is attached (mounted) and offered, so the console can write a key into it. */
  builtinWritable(): Promise<boolean> {
    return this.keys ? this.keys.builtinWritable() : Promise.resolve(false);
  }

  /** Whether the owner's Vault grant has the scope service keys need. */
  vaultHasScope(userId: string): Promise<boolean> {
    return this.keys ? this.keys.vaultHasScope(userId) : Promise.resolve(false);
  }

  releasesEnabled(): Promise<boolean> {
    return this.keys ? this.keys.releasesEnabled() : Promise.resolve(false);
  }
}
