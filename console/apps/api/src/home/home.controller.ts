import { Controller, Get, Req } from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import type { FastifyRequest } from 'fastify';
import { ApiDataResponse } from '@marinoscar/platform-api/core';
import { Auth, CurrentUser } from '@marinoscar/platform-api/identity';
import { SettingsResolver } from '@marinoscar/platform-api/settings';

import { HomeSummaryResponseDto } from '../openapi/home.responses';
import { HomeService, type HomeSummary } from './home.service';

/** `/api/home`: the Home page's data (#430). */
@ApiTags('Home')
@Controller('home')
export class HomeController {
  constructor(
    private readonly home: HomeService,
    private readonly settings: SettingsResolver,
  ) {}

  @Get('summary')
  @ApiOperation({
    summary: 'The Home page in one request',
    description:
      "What needs the user, what is running, what runs next, what just happened, the week and the machines. Any signed-in user may call it; a block is built only when the caller holds its permission (`runs:read`: `needsYou`, `liveRuns`, `recentRuns`, `week`; `tasks:read`: `upcoming`; `fleet:read`: `fleet`) and is `null` otherwise, never an empty list. It never carries a question's answer, a secret, a transcript, a policy snapshot, step arguments or a viewer URL. The fleet comes from the fabric with a 1.5 s limit: a fabric that is slow or down answers `fleet.stale: true` with the last hosts read instead of failing the request.",
  })
  @ApiDataResponse(HomeSummaryResponseDto)
  // No permission list: the blocks gate themselves.
  @Auth()
  async summary(@CurrentUser() user: { id: string; permissions?: readonly string[] }, @Req() req: FastifyRequest): Promise<HomeSummary> {
    return this.home.summary({ userId: user.id, permissions: user.permissions ?? [], timezone: await this.settings.resolveRequestTimeZone(req, user.id) });
  }
}
