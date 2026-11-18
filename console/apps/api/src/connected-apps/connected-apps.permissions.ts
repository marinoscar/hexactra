/**
 * Connected AI apps (#464). The exact strings `/api/connected-apps` enforces and
 * the web's "AI apps" card declares; granted to the roles that hold `tasks:write`.
 * The routes act on the caller's own apps only.
 */
export const CONNECTED_APPS_PERMISSIONS = {
  CONNECTED_APPS_READ: { id: 'connected_apps:read', description: 'See own connected AI apps, their limits and usage', scope: 'org', defaultGrants: ['contributor', 'org_admin'] },
  CONNECTED_APPS_WRITE: { id: 'connected_apps:write', description: 'Change the limits of own connected AI apps and pause them', scope: 'org', defaultGrants: ['contributor', 'org_admin'] },
} as const;
