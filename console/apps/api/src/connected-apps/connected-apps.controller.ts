import { Body, Controller, Get, Param, ParseUUIDPipe, Patch } from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import { ApiDataResponse } from '@marinoscar/platform-api/core';
import { Auth, CurrentUser } from '@marinoscar/platform-api/identity';

import { AppPreflightResponseDto, ConnectedAppListResponseDto, ConnectedAppResponseDto, AppLimitsResponseDto } from './connected-apps.responses';
import { PatchAppSettingsDto } from './connected-apps.schemas';
import { ConnectedAppsService } from './connected-apps.service';
import { ConnectedAppsPreflight } from './connected-apps.preflight';

/**
 * `/api/connected-apps` (#464): the caller's own AI apps (OAuth grants to the
 * MCP endpoint), their limits and usage, and the "Connect an AI app"
 * preflight. Disconnecting is the platform's `DELETE /api/oauth/grants/:id`
 * (the "Connected apps" card uses the same route), so the two pages never
 * disagree.
 */
@ApiTags('Connected apps')
@Controller('connected-apps')
export class ConnectedAppsController {
  constructor(
    private readonly apps: ConnectedAppsService,
    private readonly preflightService: ConnectedAppsPreflight,
  ) {}

  @Get()
  @ApiOperation({ summary: 'Your connected AI apps', description: 'Your active OAuth grants to the MCP endpoint, one per app, with the scopes in words, your limits for the app and its usage over 30 days (counted from runs).' })
  @ApiDataResponse(ConnectedAppListResponseDto)
  @Auth({ permissions: ['connected_apps:read'] })
  list(@CurrentUser('id') userId: string) {
    return this.apps.list(userId);
  }

  @Get('preflight')
  @ApiOperation({
    summary: 'Can an AI app connect?',
    description: 'For the "Connect an AI app" guide: is the OAuth server on, is the console on a public HTTPS URL that answers the discovery documents (the platform Doctor checks `oauth.public_url` and `oauth.well_known`), and are the hosts of ChatGPT and Claude allowed. Each failing row says who can fix it.',
  })
  @ApiDataResponse(AppPreflightResponseDto)
  @Auth({ permissions: ['connected_apps:read'] })
  preflight(@CurrentUser() user: { id: string; permissions?: readonly string[] }) {
    return this.preflightService.run(user.permissions ?? []);
  }

  @Get(':clientId')
  @ApiOperation({ summary: 'One connected AI app', description: 'An app you connected, or one known from its runs or settings after it was disconnected (`grantId` null).' })
  @ApiDataResponse(ConnectedAppResponseDto)
  @Auth({ permissions: ['connected_apps:read'] })
  get(@CurrentUser('id') userId: string, @Param('clientId', ParseUUIDPipe) clientId: string) {
    return this.apps.get(userId, clientId);
  }

  @Get(':clientId/settings')
  @ApiOperation({ summary: "An app's limits", description: 'The defaults until you change one; clamped to the deployment ceilings.' })
  @ApiDataResponse(AppLimitsResponseDto)
  @Auth({ permissions: ['connected_apps:read'] })
  async settings(@CurrentUser('id') userId: string, @Param('clientId', ParseUUIDPipe) clientId: string) {
    return (await this.apps.get(userId, clientId)).limits;
  }

  @Patch(':clientId/settings')
  @ApiOperation({
    summary: "Change an app's limits",
    description:
      "Any subset of the limits. A limit only narrows what the app may do: it never widens a task's own allowed sites or confirmation. `maxConcurrentRuns` and `dailyRunLimit` may not exceed the deployment ceilings (`mcp.maxConcurrentRunsPerApp`, `mcp.maxDailyRunsPerApp`). `paused: true` refuses new runs and sessions from the app; live ones keep running.",
  })
  @ApiDataResponse(AppLimitsResponseDto)
  @Auth({ permissions: ['connected_apps:write'] })
  patch(@CurrentUser('id') userId: string, @Param('clientId', ParseUUIDPipe) clientId: string, @Body() body: PatchAppSettingsDto) {
    return this.apps.patch(userId, clientId, body);
  }
}
