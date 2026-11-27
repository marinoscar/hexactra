// Which binding answers each tier (E50.3, #973; decision record `docs/decisions/web-search.md` §3). This is what
// `SERVICE_CREDENTIAL_PORT` is bound to; callers do not change.
//
//   user          the owner's choice per key (`serviceCredentials.keys[<ref>]`, else `serviceCredentials.binding`):
//                 `credential_store` (default) or `secrets_provider` (their Vault or the built-in store).
//   organization  always the credential store.
//   system        always the credential store.
//
// When the user's key is in their secrets provider and the provider cannot answer (unreachable, a kill switch off, the grant gone
// or lacking the scope), `resolveDetailed` moves on to the next allowed tier; if none holds a key it answers `PROVIDER_UNAVAILABLE`.
// A provider never makes this port throw: a run never fails because a Vault is down.
//
// `move` takes one user key from one binding to the other: read, write, and only once the write is confirmed record the new place
// and remove the old copy. A failed write leaves the key where it was.
import { Injectable, Logger, Optional } from '@nestjs/common';
import { UserSettingsService } from '@marinoscar/platform-api/settings';

import { PrismaService } from '../prisma/prisma.service';
import type { SecretBytes } from '../secrets/secrets-provider.port';
import type { SecretsProviderId } from '../secrets/secrets.settings';
import { CredentialStoreServiceCredentials } from './credential-store.binding';
import { SecretsProviderServiceCredentials } from './secrets-provider.binding';
import { storedName, type Binding, type CredentialTier, type ServiceCredentialPort, type ServiceCredentialRef, type ServiceCredentialResolution, type ServiceCredentialResolveOptions, type ServiceCredentialStatus, type Who } from './service-credential.port';
import { ServiceCredentialRegistry } from './service-credential.registry';
import { ServiceCredentialError } from './service-credentials.errors';
import { serviceCredentialsUserOf, userBindingOf, type UserBinding } from './service-credentials.settings';

/** Where the user's own key is, for the list route. */
export interface UserKeyPlace {
  /** `credential_store`, or the provider that holds it (`vault`, `builtin`). */
  binding: Binding;
  set: boolean;
  setAt: string | null;
}

export interface MoveResult {
  binding: Binding;
  /** The old copy was removed. False when there was none, or it is in the owner's remote Vault (the owner removes it there). */
  sourceRemoved: boolean;
}

const asBinding = (b: UserBinding, provider: SecretsProviderId | null): Binding => (b === 'credential_store' || !provider ? 'credential_store' : provider);

@Injectable()
export class RoutedServiceCredentials implements ServiceCredentialPort {
  private readonly log = new Logger('ServiceCredentials');

  constructor(
    private readonly registry: ServiceCredentialRegistry,
    private readonly store: CredentialStoreServiceCredentials,
    private readonly provider: SecretsProviderServiceCredentials,
    private readonly prisma: PrismaService,
    @Optional() private readonly settings?: UserSettingsService,
  ) {}

  /** Where the owner's key `ref` is kept. Without the secrets feature it is always the credential store. */
  async userBinding(ref: ServiceCredentialRef, userId: string): Promise<UserBinding> {
    if (!this.provider.mounted) return 'credential_store';
    const row = await this.prisma.userSettings.findUnique({ where: { userId }, select: { value: true } });
    return userBindingOf(serviceCredentialsUserOf(row?.value), storedName(ref));
  }

  private async recordBinding(ref: ServiceCredentialRef, userId: string, binding: UserBinding): Promise<void> {
    if (!this.settings) return;
    await this.settings.patchSettings(userId, { serviceCredentials: { keys: { [storedName(ref)]: binding } } } as never);
  }

  async resolve(ref: ServiceCredentialRef, who: Who, opts: ServiceCredentialResolveOptions = {}): Promise<{ tier: CredentialTier; value: SecretBytes } | null> {
    return (await this.resolveDetailed(ref, who, opts)).found;
  }

  async resolveDetailed(ref: ServiceCredentialRef, who: Who, opts: ServiceCredentialResolveOptions = {}): Promise<ServiceCredentialResolution> {
    const reg = this.registry.get(ref);
    if (!reg) return { found: null, reason: 'NONE' };
    let providerUnavailable = false;
    for (const tier of this.store.order(reg, who, opts)) {
      if (tier === 'user' && (await this.userBinding(ref, who.userId)) === 'secrets_provider') {
        const r = await this.provider.resolve(ref, who.userId, opts.runId ? { runId: opts.runId } : {});
        if (r.status === 'found') {
          this.store.count(ref.service, tier);
          return { found: { tier, value: r.value } };
        }
        if (r.status === 'unavailable') providerUnavailable = true;
        continue;
      }
      const value = await this.store.readTier(ref, tier, who);
      if (!value) continue;
      this.store.count(ref.service, tier);
      return { found: { tier, value } };
    }
    this.store.count(ref.service, 'none');
    return { found: null, reason: providerUnavailable ? 'PROVIDER_UNAVAILABLE' : 'NONE' };
  }

  /** Where the user's own key is and whether it is set. A remote Vault has no listing: a key recorded there is shown as set, with no time. */
  async userPlace(ref: ServiceCredentialRef, who: Who): Promise<UserKeyPlace> {
    const b = await this.userBinding(ref, who.userId);
    if (b === 'credential_store') {
      const at = await this.store.setTime(ref, 'user', who);
      return { binding: 'credential_store', set: at !== null, setAt: at?.toISOString() ?? null };
    }
    const d = await this.provider.describe(ref, who.userId);
    if (!d) return { binding: 'credential_store', set: false, setAt: null };
    if (d.provider === 'builtin') return { binding: 'builtin', set: d.setAt !== null, setAt: d.setAt?.toISOString() ?? null };
    // A remote Vault: recorded here when the owner moved it (and it was readable then). Whether it is still there is Vault's to say.
    const row = await this.prisma.userSettings.findUnique({ where: { userId: who.userId }, select: { value: true } });
    return { binding: 'vault', set: serviceCredentialsUserOf(row?.value).keys?.[storedName(ref)] === 'secrets_provider', setAt: null };
  }

  async status(ref: ServiceCredentialRef, who: Who, opts: ServiceCredentialResolveOptions = {}): Promise<ServiceCredentialStatus> {
    const base = await this.store.status(ref, who, opts);
    const reg = this.registry.get(ref);
    if (!reg?.tiers.includes('user')) return base;
    const place = await this.userPlace(ref, who);
    const tiers = { ...base.tiers, user: place.set };
    const order = this.store.order(reg, who, opts);
    const answering = order.find((t) => tiers[t]) ?? null;
    const setAt = answering === 'user' ? place.setAt : answering ? ((await this.store.setTime(ref, answering, who))?.toISOString() ?? null) : null;
    const binding: Binding = answering === null || answering === 'user' ? place.binding : 'credential_store';
    return { tier: answering, binding, setAt, tiers };
  }

  async set(ref: ServiceCredentialRef, tier: CredentialTier, who: Who, value: SecretBytes): Promise<void> {
    if (tier !== 'user') return this.store.set(ref, tier, who, value);
    const reg = this.registry.get(ref);
    if (!reg) throw new ServiceCredentialError('SERVICE_CREDENTIAL_UNKNOWN', 'No service credential is registered under this service and name.');
    if (!reg.tiers.includes('user')) throw new ServiceCredentialError('SERVICE_CREDENTIAL_TIER_NOT_ALLOWED', 'This key cannot be stored at this tier.', { tier });
    const b = await this.userBinding(ref, who.userId);
    if (b === 'credential_store') {
      await this.store.set(ref, 'user', who, value);
      await this.recordBinding(ref, who.userId, 'credential_store');
      return;
    }
    const problem = value.expose((buf) => reg.validate(buf.toString('utf8')));
    if (problem !== null) throw new ServiceCredentialError('SERVICE_CREDENTIAL_INVALID', 'The value does not have the shape this key has.', { reason: /^[a-z][a-z_]{0,39}$/.test(problem) ? problem : 'invalid' });
    const r = await this.provider.save(ref, who.userId, reg.label, value);
    if (r === 'read_only') throw new ServiceCredentialError('SERVICE_CREDENTIAL_PROVIDER_READ_ONLY', 'This key is kept in your Vault: change it there.');
    if (r !== 'saved') throw new ServiceCredentialError('SERVICE_CREDENTIAL_PROVIDER_UNAVAILABLE', 'Your secrets provider could not store the key.', { reason: r });
    await this.recordBinding(ref, who.userId, 'secrets_provider');
  }

  async delete(ref: ServiceCredentialRef, tier: CredentialTier, who: Who): Promise<void> {
    if (tier !== 'user') return this.store.delete(ref, tier, who);
    const b = await this.userBinding(ref, who.userId);
    // The console's copy goes in every case (idempotent).
    await this.store.delete(ref, 'user', who);
    if (b === 'credential_store') return;
    const r = await this.provider.remove(ref, who.userId);
    if (r === 'read_only') {
      // Kept in the owner's remote Vault: the console forgets it (the next key goes to the console) and the owner removes it in Vault.
      await this.recordBinding(ref, who.userId, 'credential_store');
      return;
    }
    if (r !== 'removed') throw new ServiceCredentialError('SERVICE_CREDENTIAL_PROVIDER_UNAVAILABLE', 'Your secrets provider could not remove the key.', { reason: r });
  }

  /**
   * Moves the owner's own key between the console and their secrets provider. Reads it, writes it to the other side, and only once
   * that write is confirmed records the new place and removes the old copy. The value stays in a buffer and is wiped. Into a remote
   * Vault the console cannot write: the owner adds the key there (a "Service key", opened to the agent) and Move then checks that the
   * Vault answers with it before the console's copy is removed.
   */
  async move(ref: ServiceCredentialRef, who: Who, to: UserBinding): Promise<MoveResult> {
    const reg = this.registry.get(ref);
    if (!reg) throw new ServiceCredentialError('SERVICE_CREDENTIAL_UNKNOWN', 'No service credential is registered under this service and name.');
    if (!reg.tiers.includes('user')) throw new ServiceCredentialError('SERVICE_CREDENTIAL_TIER_NOT_ALLOWED', 'This key cannot be stored at this tier.', { tier: 'user' });
    const provider = await this.provider.provider(who.userId);
    if (!provider) throw new ServiceCredentialError('SERVICE_CREDENTIAL_PROVIDER_UNAVAILABLE', 'There is no secrets provider on this deployment.', { reason: 'not_mounted' });
    const from = await this.userBinding(ref, who.userId);
    if (from === to) return { binding: asBinding(to, provider), sourceRemoved: false };

    if (to === 'secrets_provider') {
      const value = await this.store.readTier(ref, 'user', who);
      try {
        if (provider === 'builtin') {
          if (!value) throw new ServiceCredentialError('SERVICE_CREDENTIAL_NOT_SET', 'There is no key of yours to move.');
          const r = await this.provider.save(ref, who.userId, reg.label, value);
          if (r !== 'saved') throw new ServiceCredentialError('SERVICE_CREDENTIAL_PROVIDER_UNAVAILABLE', 'The built-in store could not take the key; it stays in the console.', { reason: r });
        } else {
          // The owner's Vault: the console cannot write there. It must already answer with the key.
          const r = await this.provider.resolve(ref, who.userId, { fresh: true });
          if (r.status === 'found') r.value.wipe();
          else throw new ServiceCredentialError('SERVICE_CREDENTIAL_NOT_IN_PROVIDER', 'Your Vault does not hold this key yet: add it there as a "Service key" opened to the agent, then move it again.', { reason: r.status === 'none' ? 'not_found' : r.reason });
        }
      } finally {
        value?.wipe();
      }
      await this.recordBinding(ref, who.userId, 'secrets_provider');
      const had = value !== null;
      if (had) await this.store.delete(ref, 'user', who);
      return { binding: provider, sourceRemoved: had };
    }

    // Into the console: read from the provider (never from the cache), write, then remove the provider's copy.
    const r = await this.provider.resolve(ref, who.userId, { fresh: true });
    if (r.status === 'none') throw new ServiceCredentialError('SERVICE_CREDENTIAL_NOT_SET', 'Your secrets provider holds no key of yours to move.');
    if (r.status === 'unavailable') throw new ServiceCredentialError('SERVICE_CREDENTIAL_PROVIDER_UNAVAILABLE', 'Your secrets provider could not answer; the key stays there.', { reason: r.reason });
    try {
      await this.store.set(ref, 'user', who, r.value);
    } finally {
      r.value.wipe();
    }
    await this.recordBinding(ref, who.userId, 'credential_store');
    this.provider.forget(who.userId, ref);
    if (provider === 'vault') return { binding: 'credential_store', sourceRemoved: false };
    const removed = await this.provider.remove(ref, who.userId);
    if (removed !== 'removed') this.log.warn(`service credential ${storedName(ref)}: moved to the console; the built-in store's copy could not be removed (${removed})`);
    return { binding: 'credential_store', sourceRemoved: removed === 'removed' };
  }
}
