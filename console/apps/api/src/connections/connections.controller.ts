// `/api/connections` (E39.2, #599): the owner's connected accounts. Every route is the caller's own; another user's id is a 404
// like a missing one. NOTHING HERE RETURNS A TOKEN, A SCOPE STRING OR A PROVIDER MESSAGE. No MCP tool lists, adds or uses a
// connection (docs/parity.md): hosted AI apps reach them only through runs, under E39.7's rules.
import { Body, Controller, Delete, Get, HttpCode, Param, ParseUUIDPipe, Patch, Post, Query, Req, Res } from '@nestjs/common';
import { ApiDataResponse } from '@marinoscar/platform-api/core';
import { Auth, CurrentUser, Public } from '@marinoscar/platform-api/identity';
import { ApiOperation, ApiResponse, ApiTags } from '@nestjs/swagger';
import type { FastifyReply, FastifyRequest } from 'fastify';

import { ConnectionError } from './connections.errors';
import {
  AuthorizeConnectionDto,
  AuthorizeResponseDto,
  CallbackParamDto,
  CallbackQueryDto,
  ConnectionDetailResponseDto,
  ConnectionResponseDto,
  ProviderAvailabilityResponseDto,
  RemoveConnectionResponseDto,
  TestConnectionResponseDto,
  UpdateConnectionDto,
  UpdateConnectionResponseDto,
} from './connections.schemas';
import { ConnectionFlowService, bindingCookieName, type StartResult } from './connection-flow.service';
import { ConnectionsService } from './connections.service';
import { isProviderId } from './connections.constants';
import { McpOAuthService } from './mcp/mcp-oauth.service';

const secure = () => (process.env.APP_URL ?? '').startsWith('https://');
const COOKIE_PATH = '/api/connections';

function bindingCookie(name: string, value: string, maxAgeS: number): string {
  return `${name}=${value}; Path=${COOKIE_PATH}; Max-Age=${maxAgeS}; HttpOnly; SameSite=Lax${secure() ? '; Secure' : ''}`;
}

/** The consent as the body shows it: the cookie goes on the response header, never in the body. */
const consentBody = (c: StartResult | null) => (c ? { authorizeUrl: c.authorizeUrl, expiresAt: c.expiresAt.toISOString() } : null);

@ApiTags('Connections')
@Controller('connections')
export class ConnectionsController {
  constructor(
    private readonly connections: ConnectionsService,
    private readonly flows: ConnectionFlowService,
    private readonly mcpOAuth: McpOAuthService,
  ) {}

  @Get()
  @ApiDataResponse(ConnectionResponseDto, { isArray: true })
  @Auth({ permissions: ['connections:read'] })
  @ApiOperation({
    summary: 'List your connected accounts',
    description: 'Label, provider, account email, the capabilities that are on (`mail_read`, `mail_send`, `mail_modify`, `calendar_read`, `calendar_write`, `docs_read`, `docs_write`), what the provider granted, the defaults, the status and the last use. Accounts that need a reconnect come first. Never a token or a scope string.',
  })
  list(@CurrentUser('id') userId: string) {
    return this.connections.list(userId);
  }

  // Declared before `:id`.
  @Get('providers')
  @ApiDataResponse(ProviderAvailabilityResponseDto, { isArray: true })
  @Auth({ permissions: ['connections:read'] })
  @ApiOperation({
    summary: 'Which providers can be connected here',
    description: 'For each provider: whether this deployment has it installed, switched on and configured by the administrator (`ready`, else `reason`), and which kinds of account work, with a note to read before starting. Never the app credentials.',
  })
  providers() {
    return this.connections.providers();
  }

  @Post('authorize')
  @HttpCode(200)
  @ApiDataResponse(AuthorizeResponseDto)
  @ApiResponse({ status: 409, description: '`CONNECTION_PROVIDER_UNAVAILABLE` (`details.reason`: `not_installed`, `disabled`, `not_configured`) or `CONNECTION_LABEL_TAKEN`.' })
  @Auth({ permissions: ['connections:write'] })
  @ApiOperation({
    summary: 'Start connecting an account (OAuth 2.1 authorization code with PKCE)',
    description:
      "Returns `authorizeUrl`: send the browser there (the provider's own consent screen). The PKCE verifier and `state` are kept on the server and the flow is bound to this browser by an HttpOnly cookie set on this response, so the callback must arrive in the same browser within 10 minutes and only once. Connecting the same account again updates its connection (no duplicate); a different account of the same provider is a second connection. Only the permissions the capabilities need are asked for. `loginHint` pre-selects the account (use it to reconnect one).",
  })
  async authorize(@CurrentUser('id') userId: string, @Body() body: AuthorizeConnectionDto, @Res({ passthrough: true }) reply: FastifyReply) {
    if (!isProviderId(body.provider)) throw new ConnectionError('CONNECTION_PROVIDER_UNAVAILABLE', 'This provider is not available.', { reason: 'not_installed' });
    const r = await this.flows.start(userId, { provider: body.provider, capabilities: body.capabilities, label: body.label, loginHint: body.loginHint, returnTo: body.returnTo });
    reply.header('set-cookie', bindingCookie(r.cookie.name, r.cookie.value, r.cookie.maxAgeSeconds));
    reply.header('cache-control', 'no-store');
    return consentBody(r);
  }

  /**
   * Public on purpose: the browser arrives here from the provider without our bearer token. What authenticates the request is the
   * single-use `state` (kept as a hash on the flow) AND the HttpOnly binding cookie set by `authorize`. It never answers with data:
   * a 302 to the return page with `?connect=connected` (and `connection`, `missing`) or `?connect=<reason>`.
   */
  @Get('callback/:provider')
  @Public()
  @ApiResponse({ status: 302, description: 'Back to the page that started the connection (`/settings/connections` by default) with `connect=connected` (plus `connection=<id>` and `missing=<capabilities the provider did not grant>`), or `connect=<reason>` (`denied`, `admin_consent_required`, `expired`, `state_invalid`, `binding_invalid`, `exchange_failed`, `account_mismatch`, `nothing_granted`, ...).' })
  @ApiOperation({ summary: 'The provider redirects the browser here after the consent', description: 'The redirect URI to register at the provider: `/api/connections/callback/google`, `/api/connections/callback/microsoft` or (an MCP server that uses OAuth) `/api/connections/callback/mcp` under this console\'s address. Not called by API clients.' })
  async callback(@Param() p: CallbackParamDto, @Query() q: CallbackQueryDto, @Req() req: FastifyRequest, @Res() reply: FastifyReply): Promise<void> {
    const cookies = (req as FastifyRequest & { cookies?: Record<string, string | undefined> }).cookies;
    // An MCP server's own OAuth (E39.9) comes back here too: `/api/connections/callback/mcp`.
    const r =
      p.provider === 'mcp'
        ? await this.mcpOAuth.handleCallback({ code: q.code, state: q.state, error: q.error, iss: q.iss }, (name) => cookies?.[name])
        : await this.flows.handleCallback(p.provider, { code: q.code, state: q.state, error: q.error, errorDescription: q.error_description }, (name) => cookies?.[name]);
    const sep = r.returnTo.includes('?') ? '&' : '?';
    const extra = `${r.connectionId ? `&connection=${r.connectionId}` : ''}${r.missing && r.missing.length > 0 ? `&missing=${r.missing.join(',')}` : ''}`;
    void reply
      .status(302)
      .header('location', `${r.returnTo}${sep}connect=${r.outcome}${extra}`)
      .header('set-cookie', q.state ? bindingCookieClear(q.state) : '')
      .header('cache-control', 'no-store')
      .header('referrer-policy', 'no-referrer')
      .send();
  }

  @Get(':id')
  @ApiDataResponse(ConnectionDetailResponseDto)
  @Auth({ permissions: ['connections:read'] })
  @ApiOperation({ summary: 'Get one connection', description: 'With `usedBy`: the tasks and deliveries that use it, which removing it clears.' })
  get(@CurrentUser('id') userId: string, @Param('id', ParseUUIDPipe) id: string) {
    return this.connections.get(userId, id);
  }

  @Patch(':id')
  @ApiDataResponse(UpdateConnectionResponseDto)
  @ApiResponse({ status: 409, description: '`CONNECTION_LABEL_TAKEN`, or `CONNECTION_NEEDS_RECONNECT` for a revoked connection.' })
  @ApiResponse({ status: 422, description: '`CONNECTION_DEFAULT_NEEDS_CAPABILITY`: a default needs a capability of its group switched on.' })
  @Auth({ permissions: ['connections:write'] })
  @ApiOperation({
    summary: 'Rename a connection, change what it can do, or make it the default',
    description:
      'Turning a capability off is immediate and local: the permission stays granted at the provider until you disconnect the account. Adding a capability the provider has not granted starts an incremental consent for just the extra permissions (`consent.authorizeUrl`, with the account as login hint, bound to this browser by a cookie set on this response); the switch comes on when the consent returns. `defaultFor` takes the default of those groups from the account that had it.',
  })
  async update(@CurrentUser('id') userId: string, @Param('id', ParseUUIDPipe) id: string, @Body() body: UpdateConnectionDto, @Res({ passthrough: true }) reply: FastifyReply) {
    const r = await this.connections.update(userId, id, body);
    if (r.consent) {
      reply.header('set-cookie', bindingCookie(r.consent.cookie.name, r.consent.cookie.value, r.consent.cookie.maxAgeSeconds));
      reply.header('cache-control', 'no-store');
    }
    return { connection: r.connection, consent: consentBody(r.consent) };
  }

  @Post(':id/pause')
  @HttpCode(200)
  @ApiDataResponse(ConnectionResponseDto)
  @Auth({ permissions: ['connections:write'] })
  @ApiOperation({ summary: 'Pause a connection', description: 'A paused connection is not used by anything (no task, chat or delivery); its sign-in is kept alive. Resume it to use it again.' })
  pause(@CurrentUser('id') userId: string, @Param('id', ParseUUIDPipe) id: string) {
    return this.connections.pause(userId, id);
  }

  @Post(':id/resume')
  @HttpCode(200)
  @ApiDataResponse(ConnectionResponseDto)
  @Auth({ permissions: ['connections:write'] })
  @ApiOperation({ summary: 'Resume a paused connection' })
  resume(@CurrentUser('id') userId: string, @Param('id', ParseUUIDPipe) id: string) {
    return this.connections.resume(userId, id);
  }

  @Post(':id/test')
  @HttpCode(200)
  @ApiDataResponse(TestConnectionResponseDto)
  @ApiResponse({ status: 409, description: '`CONNECTION_PAUSED` or `CONNECTION_NEEDS_RECONNECT`: the account cannot be used at all.' })
  @ApiResponse({ status: 503, description: '`CONNECTION_UNAVAILABLE`: the provider could not be reached.' })
  @Auth({ permissions: ['connections:write'] })
  @ApiOperation({ summary: 'Test a connection', description: 'One cheap read call per capability that is on; each answers `ok` or a closed reason `code`. Reads nothing of the owner\'s mail, calendar or files beyond what the call needs, and returns none of it.' })
  test(@CurrentUser('id') userId: string, @Param('id', ParseUUIDPipe) id: string) {
    return this.connections.test(userId, id);
  }

  @Delete(':id')
  @HttpCode(200)
  @ApiDataResponse(RemoveConnectionResponseDto)
  @Auth({ permissions: ['connections:write'] })
  @ApiOperation({ summary: 'Disconnect an account', description: 'Revokes the grant at the provider (best effort: `revoked: false` when it could not be asked), clears the references from tasks and deliveries (they show "connection removed"), deletes the tokens and the connection.' })
  remove(@CurrentUser('id') userId: string, @Param('id', ParseUUIDPipe) id: string) {
    return this.connections.remove(userId, id);
  }
}

const bindingCookieClear = (state: string): string => bindingCookie(bindingCookieName(state), '', 0);
