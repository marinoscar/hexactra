/** The Knowledge Graph (epic E46, #777). The exact strings the routes enforce and the web pages declare. A user only ever sees their own graph. */
export const KGRAPH_PERMISSIONS = {
  KGRAPH_READ: { id: 'kgraph:read', description: 'See own Knowledge Graph: its switches, procedures and history', scope: 'org', defaultGrants: ['contributor', 'viewer', 'org_admin'] },
  KGRAPH_WRITE: { id: 'kgraph:write', description: "Change own Knowledge Graph: a task's mode, reviews, and deleting everything learned", scope: 'org', defaultGrants: ['contributor', 'org_admin'] },
  KGRAPH_ADMIN: { id: 'kgraph:admin', description: 'Turn the Knowledge Graph on or off for the whole deployment', scope: 'system', defaultGrants: ['admin'] },
} as const;
