import { Body, Controller, Delete, Get, HttpCode, Param, ParseUUIDPipe, Patch, Post, Query, Req, Res } from '@nestjs/common';
import type { FastifyReply, FastifyRequest } from 'fastify';
import { ApiDataResponse } from '@marinoscar/platform-api/core';
import { ApiExtraModels, ApiTags } from '@nestjs/swagger';
import { Auth, CurrentUser } from '@marinoscar/platform-api/identity';

import { CreateTaskDto, UpdateTaskDto } from './tasks.schemas';
import { ListRunsDto, RunCountsQueryDto } from './runs.schemas';
import { RunsQueryService } from './runs.query';
import { TasksService } from './tasks.service';
import { runView } from '../policies/policy-snapshot';
import { RunCountsResponseDto, RunDetailResponseDto, RunListItemResponseDto, RunPageResponseDto, RunResponseDto, TaskResponseDto } from '../openapi/console.responses';

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
  constructor(
    private readonly tasks: TasksService,
    private readonly runs: RunsQueryService,
  ) {}

  /**
   * The user's runs, filtered and searched on the server. Without `envelope` it
   * answers the array it always has (the newest `limit`); `envelope=1` answers
   * `{ items, nextCursor }` for keyset paging.
   */
  @Get()
  // Documented as the array, the shape without `envelope`, so typed clients of the
  // earlier contract keep compiling; the page shape is the `RunPageResponseDto` schema.
  @ApiExtraModels(RunPageResponseDto)
  @ApiDataResponse(RunListItemResponseDto, {
    isArray: true,
    description: 'An array of runs: the newest `limit`. With `envelope=1` the data is instead one page, `{ items, nextCursor }` (schema `RunPageResponseDto`).',
  })
  @Auth({ permissions: ['runs:read'] })
  async list(@CurrentUser('id') userId: string, @Query() q: ListRunsDto) {
    const page = await this.runs.list(userId, q);
    return q.envelope ? page : page.items;
  }

  /** How many runs match the filter, per status, and what they cost. Declared before `:id`. */
  @Get('counts')
  @ApiDataResponse(RunCountsResponseDto)
  @Auth({ permissions: ['runs:read'] })
  counts(@CurrentUser('id') userId: string, @Query() q: RunCountsQueryDto) {
    return this.runs.counts(userId, q);
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
