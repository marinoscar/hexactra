// `/api/web-search` (E50.5, #975): web search for the signed-in user. The status, the providers with where the caller's key comes
// from, and one search (the Test button, the CLI), counted against the caller's day and rate limited. A key is set through the
// service credential routes (`PUT /api/service-credentials/web_search/{provider}`), never here, and no response carries one. The
// organization is the caller's active one, never request input.
import { Body, Controller, Get, HttpCode, HttpException, HttpStatus, Inject, Optional, Post } from '@nestjs/common';
import { isWebToolError } from '@marinoscar/hexactra-web-agent';
import { ApiDataResponse } from '@marinoscar/platform-api/core';
import { Auth, CurrentOrg, CurrentUser } from '@marinoscar/platform-api/identity';
import { ApiOperation, ApiTags } from '@nestjs/swagger';

import { MCP_RATE_LIMITER, type McpRateLimiter } from '../mcp/mcp.rate-limit';
import { webSearchHttpError } from './web-search.errors';
import { WebSearchBodyDto, WebSearchProviderDto, WebSearchResultDto, WebSearchStatusDto } from './web-search.schemas';
import { WebSearchService } from './web-search.service';

/** At most this many searches a minute per user from `POST /api/web-search/search`. */
export const WEB_SEARCH_TEST_RATE_LIMIT = 10;
/** The deadline of one search from the route. */
export const WEB_SEARCH_ROUTE_TIMEOUT_MS = 25_000;

@ApiTags('Web search')
@Controller('web-search')
export class WebSearchController {
  constructor(
    private readonly service: WebSearchService,
    @Optional() @Inject(MCP_RATE_LIMITER) private readonly limiter?: McpRateLimiter,
  ) {}

  @Get('status')
  @ApiDataResponse(WebSearchStatusDto)
  @Auth({ permissions: ['web_search:read'] })
  @ApiOperation({
    summary: 'Whether web search works for you',
    description: "On or off and why (`disabled_by_admin`, `disabled_by_you`, `no_provider`, `no_key`), the provider that would answer and the tier of its key (your own, your organization's or the deployment's), today's count and limit, and the limit per run. Never a key.",
  })
  status(@CurrentUser('id') userId: string, @CurrentOrg() orgId: string | undefined) {
    return this.service.status(userId, orgId ?? null);
  }

  @Get('providers')
  @ApiDataResponse(WebSearchProviderDto, { isArray: true })
  @Auth({ permissions: ['web_search:read'] })
  @ApiOperation({ summary: 'The search providers installed', description: 'Id, label, kind, whether it needs a key, the administrator\'s switch, and for you whether a key is there and at which tier. The cost per call is an estimate. Never a key.' })
  providers(@CurrentUser('id') userId: string, @CurrentOrg() orgId: string | undefined) {
    return this.service.providers(userId, orgId ?? null);
  }

  @Post('search')
  @HttpCode(200)
  @ApiDataResponse(WebSearchResultDto)
  @Auth({ permissions: ['web_search:write'] })
  @ApiOperation({
    summary: 'Run one web search',
    description: `One search for you through the provider that answers (one fallback to the next usable one), counted against your day's limit. For the Test button and the CLI. At most ${WEB_SEARCH_TEST_RATE_LIMIT} a minute. The query is not logged. Errors: \`WEB_SEARCH_NOT_CONFIGURED\`, \`WEB_SEARCH_LIMIT_REACHED\`, \`WEB_SEARCH_AUTH_REFUSED\`, \`WEB_SEARCH_RATE_LIMITED\`, \`WEB_SEARCH_QUOTA_EXCEEDED\`, \`WEB_SEARCH_UNAVAILABLE\`.`,
  })
  async search(@CurrentUser('id') userId: string, @CurrentOrg() orgId: string | undefined, @Body() body: WebSearchBodyDto) {
    if (this.limiter) {
      const v = await Promise.resolve(this.limiter.hit(`web-search:${userId}`, WEB_SEARCH_TEST_RATE_LIMIT, 60_000)).catch(() => ({ allowed: true, retryAfterS: 0 }));
      if (!v.allowed) {
        throw new HttpException({ code: 'WEB_SEARCH_TEST_RATE_LIMITED', message: `At most ${WEB_SEARCH_TEST_RATE_LIMIT} searches a minute. Wait ${v.retryAfterS} seconds and try again.`, details: { retryAfterS: v.retryAfterS } }, HttpStatus.TOO_MANY_REQUESTS);
      }
    }
    try {
      return await this.service.search({ userId, orgId: orgId ?? null }, { query: body.query, count: body.count, freshness: body.freshness, site: body.site, signal: AbortSignal.timeout(WEB_SEARCH_ROUTE_TIMEOUT_MS) });
    } catch (e) {
      if (isWebToolError(e)) throw webSearchHttpError(e);
      throw webSearchHttpError({ code: 'UNAVAILABLE' } as never);
    }
  }
}
