import { HttpException, HttpStatus } from '@nestjs/common';
import { registerErrorCode } from '@marinoscar/platform-api/core';

// The connection error codes (E39.2, #599), registered once at module load. The platform's filter passes a `code`
// through only when it is registered for the response status. None carries a token, an address or a message from a provider.
registerErrorCode({ code: 'CONNECTION_NOT_FOUND', status: 404, description: "The connection does not exist or is not the caller's." });
registerErrorCode({ code: 'CONNECTION_LABEL_TAKEN', status: 409, description: 'The caller already has a connection with this label (ignoring case).' });
registerErrorCode({ code: 'CONNECTION_LIMIT', status: 409, description: 'The caller already has the most connections allowed: remove one first.' });
registerErrorCode({ code: 'CONNECTION_PROVIDER_UNAVAILABLE', status: 409, description: 'The provider cannot be connected on this deployment. `details.reason`: `not_installed`, `disabled` or `not_configured`.' });
registerErrorCode({ code: 'CONNECTION_NEEDS_RECONNECT', status: 409, description: 'The provider refused the saved grant (revoked, expired, a password change): connect the account again. `details.label` names it.' });
registerErrorCode({ code: 'CONNECTION_PAUSED', status: 409, description: 'The connection is paused: nothing uses it until it is resumed. `details.label` names it.' });
registerErrorCode({ code: 'CONNECTION_CAPABILITY_OFF', status: 409, description: 'The capability is not switched on for this connection. `details.label` and `details.capability` name them.' });
registerErrorCode({ code: 'CONNECTION_AMBIGUOUS', status: 409, description: 'More than one connection could do this and none was named or is the default: ask the owner. `details.candidates` lists their labels.' });
registerErrorCode({ code: 'CONNECTION_NONE', status: 409, description: 'No active connection has this capability. `details.unavailable` lists those that do but cannot be used (paused or needing a reconnect).' });
registerErrorCode({ code: 'CONNECTION_UNAVAILABLE', status: 503, description: 'The provider could not be reached or answered with an error. Nothing was changed; try again.' });
registerErrorCode({ code: 'CONNECTION_FILE_NOT_FOUND', status: 404, description: "The file or folder does not exist, or this account cannot see it (with Google's narrow `drive.file` permission only files the app created or the owner picked are visible)." });
registerErrorCode({ code: 'CONNECTION_PERMISSION_MISSING', status: 409, description: 'The provider did not grant the permission this needs: add it with the incremental consent (`PATCH /api/connections/{id}`), or pick the file in the picker.' });
registerErrorCode({ code: 'CONNECTION_PICKER_UNAVAILABLE', status: 409, description: "The file picker cannot be opened for this connection. `details.reason`: `not_google`, `no_documents` (the Documents switch is off) or `not_configured` (the administrator's Google app has no project)." });
registerErrorCode({ code: 'CONNECTION_DEFAULT_NEEDS_CAPABILITY', status: 422, description: 'A connection can be the default for a group only while one of its capabilities is switched on.' });
registerErrorCode({ code: 'CONNECTION_MCP_URL_REFUSED', status: 422, description: 'The MCP server address is not allowed. `details.reason` (closed): `invalid_url`, `scheme_not_allowed`, `userinfo_not_allowed`, `query_not_allowed`, `port_not_allowed`, `private_target`, `unresolvable`, `host_not_allowed`, `host_blocked`.' });
registerErrorCode({ code: 'CONNECTION_MCP_EXISTS', status: 409, description: 'The caller already has a connection to this MCP server address.' });
registerErrorCode({ code: 'CONNECTION_MCP_AUTH_REQUIRED', status: 409, description: 'The MCP server wants a sign-in the request did not give (or no longer accepts it). `details.oauth` is true when the server advertises OAuth.' });
registerErrorCode({ code: 'CONNECTION_MCP_PROTOCOL', status: 502, description: 'The server did not answer in the MCP protocol this console speaks (Streamable HTTP, revisions 2025-03-26 and later).' });

export type ConnectionErrorCode =
  | 'CONNECTION_NOT_FOUND'
  | 'CONNECTION_LABEL_TAKEN'
  | 'CONNECTION_LIMIT'
  | 'CONNECTION_PROVIDER_UNAVAILABLE'
  | 'CONNECTION_NEEDS_RECONNECT'
  | 'CONNECTION_PAUSED'
  | 'CONNECTION_CAPABILITY_OFF'
  | 'CONNECTION_AMBIGUOUS'
  | 'CONNECTION_NONE'
  | 'CONNECTION_UNAVAILABLE'
  | 'CONNECTION_FILE_NOT_FOUND'
  | 'CONNECTION_PERMISSION_MISSING'
  | 'CONNECTION_PICKER_UNAVAILABLE'
  | 'CONNECTION_DEFAULT_NEEDS_CAPABILITY'
  | 'CONNECTION_MCP_URL_REFUSED'
  | 'CONNECTION_MCP_EXISTS'
  | 'CONNECTION_MCP_AUTH_REQUIRED'
  | 'CONNECTION_MCP_PROTOCOL';

const STATUS: Record<ConnectionErrorCode, HttpStatus> = {
  CONNECTION_NOT_FOUND: HttpStatus.NOT_FOUND,
  CONNECTION_LABEL_TAKEN: HttpStatus.CONFLICT,
  CONNECTION_LIMIT: HttpStatus.CONFLICT,
  CONNECTION_PROVIDER_UNAVAILABLE: HttpStatus.CONFLICT,
  CONNECTION_NEEDS_RECONNECT: HttpStatus.CONFLICT,
  CONNECTION_PAUSED: HttpStatus.CONFLICT,
  CONNECTION_CAPABILITY_OFF: HttpStatus.CONFLICT,
  CONNECTION_AMBIGUOUS: HttpStatus.CONFLICT,
  CONNECTION_NONE: HttpStatus.CONFLICT,
  CONNECTION_UNAVAILABLE: HttpStatus.SERVICE_UNAVAILABLE,
  CONNECTION_FILE_NOT_FOUND: HttpStatus.NOT_FOUND,
  CONNECTION_PERMISSION_MISSING: HttpStatus.CONFLICT,
  CONNECTION_PICKER_UNAVAILABLE: HttpStatus.CONFLICT,
  CONNECTION_DEFAULT_NEEDS_CAPABILITY: HttpStatus.UNPROCESSABLE_ENTITY,
  CONNECTION_MCP_URL_REFUSED: HttpStatus.UNPROCESSABLE_ENTITY,
  CONNECTION_MCP_EXISTS: HttpStatus.CONFLICT,
  CONNECTION_MCP_AUTH_REQUIRED: HttpStatus.CONFLICT,
  CONNECTION_MCP_PROTOCOL: HttpStatus.BAD_GATEWAY,
};

/**
 * The typed failure of everything in this module, for HTTP callers (the filter renders `code` and `details`) and for in-process
 * callers (the runner, deliveries: they read `.code` and turn it into a question to the owner or a failed delivery).
 * `details` carries labels and capability names only: never a token, an email address or a provider message.
 */
export class ConnectionError extends HttpException {
  constructor(
    readonly code: ConnectionErrorCode,
    message: string,
    readonly details?: Record<string, unknown>,
  ) {
    super({ code, message, ...(details ? { details } : {}) }, STATUS[code]);
    this.name = 'ConnectionError';
  }
}

export const notFound = (): ConnectionError => new ConnectionError('CONNECTION_NOT_FOUND', 'Connection not found');
