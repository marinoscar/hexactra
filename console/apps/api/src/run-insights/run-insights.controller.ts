import { Controller, Get, Param, ParseUUIDPipe, Query } from '@nestjs/common';
import { ApiDataResponse } from '@marinoscar/platform-api/core';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import { Auth, CurrentUser } from '@marinoscar/platform-api/identity';

import { RunDiagnosticsResponseDto, TaskConsistencyQueryDto, TaskConsistencyResponseDto } from '../openapi/run-insights.responses';
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

/** How consistent a task's runs are (E52.7, #1022). */
@ApiTags('Tasks')
@Controller('tasks')
export class TaskInsightsController {
  constructor(private readonly insights: RunInsightsService) {}

  @Get(':id/consistency')
  @ApiOperation({
    summary: "How consistent a task's runs are",
    description:
      "The spread of steps, model calls, working time and cost over the task's newest finished runs (E52.7): min, median, 90th percentile, max and max ÷ median, the success rate and a label (`steady`, `varies`, `erratic`, `not_enough_runs`). `last` is 3 to 50 (default 20); `since` counts only runs created at or after a time (the web passes the time the goal last changed). Benchmark runs are left out. The findings of the 10 newest runs are included. Permissions `tasks:read` and `runs:read`; 404 `TASK_NOT_FOUND` for a task that is not yours.",
  })
  @ApiDataResponse(TaskConsistencyResponseDto)
  @Auth({ permissions: ['tasks:read', 'runs:read'] })
  consistency(@CurrentUser('id') userId: string, @Param('id', ParseUUIDPipe) id: string, @Query() q: TaskConsistencyQueryDto) {
    return this.insights.consistency(userId, id, q.last ?? 20, q.since ? new Date(q.since) : null);
  }
}
