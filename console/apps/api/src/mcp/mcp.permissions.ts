/**
 * External AI apps (#465). `mcp_activity:read` is the exact string
 * `GET /api/admin/mcp/activity` enforces: every user's audit trail of the MCP
 * endpoint, for an administrator. A user reads their own with `runs:read`
 * (`GET /api/mcp/activity`).
 */
export const MCP_PERMISSIONS = {
  MCP_ACTIVITY_READ: { id: 'mcp_activity:read', description: "See every user's AI app activity (the MCP audit trail)", scope: 'system', defaultGrants: ['admin'] },
} as const;
