import { Body, Controller, Delete, Get, HttpCode, Param, ParseUUIDPipe, Patch, Post, Query, Req, Res } from '@nestjs/common';
import type { FastifyReply, FastifyRequest } from 'fastify';
import { ApiDataResponse } from '@marinoscar/platform-api/core';
import { ApiTags } from '@nestjs/swagger';
import { Auth, CurrentUser } from '@marinoscar/platform-api/identity';

import { CreateTaskDto, ListRunsDto, UpdateTaskDto } from './tasks.schemas';
import { TasksService } from './tasks.service';
import { runView } from '../policies/policy-snapshot';
import { RunDetailResponseDto, RunResponseDto, TaskResponseDto } from '../openapi/console.responses';

/** A task row as the API returns it: the policy reference is `policyId`. */
export function taskView<T extends { policyRef: string | null }>(task: T): Omit<T, 'policyRef'> & { policyId: string | null } {
  const { policyRef, ...rest } = task;
  return { ...rest, policyId: policyRef };
}

/** The earlier per-task limits, replaced by agent policies (#401): still accepted for one release. */
const LEGACY_TASK_FIELDS = ['maxSteps', 'maxMinutes', 'model'] as const;

/** Flags a response when the request used a deprecated task field (`Deprecation: true`). */
function flagLegacyFields(body: unknown, reply: FastifyReply): void {
  if (body && typeof body === 'object' && LEGACY_TASK_FIELDS.some((k) => k in body)) {
    reply.header('Deprecation', 'true');
    reply.header('Link', '</api/agent-policies>; rel="successor-version"');
  }
}

/** `/api/tasks`: the signed-in user's browser tasks. */
@ApiTags('Tasks')
@Controller('tasks')
export class TasksController {
  constructor(private readonly tasks: TasksService) {}

  @Get()
  @ApiDataResponse(TaskResponseDto, { isArray: true })
  @Auth({ permissions: ['tasks:read'] })
  async list(@CurrentUser('id') userId: string) {
    return (await this.tasks.listTasks(userId)).map(taskView);
  }

  @Get(':id')
  @ApiDataResponse(TaskResponseDto)
  @Auth({ permissions: ['tasks:read'] })
  async get(@CurrentUser('id') userId: string, @Param('id', ParseUUIDPipe) id: string) {
    return taskView(await this.tasks.getTask(userId, id));
  }

  @Post()
  @ApiDataResponse(TaskResponseDto, { status: 201 })
  @Auth({ permissions: ['tasks:write'] })
  async create(@CurrentUser('id') userId: string, @Body() body: CreateTaskDto, @Req() req: FastifyRequest, @Res({ passthrough: true }) reply: FastifyReply) {
    flagLegacyFields(req.body, reply);
    return taskView(await this.tasks.createTask(userId, body));
  }

  @Patch(':id')
  @ApiDataResponse(TaskResponseDto)
  @Auth({ permissions: ['tasks:write'] })
  async update(@CurrentUser('id') userId: string, @Param('id', ParseUUIDPipe) id: string, @Body() body: UpdateTaskDto, @Req() req: FastifyRequest, @Res({ passthrough: true }) reply: FastifyReply) {
    flagLegacyFields(req.body, reply);
    return taskView(await this.tasks.updateTask(userId, id, body));
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
  @ApiDataResponse(RunResponseDto, { isArray: true })
  @Auth({ permissions: ['runs:read'] })
  async list(@CurrentUser('id') userId: string, @Query() q: ListRunsDto) {
    return (await this.tasks.listRuns(userId, q)).map(runView);
  }

  @Get(':id')
  @ApiDataResponse(RunDetailResponseDto)
  @Auth({ permissions: ['runs:read'] })
  async get(@CurrentUser('id') userId: string, @Param('id', ParseUUIDPipe) id: string) {
    return runView(await this.tasks.getRun(userId, id));
  }

  @Post(':id/cancel')
  @ApiDataResponse(RunResponseDto)
  @HttpCode(200)
  @Auth({ permissions: ['runs:write'] })
  async cancel(@CurrentUser('id') userId: string, @Param('id', ParseUUIDPipe) id: string) {
    return runView(await this.tasks.cancel(userId, id));
  }
}
