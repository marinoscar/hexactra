/**
 * Secrets providers (E37.2, #591). The exact strings the controller enforces and the web page declares.
 * A user only ever sees and changes their own connection; the deployment default Vault client is
 * `system_settings:read` / `system_settings:write` (the administrator's).
 */
export const SECRETS_PERMISSIONS = {
  SECRETS_READ: { id: 'secrets:read', description: 'See the status of own secrets connections (never a secret)', scope: 'org', defaultGrants: ['contributor', 'viewer', 'org_admin'] },
  SECRETS_WRITE: { id: 'secrets:write', description: 'Connect, disconnect and configure own secrets providers (Vault)', scope: 'org', defaultGrants: ['contributor', 'org_admin'] },
} as const;
