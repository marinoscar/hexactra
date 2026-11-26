// Diagnostics of the owner's connections (E50.10, #980). Every route is the caller's own: another user's connection is a 404 like a
// missing one, and an administrator does not see a user's report. NOTHING HERE RETURNS CONTENT, A PROVIDER MESSAGE, AN ADDRESS OR A
// TOKEN: codes, remedy keys, counts and timings. Not exposed through Hexactra's MCP server (packages/shared/capabilities.json).
import { Controller, Get, HttpCode, Inject, Optional, Param, ParseUUIDPipe, Post, Query, Res } from '@nestjs/common';
import { ApiDataResponse } from '@marinoscar/platform-api/core';
import { Auth, CurrentUser } from '@marinoscar/platform-api/identity';
import { ApiOperation, ApiResponse, ApiTags } from '@nestjs/swagger';
import type { FastifyReply } from 'fastify';

import { DIAGNOSE_RATE_LIMIT, rateLimited } from '../diagnostics/diagnostics.errors';
import { DiagnosticHistoryQueryDto, DiagnosticReportResponseDto, DiagnosticSummaryResponseDto } from '../diagnostics/diagnostics.schemas';
import { MCP_RATE_LIMITER, type McpRateLimiter } from '../mcp/mcp.rate-limit';
import { ConnectionDiagnosticsService } from './connection-diagnostics.service';

@ApiTags('Connections')
@Controller('connections')
export class ConnectionDiagnosticsController {
  constructor(
    private readonly diagnostics: ConnectionDiagnosticsService,
    @Optional() @Inject(MCP_RATE_LIMITER) private readonly limiter?: McpRateLimiter,
  ) {}

  // Static path: declared before the `:id` routes of this controller.
  @Get('diagnostics/summary')
  @ApiDataResponse(DiagnosticSummaryResponseDto, { isArray: true })
  @Auth({ permissions: ['connections:read'] })
  @ApiOperation({
    summary: 'The last diagnostic result of each of your connections',
    description: 'For each of your connections that has a report: its last overall status (`pass`, `warn`, `fail`, `skipped`) and when it finished ("last checked"). One query, for the chips of the Connections page.',
  })
  summary(@CurrentUser('id') userId: string) {
    return this.diagnostics.summary(userId);
  }

  @Post(':id/diagnose')
  @HttpCode(200)
  @ApiDataResponse(DiagnosticReportResponseDto)
  @ApiResponse({ status: 429, description: `\`DIAGNOSTICS_RATE_LIMITED\`: at most ${DIAGNOSE_RATE_LIMIT} a minute for one connection.` })
  @Auth({ permissions: ['connections:write'] })
  @ApiOperation({
    summary: 'Diagnose a connection',
    description:
      "Runs an ordered list of checks and stores the report (the last 20 are kept): `status` (paused warns; needs a reconnect fails, with its reason as the remedy), `provider_installed` (installed here and switched on by the administrator), the provider's own checks (until a provider has its own: `sign_in` and one `capability:<name>` read per capability that is on, or `server` for an MCP server, with its tool count), and `latency` (a warning over 5 s). After the first failure the dependent checks are `skipped`. Each check has a closed `code` and a `remedy` key whose words are in the remedy table the web app and the CLI share. Read calls only: nothing is sent, created or deleted at the provider. At most 20 s; closing the request stops it.",
  })
  async diagnose(@CurrentUser('id') userId: string, @Param('id', ParseUUIDPipe) id: string, @Res({ passthrough: true }) reply: FastifyReply) {
    if (this.limiter) {
      const v = await Promise.resolve(this.limiter.hit(`diagnose:connection:${userId}:${id}`, DIAGNOSE_RATE_LIMIT, 60_000)).catch(() => ({ allowed: true, retryAfterS: 0 }));
      if (!v.allowed) throw rateLimited(v.retryAfterS);
    }
    // Stop is the request's abort: a client that goes away ends the remaining checks.
    const stop = new AbortController();
    const onClose = () => {
      if (!reply.raw.writableFinished) stop.abort();
    };
    reply.raw.once('close', onClose);
    try {
      return await this.diagnostics.diagnose(userId, id, 'owner', { signal: stop.signal });
    } finally {
      reply.raw.off('close', onClose);
    }
  }

  @Get(':id/diagnostics')
  @ApiDataResponse(DiagnosticReportResponseDto, { isArray: true })
  @Auth({ permissions: ['connections:read'] })
  @ApiOperation({ summary: "A connection's last diagnostic reports", description: 'Newest first: `limit` (default 5, at most 20). Codes, remedy keys, counts and timings only.' })
  history(@CurrentUser('id') userId: string, @Param('id', ParseUUIDPipe) id: string, @Query() q: DiagnosticHistoryQueryDto) {
    return this.diagnostics.historyOf(userId, id, q.limit);
  }
}
