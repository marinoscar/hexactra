// The benchmark challenge site (E44.2, #740): `/api/benchmark-site/...`, served to a node's browser at `https://<console>/benchmark/`
// by the nginx overlay (infra/nginx/app.d/locations/benchmark.conf). Public on purpose: the browser of a trial has no console session,
// cookie or key. The token in the path is the only authority, it opens one trial's fixture pages while that trial is running, and
// every refusal is the same 404. Everything a page does is decided by the trial's challenge (src/benchmark/suite/challenges/); this
// controller reads the request and sends the answer.
import { Controller, Get, Param, Post, Req, Res } from '@nestjs/common';
import { ApiOperation, ApiParam, ApiResponse, ApiTags } from '@nestjs/swagger';
import { Public } from '@marinoscar/platform-api/identity';
import type { FastifyReply, FastifyRequest } from 'fastify';

import { BENCHMARK_SITE_ROUTE } from './site.paths';
import { SITE_HEADERS } from './site.render';
import { BenchmarkSiteService, type SiteAnswer } from './site.service';

const TOKEN_PARAM = { name: 'token', description: "The trial's site token, from the trial's goal." } as const;
const NOT_FOUND = { status: 404, description: 'The same page for an unknown, closed or malformed token and for a page the challenge does not have.' } as const;

@ApiTags('Benchmark site')
@Controller(BENCHMARK_SITE_ROUTE)
export class BenchmarkSiteController {
  constructor(private readonly site: BenchmarkSiteService) {}

  @Get('assets/:file')
  @Public()
  @ApiOperation({ summary: 'A script or stylesheet of the challenge site', description: 'The static files the challenge pages link: the same for every trial, with no token and no data.' })
  @ApiResponse({ status: 200, description: 'The file.' })
  @ApiResponse(NOT_FOUND)
  async asset(@Param('file') file: string, @Res() reply: FastifyReply): Promise<void> {
    await this.send(reply, this.site.asset(file));
  }

  @Get('t/:token')
  @Public()
  @ApiOperation({ summary: "A trial's site, without the trailing slash", description: "Redirects to the trial's start page, `t/{token}/`: the pages link each other relatively." })
  @ApiParam(TOKEN_PARAM)
  @ApiResponse({ status: 308, description: 'To `t/{token}/`.' })
  async bare(@Param('token') token: string, @Res() reply: FastifyReply): Promise<void> {
    // Relative, and it repeats only what the caller sent: no lookup, so it says nothing about the token.
    const safe = /^[A-Za-z0-9_-]{1,128}$/.test(token);
    await this.send(reply, safe ? { status: 308, type: 'text/html; charset=utf-8', body: '', headers: { location: `./${token}/` } } : this.site.notFound());
  }

  @Get('t/:token/*')
  @Public()
  @ApiOperation({
    summary: "A page of a trial's challenge",
    description:
      "No session: the token in the path is the authority, and it opens one benchmark trial's challenge pages (seeded fixture data) while that trial is running. Answers an HTML page, or JSON for a call made by the page's own script. Rate limited per trial.",
  })
  @ApiParam(TOKEN_PARAM)
  @ApiResponse({ status: 200, description: 'An HTML page, or JSON.' })
  @ApiResponse(NOT_FOUND)
  async page(@Param('token') token: string, @Req() request: FastifyRequest, @Res() reply: FastifyReply): Promise<void> {
    await this.dispatch(token, request, reply);
  }

  @Post('t/:token/*')
  @Public()
  @ApiOperation({
    summary: "A form post or script call of a trial's challenge",
    description: "Changes the trial's own site state, the way the challenge's page does: a form post (answered with a redirect or the page with its errors) or a small JSON call. At most 64 KB. Refused with the same 404 once the trial is closed.",
  })
  @ApiParam(TOKEN_PARAM)
  @ApiResponse({ status: 200, description: 'An HTML page, or JSON.' })
  @ApiResponse({ status: 303, description: 'To the next page of the challenge.' })
  @ApiResponse(NOT_FOUND)
  async act(@Param('token') token: string, @Req() request: FastifyRequest, @Res() reply: FastifyReply): Promise<void> {
    await this.dispatch(token, request, reply);
  }

  private async dispatch(token: string, request: FastifyRequest, reply: FastifyReply): Promise<void> {
    const rest = (request.params as Record<string, string | undefined>)['*'] ?? '';
    await this.send(reply, await this.site.handle({ token, method: request.method, rest, query: request.query, body: request.body }));
  }

  private async send(reply: FastifyReply, answer: SiteAnswer): Promise<void> {
    await reply.status(answer.status).headers({ ...SITE_HEADERS, ...answer.headers }).type(answer.type).send(answer.body);
  }
}
