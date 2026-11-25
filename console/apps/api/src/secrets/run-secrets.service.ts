// What the goal runner needs of the secrets providers (E37.3, #592): make the fabric hold the owner's provider before
// a run that may sign in from a saved login, and report how each provider call went, so a refused connection shows
// up in Settings (`needs_reconnect`, one notification) and a switched-off Vault turns `agentAccess` off.
//
// A thin seam over `SecretsProviderRegistrar` and `VaultConnectionService`, so the runner does not depend on the
// Vault connection files and a test can hand it a plain object. The runner never receives a token, a login or a code.
import { Injectable, Logger } from '@nestjs/common';

import { SaveLoginService, type SaveLoginOffer, type SaveLoginOrigin } from './save-login.service';
import { SecretsPolicyService } from './secrets-policy.service';
import { SecretsProviderRegistrar, type RegistrationResult } from './secrets-provider.registrar';
import { VaultConnectionService, type ProviderOutcome } from './vault-connection.service';
import { hasCardScopes, hasIdentityScopes } from './vault-contract';

@Injectable()
export class RunSecretsService {
  private readonly log = new Logger(RunSecretsService.name);

  constructor(
    private readonly registrar: SecretsProviderRegistrar,
    private readonly connection: VaultConnectionService,
    private readonly policy: SecretsPolicyService,
    private readonly saveLogins: SaveLoginService,
  ) {}

  /**
   * Whether `userId`'s run may use saved logins right now: both switches on, a Vault connected and its access token
   * handed to the fabric (pushed again, because the fabric keeps providers in memory only and may have restarted).
   * Anything but `registered` means the run asks the owner as it always did.
   */
  async prepare(userId: string): Promise<RegistrationResult> {
    try {
      return await this.registrar.ensureRegistered(userId, { force: true });
    } catch (e) {
      this.log.warn(`could not prepare the secrets provider for a run (${e instanceof Error ? e.name : 'error'})`);
      return 'unavailable';
    }
  }

  /**
   * Whether the owner's active provider can look up and fill identity details (E37.6): the remote Vault, with a grant that holds
   * both identity scopes. The built-in store holds logins only. The runner asks this only for a run whose task or chat opted in
   * to identity. Never throws.
   */
  async identitySupported(userId: string): Promise<boolean> {
    try {
      if ((await this.policy.activeProvider(userId)) !== 'vault') return false;
      return hasIdentityScopes(await this.connection.grantedScopes(userId));
    } catch (e) {
      this.log.warn(`could not read the granted scopes (${e instanceof Error ? e.name : 'error'})`);
      return false;
    }
  }

  /**
   * Whether the owner's active provider can look up and fill payment cards (E37.7): the remote Vault, with a grant that holds both
   * card scopes. The built-in store holds logins only. The runner asks this only for a run whose task or chat opted in to cards.
   * Never throws.
   */
  async cardsSupported(userId: string): Promise<boolean> {
    try {
      if ((await this.policy.activeProvider(userId)) !== 'vault') return false;
      return hasCardScopes(await this.connection.grantedScopes(userId));
    } catch (e) {
      this.log.warn(`could not read the granted scopes (${e instanceof Error ? e.name : 'error'})`);
      return false;
    }
  }

  /**
   * Whether a sign-in the owner types by hand can be offered to their provider (E37.4b): both switches on, the Vault connected with
   * the write scope and speaking contract 1.3. The runner asks it when it opens a `credentials` card. Never throws.
   */
  /** Whether the owner's provider keeps Hexactra passkeys (E47.2): the built-in store today (Vault: E47.3). Never throws. */
  async passkeysSupported(userId: string): Promise<boolean> {
    try {
      return (await this.policy.activeProvider(userId)) === 'builtin';
    } catch {
      return false;
    }
  }

  saveLoginSupported(userId: string): Promise<boolean> {
    return this.saveLogins.supported(userId);
  }

  /** Offers the sign-in of a typed `credentials` handoff as a "Save this login?" card (E37.4b). Never the password; never throws. */
  async proposeSaveLogin(userId: string, args: { handoffId: string; origin: string; name: string | null; from: SaveLoginOrigin }): Promise<SaveLoginOffer> {
    try {
      return await this.saveLogins.propose(userId, args);
    } catch (e) {
      this.log.warn(`could not offer to save a sign-in (${e instanceof Error ? e.name : 'error'})`);
      return { proposed: false, message: 'Could not offer to save the sign-in right now.' };
    }
  }

  /** The address of the owner's provider, to point them to it ("add this site in <address>"); null when there is none. Never throws. */
  async providerAddress(userId: string): Promise<string | null> {
    try {
      return (await this.connection.status(userId)).providers.vault.baseUrl ?? null;
    } catch {
      return null;
    }
  }

  /** Reports one provider call to the connection's status. Never throws: a failed report never fails a run. */
  async outcome(userId: string, outcome: ProviderOutcome): Promise<void> {
    try {
      await this.connection.recordOutcome(userId, outcome);
    } catch (e) {
      this.log.warn(`could not record a secrets provider outcome (${e instanceof Error ? e.name : 'error'})`);
    }
  }
}
