// The console's adoption of the platform OAuth server (E33.1, #459): what
// `IdentityModule.forRoot({ oauthServer })` (src/platform/platform.ts) serves
// for the MCP endpoint. Imported once for its side effects by
// src/platform/registrations.ts, at module load and before bootstrap (the
// registries freeze then):
//
//   * the OAuth server's four `app.oauth.*` counters;
//   * the MCP scopes (mcp.scopes.ts; `offline_access` is the platform's); the
//     Knowledge Graph's carry an `available` check bound at startup (#916);
//   * the protected resource `/api/mcp`: an `oat_` token is admitted only under
//     that prefix, its 401 carries `WWW-Authenticate: Bearer resource_metadata=...`
//     and `/.well-known/oauth-protected-resource/api/mcp` describes it.
//
// The server ships OFF (`oauthServer.enabled`, Administration → OAuth clients).
// A scope naming a permission nobody registered is a boot error: fix the
// mapping in mcp.scopes.ts, never catch it.
import { registerPlatformHostAppMetrics } from '@marinoscar/platform-api/host';
import { OAUTH_APP_METRICS, registerOAuthProtectedResource, registerOAuthScope, type OAuthScopeAvailabilityContext } from '@marinoscar/platform-api/identity';

import { MCP_PATH } from './mcp.path';
import { scopeFeatureAvailable } from './mcp.scope-availability';
import { MCP_DOCS_URL, MCP_OAUTH_RESOURCE_ID, MCP_SCOPE_IDS, MCP_SCOPES } from './mcp.scopes';

registerPlatformHostAppMetrics(OAUTH_APP_METRICS);

for (const scope of MCP_SCOPES) {
  const feature = scope.feature;
  registerOAuthScope({
    id: scope.id,
    title: scope.title,
    description: scope.description,
    permissions: [...scope.permissions],
    risk: scope.risk,
    default: scope.default,
    // A feature-gated scope (the Knowledge Graph's) is offered only while its switch is on (#916).
    ...(feature ? { available: (ctx: OAuthScopeAvailabilityContext) => scopeFeatureAvailable(feature, ctx) } : {}),
  });
}

registerOAuthProtectedResource({
  id: MCP_OAUTH_RESOURCE_ID,
  path: MCP_PATH,
  routePrefixes: [MCP_PATH],
  scopes: [...MCP_SCOPE_IDS],
  name: 'Hexactra agent tools',
  documentation: MCP_DOCS_URL,
});
