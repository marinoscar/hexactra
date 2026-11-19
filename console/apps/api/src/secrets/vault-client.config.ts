// The Vault client an owner connects with (E37.2, #591): the owner's own address and client id (the connection row)
// or the deployment default (system settings), and the client secret (the owner's, else the deployment's).
import { Injectable } from '@nestjs/common';
import type { SecretsConnection } from '@prisma/client';

import { normalizeBaseUrl } from '../oauth-client';
import { SecretsPolicyService } from './secrets-policy.service';
import { VaultGrantStore } from './vault-grant.store';

export interface VaultClientConfig {
  baseUrl: string;
  clientId: string;
  clientSecret: string | null;
  /** Where the address and client id come from: the owner's own entry or the administrator's default. */
  source: 'user' | 'deployment';
  allowedHosts: readonly string[];
}

/** What is set, without a secret: for the status route. */
export interface VaultClientSummary {
  baseUrl: string | null;
  clientId: string | null;
  source: 'user' | 'deployment' | 'none';
  hasClientSecret: boolean;
  configured: boolean;
}

@Injectable()
export class VaultClientConfigs {
  constructor(
    private readonly policy: SecretsPolicyService,
    private readonly store: VaultGrantStore,
  ) {}

  /** The configuration to connect or refresh with, or null when the address or client id is missing. Plaintext secret: server-side only. */
  async effective(userId: string, row: Pick<SecretsConnection, 'baseUrl' | 'clientId'> | null): Promise<VaultClientConfig | null> {
    const system = await this.policy.system();
    const baseUrl = row?.baseUrl ?? system.vault.baseUrl;
    const clientId = row?.clientId ?? system.vault.clientId;
    if (!baseUrl || !clientId) return null;
    const secret = await this.store.clientSecret(userId);
    let normalized: string;
    try {
      normalized = normalizeBaseUrl(baseUrl);
    } catch {
      return null;
    }
    return { baseUrl: normalized, clientId, clientSecret: secret.secret, source: row?.baseUrl || row?.clientId ? 'user' : 'deployment', allowedHosts: system.vault.allowedHosts };
  }

  /** The same, as the owner may read it. */
  async summary(userId: string, row: Pick<SecretsConnection, 'baseUrl' | 'clientId'> | null): Promise<VaultClientSummary> {
    const system = await this.policy.system();
    const baseUrl = row?.baseUrl ?? system.vault.baseUrl;
    const clientId = row?.clientId ?? system.vault.clientId;
    const secret = await this.store.hasOwnClientSecret(userId);
    const deploymentSecret = !secret ? (await this.store.clientSecret(userId)).source === 'deployment' : false;
    const hasClientSecret = secret || deploymentSecret;
    const own = Boolean(row?.baseUrl || row?.clientId);
    return { baseUrl: baseUrl ?? null, clientId: clientId ?? null, source: baseUrl && clientId ? (own ? 'user' : 'deployment') : 'none', hasClientSecret, configured: Boolean(baseUrl && clientId && hasClientSecret) };
  }
}
