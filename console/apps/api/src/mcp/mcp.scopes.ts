// The OAuth scopes of the console's MCP tools (epic #458, "Scopes"). Every
// tool names exactly one scope (`McpTool.scope`). In E33.4 the scope is
// metadata only: the docs table and the manifest snapshot are generated from
// it. E33.2 gates `tools/list` and `tools/call` on it for OAuth callers;
// personal access tokens and sessions keep every tool.

/** Every scope a tool may name, in consent order (low risk first). */
export const MCP_SCOPE_IDS = ['runs:read', 'runs:write', 'tasks:write', 'inbox:read', 'inbox:write', 'browser:drive', 'browser:evaluate', 'desktop:control', 'policies:write'] as const;
export type McpScope = (typeof MCP_SCOPE_IDS)[number];

/** What a tool does to the user's things: the source of the MCP hints. */
export const MCP_EFFECTS = ['read', 'write', 'destructive'] as const;
export type McpEffect = (typeof MCP_EFFECTS)[number];

/**
 * The scopes the caller holds, for a widget that shows an action only when
 * it may be used (#467: Run, Pause, answering). A credential that carries
 * scopes (an OAuth token, from E33.2 on) lists them; a personal access token
 * or a session holds every scope. Display only: every call is still checked
 * by the server.
 */
export function grantedScopes(credential: { scopes?: readonly string[] } | undefined): McpScope[] {
  const held = credential?.scopes;
  if (!held) return [...MCP_SCOPE_IDS];
  return MCP_SCOPE_IDS.filter((s) => held.includes(s));
}
