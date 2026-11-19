// The few shapes of Vault's agent credential API the console needs (E37.2, #591), MIRRORED here by hand.
//
// Source: marinoscar/vault `docs/agent-credential-api.md` at commit 749cbc69 (agent contract 1.2, stability
// BETA). We deliberately do not depend on `@marinoscar/vault-contract/agent` (not published yet,
// marinoscar/vault#192); switching to it is a follow-up. Only what the CONSOLE calls is mirrored: the OAuth
// connection (scopes, resource indicator, endpoints) and `GET /whoami`. Looking up a login, filling a field and
// fetching a one-time code are the FABRIC's calls (the Rust provider), not the console's: the console never
// sees a login, a password or a code.
import { z } from 'zod';

/** `AGENT_API_BASE_PATH`: the agent API's path under the Vault's `APP_URL`. */
export const VAULT_AGENT_API_PATH = '/api/agent/v1';

/** The OAuth scopes of the agent API (`AGENT_SCOPES`), logins only: cards and identity are E37.6/E37.7. */
export const VAULT_SCOPES = {
  read: 'vault:items_read',
  fill: 'vault:items_fill',
  write: 'vault:items_write',
  offline: 'offline_access',
} as const;

/** What Connect asks for. `vault:items_write` (create, rotate) only when the owner switched on "let the agent save and change logins" (E37.4): adding it later is a new consent. */
export function vaultConnectScopes(allowWrite: boolean): string[] {
  return [VAULT_SCOPES.read, VAULT_SCOPES.fill, ...(allowWrite ? [VAULT_SCOPES.write] : []), VAULT_SCOPES.offline];
}

/** The Vault's authorization server paths (Vault's guide, section 1), used when it publishes no metadata. */
export const VAULT_OAUTH_PATHS = {
  metadata: '/api/oauth/.well-known/authorization-server',
  authorize: '/api/oauth/authorize',
  token: '/api/oauth/token',
  revoke: '/api/oauth/revoke',
} as const;

/** The resource indicator, sent on both the authorize and the token requests: `<APP_URL>/api/agent/v1`. */
export function vaultResource(baseUrl: string): string {
  return `${baseUrl.replace(/\/+$/, '')}${VAULT_AGENT_API_PATH}`;
}

/** The error codes of the agent API (`AGENT_ERROR_CODES`) the console reads. Never branch on a `message`. */
export const VAULT_ERROR_CODES = {
  disabled: 'AGENT_ACCESS_DISABLED',
  originMismatch: 'ORIGIN_MISMATCH',
  credentialRequired: 'AGENT_CREDENTIAL_REQUIRED',
  rateLimited: 'RATE_LIMITED',
} as const;

/** `agentWhoamiResponseSchema`: `{ data: { userId, scopes, clientId, contract? } }`. Unknown fields are ignored (the contract is additive). */
export const vaultWhoamiSchema = z.object({
  data: z.object({
    userId: z.string().min(1).max(100),
    scopes: z.array(z.string()).default([]),
    clientId: z.string().optional(),
    contract: z.object({ version: z.string().optional(), features: z.array(z.string()).optional() }).optional(),
  }),
});
export type VaultWhoami = z.infer<typeof vaultWhoamiSchema>['data'];
