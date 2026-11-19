// What the owner saved as identity details, for the Secrets page (E37.6, #595): item names and field LABELS, read-only.
//
// The console asks the provider's identity lookup (`GET /identity`, labels and flags, never a value) with the owner's own access
// token, only to show the list. Which sites each sensitive field is allowed on is the provider's: Vault's agent API does not
// return that list, so the page says so and links to the provider. Nothing here is stored, logged or sent to a model.
import { Injectable, Logger } from '@nestjs/common';

import { SecretsPolicyService } from './secrets-policy.service';
import { VaultApiClient } from './vault-api.client';
import { VaultConnectionService } from './vault-connection.service';
import { hasIdentityScopes } from './vault-contract';
import { VaultAccessError, VaultTokenService } from './vault-token.service';

export type IdentityListReason = 'ok' | 'not_connected' | 'needs_reconnect' | 'needs_scope' | 'switched_off' | 'provider_off' | 'unavailable';

export interface IdentityListing {
  /** The owner's identity details can be read and used. */
  available: boolean;
  reason: IdentityListReason;
  /** Item names and field labels, in the provider's order. A label says whether the field is sensitive; never a value. */
  items: { name: string; fields: { label: string; sensitive: boolean }[] }[];
  /** The provider's address, to manage the items and their allowed sites; null when there is none. */
  manageUrl: string | null;
}

/** The longest an item name or a label is shown. */
const MAX_TEXT = 120;
const clip = (s: string) => s.replace(/\s+/g, ' ').trim().slice(0, MAX_TEXT);

@Injectable()
export class SecretsIdentityService {
  private readonly log = new Logger(SecretsIdentityService.name);

  constructor(
    private readonly policy: SecretsPolicyService,
    private readonly connection: VaultConnectionService,
    private readonly tokens: VaultTokenService,
    private readonly api: VaultApiClient,
  ) {}

  async list(userId: string): Promise<IdentityListing> {
    const empty = (reason: IdentityListReason, manageUrl: string | null = null): IdentityListing => ({ available: false, reason, items: [], manageUrl });
    const status = (await this.connection.status(userId)).providers.vault;
    const manageUrl = status.baseUrl ?? null;
    if (!(await this.policy.agentUse(userId)).effective) return empty('switched_off', manageUrl);
    if (status.status === 'needs_reconnect') return empty('needs_reconnect', manageUrl);
    if (status.status !== 'connected') return empty('not_connected', manageUrl);
    if (!hasIdentityScopes(status.scopes)) return empty('needs_scope', manageUrl);
    let access;
    try {
      access = await this.tokens.getAccess(userId);
    } catch (e) {
      if (e instanceof VaultAccessError) return empty(e.kind === 'needs_reconnect' ? 'needs_reconnect' : e.kind === 'not_connected' ? 'not_connected' : 'unavailable', manageUrl);
      throw e;
    }
    const allowedHosts = (await this.policy.system()).vault.allowedHosts;
    const r = await this.api.identity(access.baseUrl, access.accessToken, allowedHosts);
    if (r.status === 'identity_disabled') return empty('provider_off', manageUrl);
    if (r.status === 'unauthorized') return empty('needs_scope', manageUrl);
    if (r.status === 'unavailable') {
      this.log.warn(`could not list identity details (${r.code})`);
      return empty('unavailable', manageUrl);
    }
    return {
      available: true,
      reason: 'ok',
      manageUrl,
      items: r.items.map((i) => ({ name: clip(i.name), fields: i.fields.map((f) => ({ label: clip(f.label || f.field.replace(/_/g, ' ')), sensitive: f.sensitive })) })),
    };
  }
}
