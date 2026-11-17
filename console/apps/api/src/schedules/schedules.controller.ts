import { Body, Controller, Delete, Get, HttpCode, Param, ParseUUIDPipe, Patch, Post, Query, Req } from '@nestjs/common';
import type { FastifyRequest } from 'fastify';
import { ApiDataResponse } from '@marinoscar/platform-api/core';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import { Auth, CurrentUser } from '@marinoscar/platform-api/identity';

import { CreateScheduleDto, ListSchedulesDto, PreviewScheduleDto, SchedulesService, UpdateScheduleDto } from './schedules.service';
import { ScheduleResponseDto } from '../openapi/console.responses';
import { ScheduleDefaultsResponseDto, SchedulePreviewResponseDto } from '../openapi/tasks.responses';

/** `/api/schedules`: run tasks on a schedule (cron + time zone). */
@ApiTags('Schedules')
@Controller('schedules')
export class SchedulesController {
  constructor(private readonly schedules: SchedulesService) {}

  @Get()
  @ApiDataResponse(ScheduleResponseDto, { isArray: true })
  @Auth({ permissions: ['tasks:read'] })
  list(@CurrentUser('id') userId: string, @Query() q: ListSchedulesDto) {
    return this.schedules.list(userId, q.taskId);
  }

  @Get('defaults')
  @ApiOperation({
    summary: 'What a new schedule gets by default',
    description:
      "The time zone a schedule is given when its request names none: the user's profile time zone; for a profile that follows the device, the `X-Time-Zone` request header; else UTC. Changing the profile later does not move existing schedules.",
  })
  @ApiDataResponse(ScheduleDefaultsResponseDto)
  @Auth({ permissions: ['tasks:read'] })
  defaults(@CurrentUser('id') userId: string, @Req() req: FastifyRequest) {
    return this.schedules.defaults(userId, req);
  }

  @Post('preview')
  @ApiOperation({
    summary: 'Check a schedule before saving it',
    description:
      'Always 200. A usable expression answers `valid: true` with what it means in words and its next firings (ISO instants; format them in the zone you show). Anything else answers `valid: false` with the `code` and `message` saving it would be refused with. Nothing is stored.',
  })
  @ApiDataResponse(SchedulePreviewResponseDto)
  @HttpCode(200)
  @Auth({ permissions: ['tasks:read'] })
  preview(@CurrentUser('id') userId: string, @Body() body: PreviewScheduleDto, @Req() req: FastifyRequest) {
    return this.schedules.preview(userId, body, req);
  }

  @Post()
  @ApiOperation({ summary: 'Add a schedule to a task', description: 'Without `timezone` the schedule gets the profile time zone (`GET /schedules/defaults`). 409 `SCHEDULE_LIMIT` when the task already has 10 schedules.' })
  @ApiDataResponse(ScheduleResponseDto, { status: 201 })
  @Auth({ permissions: ['tasks:write'] })
  create(@CurrentUser('id') userId: string, @Body() body: CreateScheduleDto, @Req() req: FastifyRequest) {
    return this.schedules.create(userId, body, req);
  }

  @Patch(':id')
  @ApiDataResponse(ScheduleResponseDto)
  @Auth({ permissions: ['tasks:write'] })
  update(@CurrentUser('id') userId: string, @Param('id', ParseUUIDPipe) id: string, @Body() body: UpdateScheduleDto) {
    return this.schedules.update(userId, id, body);
  }

  @Delete(':id')
  @HttpCode(204)
  @Auth({ permissions: ['tasks:write'] })
  async remove(@CurrentUser('id') userId: string, @Param('id', ParseUUIDPipe) id: string): Promise<void> {
    await this.schedules.remove(userId, id);
  }
}
