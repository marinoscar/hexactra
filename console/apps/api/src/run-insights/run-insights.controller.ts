import { Controller, Get, Param, ParseUUIDPipe } from '@nestjs/common';
import { ApiDataResponse } from '@marinoscar/platform-api/core';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import { Auth, CurrentUser } from '@marinoscar/platform-api/identity';

import { RunDiagnosticsResponseDto } from '../openapi/run-insights.responses';
import { RunInsightsService } from './run-insights.service';

/** What a run's steps say about how it went (E52.6, #1021). */
@ApiTags('Runs')
@Controller('runs')
export class RunInsightsController {
  constructor(private readonly insights: RunInsightsService) {}

  @Get(':id/diagnostics')
  @ApiOperation({
    summary: "A run's findings",
    description:
      'Where the run spent effort it did not need, computed on read from its recorded steps (E52.6): loops, selectors that matched nothing, the same control clicked again, many reads per action, a slow start, time waiting for the owner, budget pressure, failures and steps whose outcome is unknown. Deterministic: no model reads anything. Texts are masked like the trace. Reads at most 2,000 steps (`truncated`). Permission `runs:read`; 404 `RUN_NOT_FOUND` for a run that is not yours.',
  })
  @ApiDataResponse(RunDiagnosticsResponseDto)
  @Auth({ permissions: ['runs:read'] })
  diagnostics(@CurrentUser('id') userId: string, @Param('id', ParseUUIDPipe) id: string) {
    return this.insights.diagnostics(userId, id);
  }
}
