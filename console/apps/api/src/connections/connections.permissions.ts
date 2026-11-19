/** Connections (E39.2, #599). The exact strings the controllers enforce and the web pages declare. A user only ever sees and changes their own. */
export const CONNECTIONS_PERMISSIONS = {
  CONNECTIONS_READ: { id: 'connections:read', description: 'See own connected accounts (Google, Microsoft): label, capabilities, status', scope: 'org', defaultGrants: ['contributor', 'org_admin'] },
  CONNECTIONS_WRITE: { id: 'connections:write', description: 'Connect, rename, change what an account may do, pause, test and disconnect own connected accounts', scope: 'org', defaultGrants: ['contributor', 'org_admin'] },
} as const;
