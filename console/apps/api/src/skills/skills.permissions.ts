/** Skills (#1008). The exact strings the controller enforces and the web page declares. A user only ever sees their own. */
export const SKILLS_PERMISSIONS = {
  SKILLS_READ: { id: 'skills:read', description: 'See own skills (playbooks the agent reads)', scope: 'org', defaultGrants: ['contributor', 'viewer', 'org_admin'] },
  SKILLS_WRITE: { id: 'skills:write', description: 'Add, edit, enable, archive and delete own skills', scope: 'org', defaultGrants: ['contributor', 'org_admin'] },
} as const;
