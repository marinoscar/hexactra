// Diagnostics of web search (E50.13, #983): the caller's report (their effective tier) and the deployment's (the deployment's key
// only), stored with target kind `search_provider`. NOTHING HERE RETURNS A KEY, A QUERY, A RESULT OR A PROVIDER MESSAGE: codes, remedy
// keys, counts, timings and host names. The organization is the caller's active one, never request input.
import { Controller, Get, HttpCode, Inject, Optional, Param, Post, Query, Res } from '@nestjs/common';
import { ApiDataResponse } from '@marinoscar/platform-api/core';
import { Auth, CurrentOrg, CurrentUser } from '@marinoscar/platform-api/identity';
import { ApiOperation, ApiResponse, ApiTags } from '@nestjs/swagger';
import type { FastifyReply } from 'fastify';

import { DIAGNOSE_RATE_LIMIT, rateLimited } from '../diagnostics/diagnostics.errors';
import { DiagnosticHistoryQueryDto, DiagnosticReportResponseDto } from '../diagnostics/diagnostics.schemas';
import { MCP_RATE_LIMITER, type McpRateLimiter } from '../mcp/mcp.rate-limit';
import { SEARCH_PROVIDER_ID_PATTERN, SearchProviderRegistry, type SearchProvider } from './search-provider';
import { WebSearchDiagnostics } from './web-search-diagnostics.service';
import { providerUnknown } from './web-search.errors';
import { SearchDiagnoseQueryDto } from './web-search.schemas';

const STAGES =
  '`switches` (the deployment\'s and your switch, the provider\'s, its place in the order), `credential` (which tier answers and where it is kept; an address; an AI key and model), `network` (its host resolves and connects), `live_query` (ONE real search of a fixed common word, `count: 1`: it counts as one call in the usage table and costs what a search costs), `limits` (today\'s count against the per-day limit) and `fetch` (`web_fetch` is on and reads a fixed public page). After a failure the dependent stages are `skipped`. Each stage has a closed `code` and a `remedy` key of the shared remedy table. Nothing you typed is sent. At most 20 s; closing the request stops it.';

@ApiTags('Web search')
@Controller('web-search')
export class WebSearchDiagnosticsController {
  constructor(
    private readonly diagnostics: WebSearchDiagnostics,
    private readonly registry: SearchProviderRegistry,
    @Optional() @Inject(MCP_RATE_LIMITER) private readonly limiter?: McpRateLimiter,
  ) {}

  private provider(id: string | null | undefined): SearchProvider {
    const p = id && SEARCH_PROVIDER_ID_PATTERN.test(id) ? this.registry.get(id) : null;
    if (!p) throw providerUnknown();
    return p;
  }

  private async limit(key: string): Promise<void> {
    if (!this.limiter) return;
    const v = await Promise.resolve(this.limiter.hit(key, DIAGNOSE_RATE_LIMIT, 60_000)).catch(() => ({ allowed: true, retryAfterS: 0 }));
    if (!v.allowed) throw rateLimited(v.retryAfterS);
  }

  /** Stop is the request's abort: a client that goes away ends the remaining stages. */
  private async withStop<T>(reply: FastifyReply, fn: (signal: AbortSignal) => Promise<T>): Promise<T> {
    const stop = new AbortController();
    const onClose = () => {
      if (!reply.raw.writableFinished) stop.abort();
    };
    reply.raw.once('close', onClose);
    try {
      return await fn(stop.signal);
    } finally {
      reply.raw.off('close', onClose);
    }
  }

  @Post('diagnose')
  @HttpCode(200)
  @ApiDataResponse(DiagnosticReportResponseDto)
  @ApiResponse({ status: 429, description: `\`DIAGNOSTICS_RATE_LIMITED\`: at most ${DIAGNOSE_RATE_LIMIT} a minute for one provider.` })
  @ApiResponse({ status: 404, description: '`WEB_SEARCH_PROVIDER_UNKNOWN`: no such provider is installed.' })
  @Auth({ permissions: ['web_search:write'] })
  @ApiOperation({ summary: 'Diagnose web search for you', description: `The report of the provider that answers for you (or \`?provider=<id>\`), with your effective key tier, stored with you as its owner (the last 20 are kept). Stages: ${STAGES}` })
  async diagnose(@CurrentUser('id') userId: string, @CurrentOrg() orgId: string | undefined, @Query() q: SearchDiagnoseQueryDto, @Res({ passthrough: true }) reply: FastifyReply) {
    const who = { userId, orgId: orgId ?? null };
    const provider = this.provider(q.provider ?? (await this.diagnostics.effectiveProvider(who)));
    await this.limit(`diagnose:search:${userId}:${provider.id}`);
    return this.withStop(reply, (signal) => this.diagnostics.diagnose({ kind: 'user', who }, provider, 'owner', { signal }));
  }

  @Get('diagnostics')
  @ApiDataResponse(DiagnosticReportResponseDto, { isArray: true })
  @Auth({ permissions: ['web_search:read'] })
  @ApiOperation({ summary: 'Your last web search diagnostic reports', description: 'Newest first, every provider: `limit` (default 5, at most 20). Codes, remedy keys, counts, timings and host names only.' })
  history(@CurrentUser('id') userId: string, @Query() q: DiagnosticHistoryQueryDto) {
    return this.diagnostics.historyForUser(userId, q.limit);
  }

  @Post('admin/providers/:id/diagnose')
  @HttpCode(200)
  @ApiDataResponse(DiagnosticReportResponseDto)
  @ApiResponse({ status: 429, description: `\`DIAGNOSTICS_RATE_LIMITED\`: at most ${DIAGNOSE_RATE_LIMIT} a minute for one provider.` })
  @ApiResponse({ status: 404, description: '`WEB_SEARCH_PROVIDER_UNKNOWN`: no such provider is installed.' })
  @Auth({ permissions: ['system_settings:write'] })
  @ApiOperation({
    summary: "Diagnose a search provider with the deployment's key",
    description: `The report with the deployment tier ONLY (never a user's key), stored with no owner; the switches only warn here, so a key can be tested before search is switched on. The live query counts as one call of yours. Stages: ${STAGES}`,
  })
  async diagnoseDeployment(@CurrentUser('id') adminId: string, @Param('id') id: string, @Res({ passthrough: true }) reply: FastifyReply) {
    const provider = this.provider(id);
    await this.limit(`diagnose:search-admin:${adminId}:${provider.id}`);
    return this.withStop(reply, (signal) => this.diagnostics.diagnose({ kind: 'deployment', adminId }, provider, 'admin', { signal }));
  }

  @Get('admin/providers/:id/diagnostics')
  @ApiDataResponse(DiagnosticReportResponseDto, { isArray: true })
  @Auth({ permissions: ['system_settings:read'] })
  @ApiOperation({ summary: "A search provider's last deployment reports", description: 'Newest first: `limit` (default 5, at most 20). The deployment tier only; no user.' })
  historyDeployment(@Param('id') id: string, @Query() q: DiagnosticHistoryQueryDto) {
    return this.diagnostics.historyForDeployment(this.provider(id).id, q.limit);
  }
}
