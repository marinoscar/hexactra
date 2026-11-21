import { Controller, Get, Query, Req, Res } from '@nestjs/common';
import { ApiDataResponse } from '@marinoscar/platform-api/core';
import { Auth, CurrentUser } from '@marinoscar/platform-api/identity';
import { SettingsResolver } from '@marinoscar/platform-api/settings';
import { ApiOkResponse, ApiOperation, ApiProduces, ApiTags } from '@nestjs/swagger';
import type { FastifyReply, FastifyRequest } from 'fastify';

import { UsageReportService } from './usage-report.service';
import { UsageQueryDto, UsageReportResponseDto } from './usage.schemas';

interface Principal {
  id: string;
  permissions?: readonly string[];
}

/**
 * `/api/usage` (#733, epic #730): AI token use and cost over 7, 30 or 90 days
 * or a year by month, as a report or a CSV file. Behind `usage:read`; the
 * deployment-wide view (`scope=all`) also needs `ai_config:read`.
 */
@ApiTags('Usage')
@Controller('usage')
export class UsageController {
  constructor(
    private readonly reports: UsageReportService,
    private readonly settings: SettingsResolver,
  ) {}

  @Get('report')
  @ApiOperation({
    summary: 'AI usage and cost',
    description:
      "Tokens (uncached input, cached input, output, reasoning), requests and cost per day (or per month for `range=1y`), split by model, token type, feature, provider or user, with totals, a per-model table and the runs' own counters. Cost uses the admin's model prices (and, for `scope=me`, the caller's own overrides); a model with no price makes `costKnown` false and the cost a lower bound. `scope=me` is always the caller's own usage; `scope=all` (every user) needs `ai_config:read`. Catalogue syncs are left out.",
  })
  @ApiDataResponse(UsageReportResponseDto)
  @Auth({ permissions: ['usage:read'] })
  async report(@CurrentUser() user: Principal, @Query() q: UsageQueryDto, @Req() req: FastifyRequest) {
    const timeZone = q.tz ?? (await this.settings.resolveRequestTimeZone(req, user.id));
    return this.reports.report({ id: user.id, permissions: user.permissions ?? [] }, q, timeZone);
  }

  @Get('export.csv')
  @ApiOperation({
    summary: 'AI usage and cost as a CSV file',
    description:
      'The same range, scope and filters as `GET /api/usage/report`, one line per period × provider × model × feature (× user for `scope=all`): requests, failed, input, cached input, output, reasoning and total tokens, cost in USD (empty when the model has no price) and `cost_known`. Sent as an attachment.',
  })
  @ApiOkResponse({ description: 'A UTF-8 CSV file (`text/csv`), not wrapped in the `data` envelope.' })
  @ApiProduces('text/csv')
  @Auth({ permissions: ['usage:read'] })
  async exportCsv(@CurrentUser() user: Principal, @Query() q: UsageQueryDto, @Req() req: FastifyRequest, @Res() reply: FastifyReply): Promise<void> {
    const timeZone = q.tz ?? (await this.settings.resolveRequestTimeZone(req, user.id));
    const { filename, body } = await this.reports.csv({ id: user.id, permissions: user.permissions ?? [] }, q, timeZone);
    await reply.header('content-disposition', `attachment; filename="${filename}"`).header('cache-control', 'no-store').type('text/csv; charset=utf-8').send(body);
  }
}
