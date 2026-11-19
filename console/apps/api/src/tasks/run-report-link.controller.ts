// `GET /api/reports/{token}` (E39.6, #603): the masked PDF report of one run, for whoever holds the signed link. Public on purpose: a
// webhook receiver or the person an email went to has no session. The token (run-report-link.ts) names one run of one user and
// expires after 7 days; this route answers that PDF and nothing else. Every refusal (expired, tampered, another user's run, a run
// since deleted) is the same 404, so a link is no oracle for what exists.
import { Controller, Get, Inject, Logger, NotFoundException, Optional, Param, Res } from '@nestjs/common';
import { ApiOperation, ApiParam, ApiProduces, ApiResponse, ApiTags } from '@nestjs/swagger';
import { Public } from '@marinoscar/platform-api/identity';
import type { FastifyReply } from 'fastify';

import { MCP_RATE_LIMITER, type McpRateLimiter } from '../mcp/mcp.rate-limit';
import { RunFilesService } from './run-files.service';
import './runs.errors';
import { RunReportLinks } from './run-report-link';

/** At most this many reports of one run a minute through a link. */
export const REPORT_LINK_RATE_LIMIT = 20;

@ApiTags('Runs')
@Controller('reports')
export class RunReportLinkController {
  private readonly log = new Logger('RunReportLink');

  constructor(
    private readonly links: RunReportLinks,
    private readonly files: RunFilesService,
    @Optional() @Inject(MCP_RATE_LIMITER) private readonly limiter?: McpRateLimiter,
  ) {}

  @Get(':token')
  @Public()
  @ApiOperation({
    summary: "A run's masked PDF report, by signed link",
    description:
      'No session: the signed token in the path is the authority. It names one run and expires 7 days after it was issued (deliveries and the `runs.run.finished` webhook carry it as `reportUrl`). It streams the masked PDF with `Cache-Control: private, no-store` and exposes nothing else. An expired, altered or unknown link, and a run that was deleted, are all `404`.',
  })
  @ApiParam({ name: 'token', description: 'The signed token from `reportUrl`.' })
  @ApiProduces('application/pdf')
  @ApiResponse({ status: 200, description: 'The PDF report (masked).' })
  @ApiResponse({ status: 404, description: '`REPORT_LINK_INVALID`.' })
  async get(@Param('token') token: string, @Res() reply: FastifyReply): Promise<void> {
    const claims = this.links.verify(token);
    if (!claims) throw this.refused();
    if (this.limiter) {
      const verdict = await Promise.resolve(this.limiter.hit(`report-link:${claims.runId}`, REPORT_LINK_RATE_LIMIT, 60_000)).catch(() => ({ allowed: true, retryAfterS: 0 }));
      if (!verdict.allowed) throw this.refused();
    }
    let file;
    try {
      file = await this.files.pdf(claims.userId, claims.runId, { screenshots: 'embed' });
    } catch {
      // Another user's run, a deleted run and a failing render look the same from here.
      throw this.refused();
    }
    this.log.log(`report link served run=${claims.runId} bytes=${file.bytes.length}`);
    await reply
      .header('content-disposition', `attachment; filename="${file.filename}"`)
      .header('cache-control', 'private, no-store')
      .header('x-content-type-options', 'nosniff')
      .header('referrer-policy', 'no-referrer')
      .type('application/pdf')
      .send(file.bytes);
  }

  private refused(): NotFoundException {
    return new NotFoundException({ code: 'REPORT_LINK_INVALID', message: 'This link is not valid or has expired.' });
  }
}
