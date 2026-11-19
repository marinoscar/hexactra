/**
 * Secrets providers (E37.2, #591) and the built-in store (E37.5, #594). The exact strings the controllers enforce and
 * the web pages declare. A user only ever sees and changes their own connection and their own saved logins; the
 * deployment default Vault client is `system_settings:read` / `system_settings:write` (the administrator's).
 *
 * THERE IS NO `*_any` PERMISSION and none is declared: in Vault an administrator can read every user's secrets
 * (`secrets:read_any`); in the console's built-in store no role can read another user's secret values, so the
 * permission does not exist to be granted (`test/secrets-store.db.spec.ts` walks every role). The ids below are the
 * strings the embedded Vault controllers enforce (`@marinoscar/vault-api` hard-codes them), declared here so they are
 * seeded and grantable; they are the same strings as Vault's, with the console's grants.
 */
export const SECRETS_PERMISSIONS = {
  SECRETS_READ: { id: 'secrets:read', description: 'See the status of own secrets connections and read own saved logins in the built-in store', scope: 'org', defaultGrants: ['contributor', 'viewer', 'org_admin'] },
  SECRETS_WRITE: { id: 'secrets:write', description: 'Connect, disconnect and configure own secrets providers (Vault); create and change own saved logins in the built-in store', scope: 'org', defaultGrants: ['contributor', 'org_admin'] },
  SECRETS_DELETE: { id: 'secrets:delete', description: 'Delete own saved logins in the built-in store', scope: 'org', defaultGrants: ['contributor', 'org_admin'] },
  SECRET_TYPES_READ: { id: 'secret_types:read', description: 'See the secret types of the built-in store (the Credential type)', scope: 'org', defaultGrants: ['contributor', 'viewer', 'org_admin'] },
  // Custom secret types are not part of the console's store (logins only): declared because the embedded controller
  // names them, granted to no role.
  SECRET_TYPES_WRITE: { id: 'secret_types:write', description: 'Create and change secret types (not used by the console: the built-in store holds logins only)', scope: 'org', defaultGrants: [] },
  SECRET_TYPES_DELETE: { id: 'secret_types:delete', description: 'Delete secret types (not used by the console: the built-in store holds logins only)', scope: 'org', defaultGrants: [] },
} as const;
