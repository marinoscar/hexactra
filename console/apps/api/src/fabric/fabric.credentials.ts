import type { CredentialPurposeDef } from '@marinoscar/platform-api/credentials';

/**
 * Where the fabric connection lives: the deployment tier of the encrypted
 * credential store, purpose `hexactra_fabric` (permanent once a row exists).
 * Two names: `url` (the control plane's base URL) and `token` (an `hxs_`
 * service token). Configured at runtime on `/admin/settings/fabric`, never
 * through an environment variable.
 */
export const FABRIC_CREDENTIAL_PURPOSE: CredentialPurposeDef = {
  purpose: 'hexactra_fabric',
  owner: 'fabric',
  label: 'Hexactra Fabric control plane URL and service token',
  tiers: ['system'],
};

export const FABRIC_URL_NAME = 'url';
export const FABRIC_TOKEN_NAME = 'token';
