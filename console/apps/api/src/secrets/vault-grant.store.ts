// Where the Vault grant's secrets live (E37.2, #591): the encrypted per-user credential store, never a column of
// `secrets_connections`. Three entries under purpose `secrets_vault_grant`:
//   refresh  the OAuth refresh token (rotates on use; only the console ever holds it)
//   access   the short-lived access token (the only thing the fabric is handed)
//   pending  the PKCE verifier and flow data of a Connect in progress (JSON, single use)
// plus the owner's client secret (`secrets_vault_client`), resolved owner first, then the deployment default.
//
// Every method that returns plaintext is for server-side use at the moment of use: never return one from a
// controller, never log one.
import { Injectable } from '@nestjs/common';
import { UserCredentialResolver, UserCredentialsService } from '@marinoscar/platform-api/credentials';

import {
  SECRETS_VAULT_CLIENT_PURPOSE,
  SECRETS_VAULT_GRANT_PURPOSE,
  VAULT_ACCESS_TOKEN_NAME,
  VAULT_CLIENT_SECRET_NAME,
  VAULT_PENDING_FLOW_NAME,
  VAULT_REFRESH_TOKEN_NAME,
} from './secrets.credentials';

/** The data of a Connect in progress, kept encrypted until the callback (or its expiry). */
export interface PendingVaultFlow {
  verifier: string;
  redirectUri: string;
  baseUrl: string;
  clientId: string;
  scopes: string[];
  /** Where the browser goes afterwards (a path on this console). */
  returnTo: string;
  /** The server's issuer, to check `iss` on the callback (RFC 9207). */
  issuer: string;
  issuerInResponse: boolean;
  tokenEndpoint: string;
  authorizationEndpoint: string;
  revocationEndpoint: string | null;
}

@Injectable()
export class VaultGrantStore {
  constructor(
    private readonly users: UserCredentialsService,
    private readonly resolver: UserCredentialResolver,
  ) {}

  // ---- the grant ----

  refreshToken(userId: string): Promise<string | null> {
    return this.users.getSecret(userId, SECRETS_VAULT_GRANT_PURPOSE, VAULT_REFRESH_TOKEN_NAME);
  }

  accessToken(userId: string): Promise<string | null> {
    return this.users.getSecret(userId, SECRETS_VAULT_GRANT_PURPOSE, VAULT_ACCESS_TOKEN_NAME);
  }

  /** The NEW refresh token is stored (replacing the old) before anything uses the new access token. */
  setRefreshToken(userId: string, token: string): Promise<void> {
    return this.users.setSecret(userId, SECRETS_VAULT_GRANT_PURPOSE, VAULT_REFRESH_TOKEN_NAME, token);
  }

  setAccessToken(userId: string, token: string): Promise<void> {
    return this.users.setSecret(userId, SECRETS_VAULT_GRANT_PURPOSE, VAULT_ACCESS_TOKEN_NAME, token);
  }

  /** Deletes both tokens (disconnect, a grant that is gone). Idempotent. */
  async clearGrant(userId: string): Promise<void> {
    await this.users.deleteSecret(userId, SECRETS_VAULT_GRANT_PURPOSE, VAULT_REFRESH_TOKEN_NAME);
    await this.users.deleteSecret(userId, SECRETS_VAULT_GRANT_PURPOSE, VAULT_ACCESS_TOKEN_NAME);
  }

  // ---- a Connect in progress ----

  setPending(userId: string, flow: PendingVaultFlow): Promise<void> {
    return this.users.setSecret(userId, SECRETS_VAULT_GRANT_PURPOSE, VAULT_PENDING_FLOW_NAME, JSON.stringify(flow));
  }

  async pending(userId: string): Promise<PendingVaultFlow | null> {
    const raw = await this.users.getSecret(userId, SECRETS_VAULT_GRANT_PURPOSE, VAULT_PENDING_FLOW_NAME);
    if (!raw) return null;
    try {
      const flow = JSON.parse(raw) as PendingVaultFlow;
      return typeof flow.verifier === 'string' && typeof flow.redirectUri === 'string' && typeof flow.baseUrl === 'string' ? flow : null;
    } catch {
      return null;
    }
  }

  clearPending(userId: string): Promise<void> {
    return this.users.deleteSecret(userId, SECRETS_VAULT_GRANT_PURPOSE, VAULT_PENDING_FLOW_NAME);
  }

  // ---- the client secret ----

  /** The owner's client secret, else the deployment default; `none` when neither is set. */
  async clientSecret(userId: string): Promise<{ source: 'user' | 'deployment' | 'none'; secret: string | null }> {
    const r = await this.resolver.resolve(userId, SECRETS_VAULT_CLIENT_PURPOSE, VAULT_CLIENT_SECRET_NAME);
    if (r.source === 'none') return { source: 'none', secret: null };
    return { source: r.source === 'user' ? 'user' : 'deployment', secret: r.secret };
  }

  /** Whether the OWNER stored their own client secret (not the deployment's). A presence check: nothing is decrypted. */
  async hasOwnClientSecret(userId: string): Promise<boolean> {
    return (await this.users.describe(userId, SECRETS_VAULT_CLIENT_PURPOSE, VAULT_CLIENT_SECRET_NAME)) !== null;
  }

  /** Blank preserves the stored secret. */
  setClientSecret(userId: string, secret: string | null | undefined): Promise<void> {
    return this.users.setSecret(userId, SECRETS_VAULT_CLIENT_PURPOSE, VAULT_CLIENT_SECRET_NAME, secret);
  }

  deleteClientSecret(userId: string): Promise<void> {
    return this.users.deleteSecret(userId, SECRETS_VAULT_CLIENT_PURPOSE, VAULT_CLIENT_SECRET_NAME);
  }
}
