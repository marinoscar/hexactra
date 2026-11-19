// The credential purposes of the Vault connection (E37.2, #591). A purpose is the cipher's sub-key domain, so it
// is PERMANENT once a row exists: add one, never rename one.
//
//   secrets_vault_client  the OAuth client secret Hexactra holds for the owner's Vault. User tier ('default'),
//                         with the administrator's deployment default as the fallback (system tier, 'default'),
//                         so a user may only have to press Connect.
//   secrets_vault_grant   the grant itself, user tier only: 'refresh' (the OAuth refresh token, rotated on use),
//                         'access' (the short-lived access token) and 'pending' (the PKCE verifier and flow data
//                         of a Connect in progress). The fabric is only ever given the access token.
import type { CredentialPurposeDef, UserCredentialPurposeDef } from '@marinoscar/platform-api/credentials';

export const SECRETS_VAULT_CLIENT_PURPOSE = 'secrets_vault_client';
export const SECRETS_VAULT_GRANT_PURPOSE = 'secrets_vault_grant';

/** Names within the purposes. */
export const VAULT_CLIENT_SECRET_NAME = 'default';
export const VAULT_REFRESH_TOKEN_NAME = 'refresh';
export const VAULT_ACCESS_TOKEN_NAME = 'access';
export const VAULT_PENDING_FLOW_NAME = 'pending';

/** The deployment's default client secret (system tier). */
export const SECRETS_VAULT_CLIENT_SYSTEM_PURPOSE: CredentialPurposeDef = {
  purpose: SECRETS_VAULT_CLIENT_PURPOSE,
  owner: 'secrets',
  label: 'Default OAuth client secret for the Vault connection',
  tiers: ['system'],
};

/** The user tiers of the two purposes, for `registerUserCredentialPurpose`. */
export const SECRETS_USER_CREDENTIAL_PURPOSES: readonly UserCredentialPurposeDef[] = [
  {
    purpose: SECRETS_VAULT_CLIENT_PURPOSE,
    label: 'Vault OAuth client secret',
    description: 'The secret of the OAuth client your Vault registered for Hexactra. Used to connect and to refresh the grant; never shown again.',
    system: { purpose: SECRETS_VAULT_CLIENT_PURPOSE, name: VAULT_CLIENT_SECRET_NAME },
    fallback: ['system'],
  },
  {
    purpose: SECRETS_VAULT_GRANT_PURPOSE,
    label: 'Vault grant',
    description: 'The tokens Vault issued when you connected it (a refresh token and a short-lived access token). Never shown.',
    system: null,
  },
];
