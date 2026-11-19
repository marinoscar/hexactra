// `/api/connections/mcp` and `/api/connections/:id/tools` (E39.9, #606): MCP servers the owner adds as connections, and the owner's switch
// per tool. Every route is the caller's own. NOTHING HERE RETURNS A TOKEN, A HEADER VALUE OR A MESSAGE FROM A SERVER. No MCP tool of
// Hexactra's own server lists, adds or uses them (docs/parity.md).
import { Body, Controller, Get, HttpCode, Param, ParseUUIDPipe, Patch, Post, Put, Res } from '@nestjs/common';
import { ApiDataResponse } from '@marinoscar/platform-api/core';
import { Auth, CurrentUser } from '@marinoscar/platform-api/identity';
import { ApiOperation, ApiResponse, ApiTags } from '@nestjs/swagger';
import type { FastifyReply } from 'fastify';

import { ConnectionApps } from '../connection-apps.service';
import { bindingCookieName, type StartResult } from '../connection-flow.service';
import { ConnectionsService } from '../connections.service';
import { McpCatalogService } from './mcp-catalog.service';
import { McpConnectionsService, type McpAuthInput } from './mcp-connections.service';
import { AddMcpDto, AddMcpResponseDto, McpAdminResponseDto, McpAuthDto, McpAuthResponseDto, McpCatalogResponseDto, ConnectionMcpStatusResponseDto, McpToolParamDto, McpToolResponseDto, SaveMcpAdminDto, SetToolModeDto } from './mcp.schemas';

const secure = () => (process.env.APP_URL ?? '').startsWith('https://');

function bindingCookie(c: StartResult['cookie']): string {
  return `${c.name}=${c.value}; Path=/api/connections; Max-Age=${c.maxAgeSeconds}; HttpOnly; SameSite=Lax${secure() ? '; Secure' : ''}`;
}

const consentBody = (c: StartResult | null) => (c ? { authorizeUrl: c.authorizeUrl, expiresAt: c.expiresAt.toISOString() } : null);

export { bindingCookieName };

@ApiTags('Connections')
@Controller('connections')
export class McpConnectionsController {
  constructor(
    private readonly mcp: McpConnectionsService,
    private readonly catalog: McpCatalogService,
    private readonly connections: ConnectionsService,
    private readonly apps: ConnectionApps,
  ) {}

  // Declared before `:id`.
  @Get('mcp/status')
  @ApiDataResponse(ConnectionMcpStatusResponseDto)
  @Auth({ permissions: ['connections:read'] })
  @ApiOperation({ summary: 'Whether MCP servers can be added here', description: 'Whether the administrator has switched MCP servers on (off by default) and whether the hosts are restricted. Never the lists.' })
  async status() {
    const s = await this.apps.mcp();
    return { enabled: s.enabled, restricted: s.allowedHosts.length > 0 };
  }

  @Post('mcp')
  @HttpCode(200)
  @ApiDataResponse(AddMcpResponseDto)
  @ApiResponse({ status: 409, description: '`CONNECTION_PROVIDER_UNAVAILABLE` (`details.reason: disabled`: the administrator has not switched MCP servers on), `CONNECTION_MCP_EXISTS`, `CONNECTION_LABEL_TAKEN`, `CONNECTION_LIMIT` or `CONNECTION_MCP_AUTH_REQUIRED` (`details.oauth`: the server advertises OAuth).' })
  @ApiResponse({ status: 422, description: '`CONNECTION_MCP_URL_REFUSED` (`details.reason`: `scheme_not_allowed`, `private_target`, `host_not_allowed`, `host_blocked`, `query_not_allowed`, ...).' })
  @ApiResponse({ status: 502, description: '`CONNECTION_MCP_PROTOCOL`: the server does not speak the MCP protocol (Streamable HTTP, 2025-03-26 and later).' })
  @Auth({ permissions: ['connections:write'] })
  @ApiOperation({
    summary: 'Add an MCP server as a connection',
    description:
      'Streamable HTTP only: Hexactra never starts a process or runs a command for a connection. For nothing, a bearer token or a header the server is tested first (initialise, then list its tools) and nothing is stored unless it answered; the connection and its tools are returned, every tool `off`. For OAuth the answer is a `consent` to send the browser to; the connection exists once the consent returns. The address is checked against private and internal networks now and again at every call.',
  })
  async add(@CurrentUser('id') userId: string, @Body() body: AddMcpDto, @Res({ passthrough: true }) reply: FastifyReply) {
    const r = await this.mcp.add(userId, { url: body.url, label: body.label, auth: body.auth as McpAuthInput, returnTo: body.returnTo });
    if (r.consent) {
      reply.header('set-cookie', bindingCookie(r.consent.cookie));
      reply.header('cache-control', 'no-store');
      return { connection: null, catalog: null, consent: consentBody(r.consent) };
    }
    const view = await this.connections.get(userId, r.connection.id);
    const { usedBy: _usedBy, ...connection } = view;
    return { connection, catalog: r.catalog, consent: null };
  }

  @Get(':id/tools')
  @ApiDataResponse(McpCatalogResponseDto)
  @Auth({ permissions: ['connections:read'] })
  @ApiOperation({ summary: 'The tools of an MCP server', description: 'The stored snapshot (no request is made to the server): each tool\'s title, description as plain text, parameters, the server\'s hints, what they suggest, your decision (`off`, `read`, `write`) and whether it awaits your review.' })
  tools(@CurrentUser('id') userId: string, @Param('id', ParseUUIDPipe) id: string) {
    return this.catalog.list(userId, id);
  }

  @Post(':id/tools/refresh')
  @HttpCode(200)
  @ApiDataResponse(McpCatalogResponseDto)
  @ApiResponse({ status: 409, description: '`CONNECTION_PAUSED`, `CONNECTION_NEEDS_RECONNECT`, `CONNECTION_MCP_AUTH_REQUIRED` or `CONNECTION_PROVIDER_UNAVAILABLE` (disabled).' })
  @Auth({ permissions: ['connections:write'] })
  @ApiOperation({ summary: 'Refresh the tools of an MCP server', description: 'Lists the server\'s tools again. A tool you enabled whose description, schema or hints changed is switched OFF and flagged `changed`; a tool that is new arrives `off` and flagged `new`; a tool the server stopped offering disappears. You are notified once. Only your own decision switches a tool on.' })
  refresh(@CurrentUser('id') userId: string, @Param('id', ParseUUIDPipe) id: string) {
    return this.catalog.refresh(userId, id);
  }

  @Patch(':id/tools/:toolId')
  @ApiDataResponse(McpToolResponseDto)
  @Auth({ permissions: ['connections:write'] })
  @ApiOperation({ summary: 'Decide what a tool may do', description: '`off` (default), `read` (called without asking; choose it only for a tool that only reads) or `write` (it changes something: it asks you each time unless you chose "Don\'t ask again"). The server\'s hints only suggest a default; you decide. Deciding clears the review flag.' })
  setMode(@CurrentUser('id') userId: string, @Param() p: McpToolParamDto, @Body() body: SetToolModeDto) {
    return this.catalog.setMode(userId, p.id, p.toolId, body.mode);
  }

  @Post(':id/mcp-auth')
  @HttpCode(200)
  @ApiDataResponse(McpAuthResponseDto)
  @Auth({ permissions: ['connections:write'] })
  @ApiOperation({ summary: 'Give an MCP server a new sign-in', description: 'A new bearer token or header value (tested before it is kept), or a new OAuth consent (`consent.authorizeUrl`). This is how a connection that needs reconnecting comes back. The secret is write-only.' })
  async reauth(@CurrentUser('id') userId: string, @Param('id', ParseUUIDPipe) id: string, @Body() body: McpAuthDto, @Res({ passthrough: true }) reply: FastifyReply) {
    const r = await this.mcp.reconnect(userId, id, body.auth as McpAuthInput, body.returnTo);
    if (r.consent) {
      reply.header('set-cookie', bindingCookie(r.consent.cookie));
      reply.header('cache-control', 'no-store');
    }
    const { usedBy: _usedBy, ...connection } = await this.connections.get(userId, r.connection.id);
    return { connection, consent: consentBody(r.consent) };
  }
}

@ApiTags('Connections')
@Controller('connections/admin/mcp')
export class McpAdminController {
  constructor(private readonly apps: ConnectionApps) {}

  @Get()
  @ApiDataResponse(McpAdminResponseDto)
  @Auth({ permissions: ['system_settings:read'] })
  @ApiOperation({ summary: 'The deployment\'s MCP switch and host lists', description: 'Whether owners may add and use MCP servers (off by default), and the allow-list and block-list of hosts. No access to any owner\'s connection or tool.' })
  get() {
    return this.apps.mcpAdminView();
  }

  @Put()
  @ApiDataResponse(McpAdminResponseDto)
  @Auth({ permissions: ['system_settings:write'] })
  @ApiOperation({ summary: 'Set the MCP switch and host lists', description: 'Switching it off stops every MCP connection from being used within seconds (no call is made); the connections and tool choices are kept. Entries are host names or `*.example.test`. An empty allow-list admits any public host; the block-list wins.' })
  save(@CurrentUser('id') adminId: string, @Body() body: SaveMcpAdminDto) {
    return this.apps.saveMcp(adminId, body);
  }
}

