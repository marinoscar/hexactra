// The credential purposes of Connections (E39.2, #599). A purpose is the cipher's sub-key domain, so it is PERMANENT once a row
// exists: add one, never rename one.
//
//   connection_token         user tier. Per connection, names `<connectionId>.refresh` (the OAuth refresh token, rotated by some
//                            providers), `<connectionId>.access` (the cached short-lived access token) and `flow.<flowId>`
//                            (the PKCE verifier of a Connect in progress). Deleted with the connection.
//   connection_mcp_secret    user tier (E39.9). Per MCP connection, names `<connectionId>.secret` (the bearer token or header value the owner
//                            typed), `<connectionId>.client` (the OAuth client the server registered or the owner supplied, JSON) and
//                            `flow.<flowId>` (what an OAuth Connect in progress needs at its callback, JSON). Deleted with the connection.
//   connection_app_google    system tier, name `default`: the deployment's Google client secret (BRING YOUR OWN APP: the
//                            administrator registers the Google project; the client id is in the `connections` system settings).
//   connection_app_microsoft system tier, name `default`: the same for the Microsoft app.
import type { CredentialPurposeDef, UserCredentialPurposeDef } from '@marinoscar/platform-api/credentials';

import type { ConnectionProviderId } from './connections.constants';

export const CONNECTION_TOKEN_PURPOSE = 'connection_token';
export const CONNECTION_MCP_SECRET_PURPOSE = 'connection_mcp_secret';
export const CONNECTION_APP_GOOGLE_PURPOSE = 'connection_app_google';
export const CONNECTION_APP_MICROSOFT_PURPOSE = 'connection_app_microsoft';
export const CONNECTION_APP_SECRET_NAME = 'default';

export const connectionAppPurpose = (provider: ConnectionProviderId): string => (provider === 'google' ? CONNECTION_APP_GOOGLE_PURPOSE : CONNECTION_APP_MICROSOFT_PURPOSE);

export const refreshTokenName = (connectionId: string): string => `${connectionId}.refresh`;
export const accessTokenName = (connectionId: string): string => `${connectionId}.access`;
export const flowVerifierName = (flowId: string): string => `flow.${flowId}`;

export const mcpSecretName = (connectionId: string): string => `${connectionId}.secret`;
export const mcpClientName = (connectionId: string): string => `${connectionId}.client`;
export const mcpFlowName = (flowId: string): string => `flow.${flowId}`;

/** The deployment's app secrets (system tier). */
export const CONNECTION_SYSTEM_CREDENTIAL_PURPOSES: readonly CredentialPurposeDef[] = [
  { purpose: CONNECTION_APP_GOOGLE_PURPOSE, owner: 'connections', label: 'Google OAuth client secret for Connections', tiers: ['system'] },
  { purpose: CONNECTION_APP_MICROSOFT_PURPOSE, owner: 'connections', label: 'Microsoft OAuth client secret for Connections', tiers: ['system'] },
];

/** The user tier of the token purpose, for `registerUserCredentialPurpose`. */
export const CONNECTION_USER_CREDENTIAL_PURPOSES: readonly UserCredentialPurposeDef[] = [
  {
    purpose: CONNECTION_TOKEN_PURPOSE,
    label: 'Connection tokens',
    description: 'The tokens the provider issued when you connected an account (a refresh token and a short-lived access token) and the proof key of a connection in progress. Never shown.',
    system: null,
  },
  {
    purpose: CONNECTION_MCP_SECRET_PURPOSE,
    label: 'MCP server secrets',
    description: 'The bearer token or header value you gave an MCP server, and the OAuth client of one that signs in with OAuth. Never shown; never sent anywhere but to that server.',
    system: null,
  },
];
