import { Body, Controller, Delete, Get, HttpCode, Param, ParseUUIDPipe, Patch, Post, Query } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import { Auth, CurrentUser } from '@marinoscar/platform-api/identity';

import { CreateTaskDto, ListRunsDto, UpdateTaskDto } from './tasks.schemas';
import { TasksService } from './tasks.service';

/** `/api/tasks`: the signed-in user's browser tasks. */
@ApiTags('Tasks')
@Controller('tasks')
export class TasksController {
  constructor(private readonly tasks: TasksService) {}

  @Get()
  @Auth({ permissions: ['tasks:read'] })
  list(@CurrentUser('id') userId: string) {
    return this.tasks.listTasks(userId);
  }

  @Get(':id')
  @Auth({ permissions: ['tasks:read'] })
  get(@CurrentUser('id') userId: string, @Param('id', ParseUUIDPipe) id: string) {
    return this.tasks.getTask(userId, id);
  }

  @Post()
  @Auth({ permissions: ['tasks:write'] })
  create(@CurrentUser('id') userId: string, @Body() body: CreateTaskDto) {
    return this.tasks.createTask(userId, body);
  }

  @Patch(':id')
  @Auth({ permissions: ['tasks:write'] })
  update(@CurrentUser('id') userId: string, @Param('id', ParseUUIDPipe) id: string, @Body() body: UpdateTaskDto) {
    return this.tasks.updateTask(userId, id, body);
  }

  @Delete(':id')
  @HttpCode(204)
  @Auth({ permissions: ['tasks:write'] })
  async remove(@CurrentUser('id') userId: string, @Param('id', ParseUUIDPipe) id: string): Promise<void> {
    await this.tasks.deleteTask(userId, id);
  }
}

/** `/api/runs`: the signed-in user's runs with their steps. */
@ApiTags('Runs')
@Controller('runs')
export class RunsController {
  constructor(private readonly tasks: TasksService) {}

  @Get()
  @Auth({ permissions: ['runs:read'] })
  list(@CurrentUser('id') userId: string, @Query() q: ListRunsDto) {
    return this.tasks.listRuns(userId, q);
  }

  @Get(':id')
  @Auth({ permissions: ['runs:read'] })
  get(@CurrentUser('id') userId: string, @Param('id', ParseUUIDPipe) id: string) {
    return this.tasks.getRun(userId, id);
  }

  @Post(':id/cancel')
  @HttpCode(200)
  @Auth({ permissions: ['runs:write'] })
  cancel(@CurrentUser('id') userId: string, @Param('id', ParseUUIDPipe) id: string) {
    return this.tasks.cancel(userId, id);
  }
}
