// `/api/connections/admin/apps` (E39.2, #599): the deployment's apps at Google and Microsoft (bring your own app). The
// administrator's page. It reads and writes the app credentials ONLY: no route here, and no permission it checks, reaches a user's
// connections. The client secret is write-only.
import { Body, Controller, Delete, Get, HttpCode, Inject, Optional, Param, Post, Put, Query, Req, Res } from '@nestjs/common';
import { ApiDataResponse } from '@marinoscar/platform-api/core';
import { Auth, CurrentUser } from '@marinoscar/platform-api/identity';
import { ApiOperation, ApiResponse, ApiTags } from '@nestjs/swagger';
import type { FastifyReply, FastifyRequest } from 'fastify';

import { DIAGNOSE_RATE_LIMIT, rateLimited } from '../diagnostics/diagnostics.errors';
import { DiagnosticHistoryQueryDto, DiagnosticReportResponseDto } from '../diagnostics/diagnostics.schemas';
import { MCP_RATE_LIMITER, type McpRateLimiter } from '../mcp/mcp.rate-limit';
import { ConnectionAppDiagnostics } from './connection-app-diagnostics.service';
import { ConnectionApps } from './connection-apps.service';
import { AdminProviderResponseDto, ProviderParamDto, SaveConnectionAppDto } from './connections.schemas';

@ApiTags('Connections')
@Controller('connections/admin/apps')
export class ConnectionsAdminController {
  constructor(
    private readonly apps: ConnectionApps,
    private readonly appDiagnostics: ConnectionAppDiagnostics,
    @Optional() @Inject(MCP_RATE_LIMITER) private readonly limiter?: McpRateLimiter,
  ) {}

  @Get()
  @ApiDataResponse(AdminProviderResponseDto, { isArray: true })
  @Auth({ permissions: ['system_settings:read'] })
  @ApiOperation({ summary: 'The deployment\'s apps at Google and Microsoft', description: 'Per provider: the switch, the client id, whether a client secret is stored (never the secret), the redirect URI to register, the setup checklist and the kinds of account that work. Never a user\'s connection.' })
  list() {
    return this.apps.adminView();
  }

  @Put(':provider')
  @ApiDataResponse(AdminProviderResponseDto, { isArray: true })
  @Auth({ permissions: ['system_settings:write'] })
  @ApiOperation({ summary: 'Set a provider\'s app', description: 'The client id, the write-only client secret (omit it to keep the stored one), the Microsoft tenant and the switch. Owners can connect a provider only while it is on and fully set. Existing connections keep refreshing when it is switched off.' })
  save(@CurrentUser('id') adminId: string, @Param() p: ProviderParamDto, @Body() body: SaveConnectionAppDto) {
    return this.apps.saveApp(adminId, p.provider, body);
  }

  @Delete(':provider')
  @ApiDataResponse(AdminProviderResponseDto, { isArray: true })
  @Auth({ permissions: ['system_settings:write'] })
  @ApiOperation({ summary: 'Remove a provider\'s app', description: 'Removes the client id and secret and switches the provider off. Existing connections stay, but cannot refresh until an app is set again.' })
  remove(@CurrentUser('id') adminId: string, @Param() p: ProviderParamDto) {
    return this.apps.removeApp(adminId, p.provider);
  }

  @Post(':provider/diagnose')
  @HttpCode(200)
  @ApiDataResponse(DiagnosticReportResponseDto)
  @ApiResponse({ status: 429, description: `\`DIAGNOSTICS_RATE_LIMITED\`: at most ${DIAGNOSE_RATE_LIMIT} a minute for one provider.` })
  @Auth({ permissions: ['system_settings:write'] })
  @ApiOperation({
    summary: "Test the deployment's app at a provider",
    description:
      "Checks the app before anyone connects, with no user: `app_config` (installed, a client id and a secret set; the switch off only warns), `redirect_uri` (the address the console sends is https and on the address you reached the console on; host names only), `discovery` (the provider's sign-in endpoints answer; Microsoft: the configured tenant exists), `client_check` (a token request with a deliberately invalid code tells a refused client id or secret from a good one; `skipped` with `NEEDS_A_SIGN_IN` when the answer cannot tell) and, for Google, `picker_key`. Stores the report (target kind `provider_app`, no user; the last 20 are kept) and returns it. Read calls only; nothing is issued. The report holds the client id's last four characters at most, never the secret.",
  })
  async diagnose(@Param() p: ProviderParamDto, @Req() req: FastifyRequest, @Res({ passthrough: true }) reply: FastifyReply) {
    if (this.limiter) {
      const v = await Promise.resolve(this.limiter.hit(`diagnose:provider_app:${p.provider}`, DIAGNOSE_RATE_LIMIT, 60_000)).catch(() => ({ allowed: true, retryAfterS: 0 }));
      if (!v.allowed) throw rateLimited(v.retryAfterS);
    }
    const stop = new AbortController();
    const onClose = () => {
      if (!reply.raw.writableFinished) stop.abort();
    };
    reply.raw.once('close', onClose);
    try {
      return await this.appDiagnostics.diagnose(p.provider, 'admin', { signal: stop.signal, publicOrigin: publicOriginOf(req) });
    } finally {
      reply.raw.off('close', onClose);
    }
  }

  @Get(':provider/diagnostics')
  @ApiDataResponse(DiagnosticReportResponseDto, { isArray: true })
  @Auth({ permissions: ['system_settings:read'] })
  @ApiOperation({ summary: "The last tests of the deployment's app at a provider", description: 'Newest first: `limit` (default 5, at most 20). Codes, remedy keys, counts, host names and timings only.' })
  history(@Param() p: ProviderParamDto, @Query() q: DiagnosticHistoryQueryDto) {
    return this.appDiagnostics.historyOf(p.provider, q.limit);
  }
}

/** The address the administrator reached the console on: the browser's `Origin`, else the request's protocol and host. */
function publicOriginOf(req: FastifyRequest): string | null {
  const origin = req.headers.origin;
  if (typeof origin === 'string' && /^https?:\/\/[^\s/]+$/.test(origin)) return origin;
  const host = req.headers['x-forwarded-host'] ?? req.headers.host;
  const proto = req.headers['x-forwarded-proto'] ?? req.protocol;
  const h = Array.isArray(host) ? host[0] : host;
  const pr = Array.isArray(proto) ? proto[0] : proto;
  return typeof h === 'string' && /^[A-Za-z0-9.:\[\]-]{1,255}$/.test(h) && (pr === 'http' || pr === 'https') ? `${pr}://${h}` : null;
}
