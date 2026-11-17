import { Body, Controller, Get, HttpCode, Param, ParseUUIDPipe, Post, Put, Query, Req } from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import type { FastifyRequest } from 'fastify';
import { ApiDataResponse } from '@marinoscar/platform-api/core';
import { Auth, CurrentUser } from '@marinoscar/platform-api/identity';
import { SettingsResolver } from '@marinoscar/platform-api/settings';

import { TaskSchedulesChangedResponseDto, TaskStatsResponseDto, TaskWithSummaryResponseDto } from '../openapi/tasks.responses';
import { ReplaceTaskSchedulesDto, TaskStatsQueryDto } from './task-list.schemas';
import { TaskSchedulesService } from './task-schedules.service';
import { TaskSummaryService } from './task-summary.service';
import { taskView } from './tasks.controller';

/**
 * `/api/tasks/:id/schedules` and `/api/tasks/:id/stats` (#424): a task's
 * schedules as a set, pausing and resuming all of them ("disable a task" is
 * pausing its schedules: there is no `Task.enabled`), and its run statistics.
 */
@ApiTags('Tasks')
@Controller('tasks')
export class TaskSchedulesController {
  constructor(
    private readonly schedules: TaskSchedulesService,
    private readonly summaries: TaskSummaryService,
    private readonly settings: SettingsResolver,
  ) {}

  @Put(':id/schedules')
  @ApiOperation({
    summary: "Replace a task's schedules",
    description:
      "One transaction: an item with an `id` updates that schedule (its `lastRunAt`, `lastRunId` and `consecutiveFailures` are kept; a field left out is unchanged), an item without creates one, and the task's schedules that are not listed are deleted. `nextRunAt` is recomputed for each. An invalid item fails the whole request with 400, a typed `code` and `details.path` (`schedules[1].cron`); an `id` that is not this task's is 400 `SCHEDULE_NOT_IN_TASK`. The response is the task with its `summary`.",
  })
  @ApiDataResponse(TaskWithSummaryResponseDto)
  @Auth({ permissions: ['tasks:write'] })
  async replace(@CurrentUser('id') userId: string, @Param('id', ParseUUIDPipe) id: string, @Body() body: ReplaceTaskSchedulesDto, @Req() req: FastifyRequest) {
    await this.schedules.replace(userId, id, body.schedules, req);
    return taskView(await this.summaries.one(userId, id));
  }

  @Post(':id/schedules/pause')
  @ApiOperation({
    summary: "Pause every schedule of a task",
    description:
      'Sets `enabled = false` and `nextRunAt = null` on all of the task\'s schedules. A run that is live keeps going until it finishes, and the task can still be started by hand, the API or MCP. 409 `NO_SCHEDULES` when the task has no schedule.',
  })
  @ApiDataResponse(TaskSchedulesChangedResponseDto)
  @HttpCode(200)
  @Auth({ permissions: ['tasks:write'] })
  async pause(@CurrentUser('id') userId: string, @Param('id', ParseUUIDPipe) id: string) {
    const { skipped } = await this.schedules.pause(userId, id);
    return { ...taskView(await this.summaries.one(userId, id)), skipped };
  }

  @Post(':id/schedules/resume')
  @ApiOperation({
    summary: "Resume every schedule of a task",
    description: 'Sets `enabled = true`, a fresh `nextRunAt` and `consecutiveFailures = 0` on all of the task\'s schedules, in one transaction. 409 `NO_SCHEDULES` when the task has no schedule.',
  })
  @ApiDataResponse(TaskSchedulesChangedResponseDto)
  @HttpCode(200)
  @Auth({ permissions: ['tasks:write'] })
  async resume(@CurrentUser('id') userId: string, @Param('id', ParseUUIDPipe) id: string) {
    const { skipped } = await this.schedules.resume(userId, id);
    return { ...taskView(await this.summaries.one(userId, id)), skipped };
  }

  @Get(':id/stats')
  @ApiOperation({
    summary: "A task's run statistics",
    description:
      "Outcomes, durations, steps, cost and stop reasons of the task's runs created in the last `days` calendar days (today included), with one `series` entry per day. Days are bucketed in the viewer's time zone: the profile time zone, else the `X-Time-Zone` header, else UTC.",
  })
  @ApiDataResponse(TaskStatsResponseDto)
  @Auth({ permissions: ['runs:read'] })
  async stats(@CurrentUser('id') userId: string, @Param('id', ParseUUIDPipe) id: string, @Query() q: TaskStatsQueryDto, @Req() req: FastifyRequest) {
    return this.summaries.stats(userId, id, q.days, await this.settings.resolveRequestTimeZone(req, userId));
  }
}
