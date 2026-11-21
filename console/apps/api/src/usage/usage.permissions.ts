/** AI usage and cost (#733). The exact strings the controllers enforce and the clients declare. */
export const USAGE_PERMISSIONS = {
  USAGE_READ: { id: 'usage:read', description: 'See own AI usage and cost', scope: 'org', defaultGrants: ['contributor', 'viewer', 'org_admin'] },
} as const;
