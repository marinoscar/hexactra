// Which OAuth scope each browser action kind of `POST /api/browser/sessions/:id/actions`
// needs (#460). One table, shared by the REST controller (which refuses an
// action kind whose scope an `oat_` caller lacks) and the MCP tool
// definitions (`action()` in mcp.tools.ts checks every browser tool's scope
// against it when the registry loads). Sessions and personal access tokens
// are not gated by scopes: they carry the user's whole authority.
import { InsufficientScopeException, type AuthCredentialInfo } from '@marinoscar/platform-api/identity';

import { MCP_OAUTH_RESOURCE_ID, scopeWithRequirements, type McpScope } from '../mcp/mcp.scopes';

/** The action kinds that need more than `browser:drive`; every other kind needs `browser:drive`. */
const ACTION_KIND_SCOPES: Readonly<Record<string, McpScope>> = {
  evaluate: 'browser:evaluate',
  desktop_screenshot: 'desktop:control',
  desktop_click: 'desktop:control',
  desktop_move: 'desktop:control',
  desktop_drag: 'desktop:control',
  desktop_type: 'desktop:control',
  desktop_key: 'desktop:control',
  desktop_scroll: 'desktop:control',
};

/** The scope a browser action kind needs (`browser:drive` unless the table says otherwise). */
export function browserActionScope(kind: string): McpScope {
  return ACTION_KIND_SCOPES[kind] ?? (kind.startsWith('desktop_') ? 'desktop:control' : 'browser:drive');
}

/**
 * Refuses an OAuth caller (an app's `oat_` token, reaching these routes only
 * through the MCP endpoint's in-process delegation) whose token lacks a scope
 * this browser route needs: `403 insufficient_scope` with the platform's
 * challenge. The finer line inside `runs:write` (#460): every browser route
 * needs `browser:drive`, and an action kind its own scope (`evaluate` needs
 * `browser:evaluate`, `desktop_*` need `desktop:control`). Any other
 * credential passes: it is governed by permissions alone.
 */
export function assertBrowserScopes(credential: AuthCredentialInfo | null | undefined, scope: McpScope): void {
  if (credential?.kind !== 'oauth') return;
  const missing = scopeWithRequirements(scope).filter((s) => !credential.scopes.includes(s));
  if (missing.length > 0) throw new InsufficientScopeException({ resourceId: MCP_OAUTH_RESOURCE_ID, requiredScopes: missing });
}
