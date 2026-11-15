/** Tasks and runs. The exact strings the controllers enforce and the clients declare. */
export const TASKS_PERMISSIONS = {
  TASKS_READ: { id: 'tasks:read', description: 'See own browser tasks', scope: 'org', defaultGrants: ['contributor', 'viewer', 'org_admin'] },
  TASKS_WRITE: { id: 'tasks:write', description: 'Create, edit and delete own browser tasks', scope: 'org', defaultGrants: ['contributor', 'org_admin'] },
  RUNS_READ: { id: 'runs:read', description: 'See own runs and their steps', scope: 'org', defaultGrants: ['contributor', 'viewer', 'org_admin'] },
  RUNS_WRITE: { id: 'runs:write', description: 'Start and cancel runs', scope: 'org', defaultGrants: ['contributor', 'org_admin'] },
} as const;
