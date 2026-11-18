/**
 * Saved approvals (#554). The exact strings the controller enforces and the web declares. `approvals:write`
 * is granted like `runs:delete` (contributors and organization admins, not a viewer). It lets a caller
 * list, narrow, disable, re-enable and delete rules and pause them all: nothing creates a rule but the
 * owner's own tick on a server-issued question (`ApprovalRulesService.createFromAnswer`).
 */
export const APPROVALS_PERMISSIONS = {
  APPROVALS_READ: { id: 'approvals:read', description: 'See own saved approvals and their uses', scope: 'org', defaultGrants: ['contributor', 'viewer', 'org_admin'] },
  APPROVALS_WRITE: { id: 'approvals:write', description: 'Narrow, disable, delete and pause own saved approvals (never create one)', scope: 'org', defaultGrants: ['contributor', 'org_admin'] },
} as const;
