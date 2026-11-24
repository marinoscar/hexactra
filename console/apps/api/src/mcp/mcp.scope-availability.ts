// Whether a feature-gated MCP scope is offered right now (#916): the platform's per-request
// `OAuthScopeDefinition.available` (marinoscar/EnterpriseAppBase#1215, platform 0.1.0-next.40) calls
// `scopeFeatureAvailable` for every scope whose `McpScopeDefinition.feature` is set (the Knowledge Graph's
// `procedures:*` and `site_facts:*`). Scopes register at module load, before Nest exists, so the check is a
// module-level port (no Nest, no service import: it loads with the registrations) that `McpScopeAvailabilityBinder`
// (mcp.scope-availability.binder.ts) binds to `KgraphEnabledService` once the app is up.
//
// It fails closed: before the binder runs, after the app closes, or when the check throws, the scope is
// unavailable, so the consent page never shows it, the metadata documents leave it out, `/authorize` drops
// it and a token holding it gets no permission from it while the feature is off.
import type { OAuthScopeAvailabilityContext } from '@marinoscar/platform-api/identity';

import type { McpToolFeature } from './mcp.tools';

/** Decides whether `feature` is on for the caller in `ctx` (no `userId`: only the deployment's switch is known). */
export type ScopeFeatureCheck = (feature: McpToolFeature, ctx: OAuthScopeAvailabilityContext) => Promise<boolean>;

let check: ScopeFeatureCheck | null = null;

/** Binds the check; `null` unbinds it (the scopes are then unavailable). */
export function bindScopeFeatureCheck(fn: ScopeFeatureCheck | null): void {
  check = fn;
}

/** The `available` predicate of a feature-gated scope. Never throws; anything but a clear yes is `false`. */
export async function scopeFeatureAvailable(feature: McpToolFeature, ctx: OAuthScopeAvailabilityContext): Promise<boolean> {
  const current = check;
  if (!current) return false;
  try {
    return (await current(feature, ctx)) === true;
  } catch {
    return false;
  }
}
