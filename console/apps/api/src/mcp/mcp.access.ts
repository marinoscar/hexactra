// The scope gate of the MCP tools (E33.2, #460). Only an app signed in with
// OAuth (`credential.kind === 'oauth'`, an `oat_` token) is gated: sessions,
// personal access tokens and device tokens keep every tool (epic #458,
// decision 5). For an OAuth caller each tool is:
//
//   allowed      the token holds the tool's scope and every scope it requires;
//   needs_scope  a scope is missing, and the USER holds the permissions it maps
//                to: re-consent (step-up) can fix it, so the call is refused
//                with `403 insufficient_scope` and the tool is listed as
//                "needs extra permission";
//   forbidden    the user lacks a permission behind the scopes: no consent can
//                help, so the tool is never listed and a call is a tool error.
//
// The user's own permissions are the request graph's WITHOUT the token's
// narrowing (`userPermissionsOf`). Pure: no I/O, and an unknown scope string
// in a token is ignored, never thrown on.
import { currentTenancyMode, resolveEffectiveAccess } from '@marinoscar/platform-api/identity';

import { mcpScope, scopeWithRequirements, MCP_SCOPE_IDS, type McpScope } from './mcp.scopes';

export type ToolAccess = 'allowed' | 'needs_scope' | 'forbidden';

/** What the gate reads of a credential (the guard's record, or `McpContext.credential`). */
export interface GateCredential {
  kind: string;
  scopes?: readonly string[];
}

/** What the gate reads of the user: the permissions their roles give, before any OAuth narrowing. Absent: unknown. */
export interface GatePrincipal {
  permissions: Iterable<string>;
}

/** The scopes a tool needs: its own, then the ones it requires (`browser:evaluate` and `desktop:control` need `browser:drive`). */
export function toolScopes(tool: { scope: McpScope }): McpScope[] {
  return scopeWithRequirements(tool.scope);
}

/** Whether the credential is gated by scopes: an OAuth access token only. */
export function isScopeGated(credential: GateCredential | null | undefined): boolean {
  return credential?.kind === 'oauth';
}

/** The tool's scopes the token lacks (empty for a credential that is not gated). */
export function missingScopes(tool: { scope: McpScope }, credential: GateCredential | null | undefined): McpScope[] {
  if (!isScopeGated(credential)) return [];
  const held = new Set(credential?.scopes ?? []);
  return toolScopes(tool).filter((s) => !held.has(s));
}

/** The console permissions behind a set of scopes. */
function permissionsOf(scopes: readonly McpScope[]): string[] {
  return [...new Set(scopes.flatMap((s) => mcpScope(s)?.permissions ?? []))];
}

/**
 * Whether `credential` may use `tool` (#460, "Who is gated"). Without
 * `principal` (the user's permissions are unknown) a missing scope is
 * `needs_scope`: the REST route behind the tool still refuses what the user
 * cannot do.
 */
export function toolAccess(tool: { scope: McpScope }, credential: GateCredential | null | undefined, principal?: GatePrincipal): ToolAccess {
  if (!isScopeGated(credential)) return 'allowed';
  if (principal) {
    const own = new Set(principal.permissions);
    // A permission the user's roles do not give: neither consent nor step-up can help.
    if (permissionsOf(toolScopes(tool)).some((p) => !own.has(p))) return 'forbidden';
  }
  return missingScopes(tool, credential).length > 0 ? 'needs_scope' : 'allowed';
}

/** Whether an OAuth caller may use the tools of `scope` (for the instructions); always true for other credentials. */
export function scopeUsable(scope: McpScope, credential: GateCredential | null | undefined, principal?: GatePrincipal): boolean {
  return toolAccess({ scope }, credential, principal) === 'allowed';
}

/**
 * The `scope` of a step-up challenge: every scope the token holds (clients do
 * not reliably carry earlier scopes into a step-up), then the missing ones,
 * without repeats. Scopes the console does not know are dropped from the
 * token's list, except `offline_access` (the platform's refresh scope).
 */
export function challengeScopes(credential: GateCredential | null | undefined, missing: readonly string[]): string[] {
  const known = new Set<string>([...MCP_SCOPE_IDS, 'offline_access']);
  const granted = (credential?.scopes ?? []).filter((s) => known.has(s));
  return [...new Set([...granted, ...missing])];
}

/**
 * The permissions the request's USER holds, without an `oat_` token's
 * narrowing: what re-consent could add. The platform computes the same set in
 * its own step-up (`permissionsWithoutOAuthNarrowing`, not exported from
 * `@marinoscar/platform-api/identity`); this reads the request's user graph
 * through the exported `resolveEffectiveAccess` with the narrowing shadowed on
 * a prototype-linked view, exactly as the platform does. `undefined` when the
 * request carries no user graph.
 */
export function userPermissionsOf(user: unknown): string[] | undefined {
  if (!user || typeof user !== 'object' || !Array.isArray((user as { userRoles?: unknown }).userRoles)) return undefined;
  try {
    const wide = Object.create(user as object, { oauthNarrowing: { value: undefined } }) as Parameters<typeof resolveEffectiveAccess>[0];
    return resolveEffectiveAccess(wide, currentTenancyMode()).permissions;
  } catch {
    return undefined;
  }
}
