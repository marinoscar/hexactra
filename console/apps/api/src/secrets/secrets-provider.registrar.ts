// Hands the fabric the owner's Vault, and keeps its short-lived access token fresh (E37.2, #591).
//
// Called by whatever starts a run that may use stored secrets (E37.3) and by the keep-fresh job while a run is
// live. It registers only when BOTH switches are on (the deployment's `secrets.agentUse.enabled` and the owner's), a
// grant exists and the fabric can take it; otherwise it makes sure the fabric holds NOTHING for the owner. The fabric
// is given the base URL, the access token and its expiry: never the refresh token, which does not leave
// `VaultTokenService`.
import { Inject, Injectable, Logger } from '@nestjs/common';

import { FABRIC_SECRETS_REGISTRY, FabricSecretsUnavailable, type FabricSecretsRegistry } from './fabric-secrets-registry';
import { SecretsPolicyService } from './secrets-policy.service';
import { VaultAccessError, VaultTokenService } from './vault-token.service';

export type RegistrationResult =
  /** The fabric holds a fresh access token for the owner. */
  | 'registered'
  /** A switch is off: the fabric was told to forget the owner's provider. */
  | 'not_enabled'
  | 'not_connected'
  | 'needs_reconnect'
  /** The Vault or the fabric could not be reached (or no fabric connection is configured): try again. */
  | 'unavailable';

/** Replace the fabric's token when fewer than this remain. */
export const REGISTRATION_MIN_REMAINING_MS = 90_000;

@Injectable()
export class SecretsProviderRegistrar {
  private readonly log = new Logger(SecretsProviderRegistrar.name);
  /** The expiry of the token last pushed per owner (not the token). */
  private readonly pushed = new Map<string, number>();

  /** The wall clock; tests replace it. */
  clock: () => number = Date.now;

  constructor(
    private readonly policy: SecretsPolicyService,
    private readonly tokens: VaultTokenService,
    @Inject(FABRIC_SECRETS_REGISTRY) private readonly fabric: FabricSecretsRegistry,
  ) {}

  /**
   * Makes the fabric hold a fresh access token for `userId`, or nothing. `force` pushes the token even if it was
   * pushed before (a run starting after a fabric restart: the fabric keeps providers in memory only).
   */
  async ensureRegistered(userId: string, opts: { force?: boolean } = {}): Promise<RegistrationResult> {
    if (!(await this.policy.agentUse(userId)).effective) {
      await this.forget(userId);
      return 'not_enabled';
    }
    let access;
    try {
      access = await this.tokens.getAccess(userId, { minRemainingMs: REGISTRATION_MIN_REMAINING_MS });
    } catch (e) {
      if (e instanceof VaultAccessError) {
        if (e.kind === 'not_connected') return 'not_connected';
        if (e.kind === 'needs_reconnect') {
          await this.forget(userId);
          return 'needs_reconnect';
        }
        return 'unavailable';
      }
      throw e;
    }
    const last = this.pushed.get(userId);
    if (!opts.force && last !== undefined && last === access.expiresAt.getTime() && last - this.clock() > 30_000) return 'registered';
    try {
      await this.fabric.registerSecretsProvider(userId, { kind: 'vault', baseUrl: access.baseUrl, accessToken: access.accessToken, expiresAt: access.expiresAt.toISOString() });
    } catch (e) {
      this.log.warn(`the fabric did not take the secrets provider (${e instanceof FabricSecretsUnavailable ? e.reason : e instanceof Error ? e.name : 'error'})`);
      this.pushed.delete(userId);
      return 'unavailable';
    }
    this.pushed.set(userId, access.expiresAt.getTime());
    return 'registered';
  }

  /** Tells the fabric to forget the owner's provider (a run ended with no other live, a switch turned off). */
  async forget(userId: string): Promise<void> {
    this.pushed.delete(userId);
    await this.fabric.unregisterSecretsProvider(userId, 'vault').catch((e: unknown) => this.log.warn(`the fabric could not be told to forget the provider (${e instanceof Error ? e.name : 'error'})`));
  }
}
