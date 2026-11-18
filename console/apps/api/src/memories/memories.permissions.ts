/** Memories (#551). The exact strings the controller enforces and the web page declares. A user only ever sees their own. */
export const MEMORIES_PERMISSIONS = {
  MEMORIES_READ: { id: 'memories:read', description: 'See and export own memories', scope: 'org', defaultGrants: ['contributor', 'viewer', 'org_admin'] },
  MEMORIES_WRITE: { id: 'memories:write', description: 'Add, edit, supersede, archive and delete own memories', scope: 'org', defaultGrants: ['contributor', 'org_admin'] },
} as const;
