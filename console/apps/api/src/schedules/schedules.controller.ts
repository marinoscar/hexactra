import { Body, Controller, Delete, Get, HttpCode, Param, ParseUUIDPipe, Patch, Post, Query } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import { Auth, CurrentUser } from '@marinoscar/platform-api/identity';

import { CreateScheduleDto, SchedulesService, UpdateScheduleDto } from './schedules.service';

/** `/api/schedules`: run tasks on a schedule (cron + time zone). */
@ApiTags('Schedules')
@Controller('schedules')
export class SchedulesController {
  constructor(private readonly schedules: SchedulesService) {}

  @Get()
  @Auth({ permissions: ['tasks:read'] })
  list(@CurrentUser('id') userId: string, @Query('taskId') taskId?: string) {
    return this.schedules.list(userId, taskId);
  }

  @Post()
  @Auth({ permissions: ['tasks:write'] })
  create(@CurrentUser('id') userId: string, @Body() body: CreateScheduleDto) {
    return this.schedules.create(userId, body);
  }

  @Patch(':id')
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
