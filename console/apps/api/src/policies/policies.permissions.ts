/** Agent policies. The exact strings the controller enforces and the clients declare; granted to the roles that hold `tasks:*`. */
export const POLICIES_PERMISSIONS = {
  AGENT_POLICIES_READ: { id: 'agent_policies:read', description: 'See own agent policies and the built-in ones', scope: 'org', defaultGrants: ['contributor', 'viewer', 'org_admin'] },
  AGENT_POLICIES_WRITE: { id: 'agent_policies:write', description: 'Create, edit, duplicate and delete own agent policies and choose the default', scope: 'org', defaultGrants: ['contributor', 'org_admin'] },
} as const;
