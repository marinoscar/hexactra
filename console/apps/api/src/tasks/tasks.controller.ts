import { Body, Controller, Delete, Get, HttpCode, Param, ParseUUIDPipe, Patch, Post, Query, Req, Res } from '@nestjs/common';
import type { FastifyReply, FastifyRequest } from 'fastify';
import { ApiDataResponse } from '@marinoscar/platform-api/core';
import { ApiExtraModels, ApiOperation, ApiTags } from '@nestjs/swagger';
import { Auth, CurrentUser } from '@marinoscar/platform-api/identity';

import { CreateTaskDto, ListRunsDto, UpdateTaskDto } from './tasks.schemas';
import { TasksService } from './tasks.service';
import { runView } from '../policies/policy-snapshot';
import { RunDetailResponseDto, RunResponseDto, TaskResponseDto } from '../openapi/console.responses';
import { TaskDetailResponseDto, TaskPageResponseDto, TaskWithSummaryResponseDto } from '../openapi/tasks.responses';
import { GetTaskQueryDto, ListTasksDto } from './task-list.schemas';
import { TaskSummaryService } from './task-summary.service';

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
  constructor(
    private readonly tasks: TasksService,
    private readonly summaries: TaskSummaryService,
  ) {}

  @Get()
  @ApiOperation({
    summary: "The user's tasks",
    description:
      'With no parameter: every task, newest first, as an array. `envelope=1` returns a page `{ items, nextCursor, total }`; `include=summary` adds schedule and run facts to each task; `q`, `filter`, `policyId` and `sort` narrow and order the list. `created_desc` and `name_asc` page by keyset; the other sorts page by an offset inside the cursor. The cursor is opaque and belongs to one `sort`.',
  })
  // Documented as the array every existing client reads. The page (`envelope=1`) is
  // `TaskPageResponseDto`, published as a schema of its own: a `oneOf` here would turn
  // the response of every generated client into a union and break the ones in use.
  @ApiExtraModels(TaskPageResponseDto)
  @ApiDataResponse(TaskDetailResponseDto, { isArray: true, description: 'An array of tasks. With `envelope=1`, `data` is a `TaskPageResponseDto` instead: `{ items, nextCursor, total }`.' })
  @Auth({ permissions: ['tasks:read'] })
  async list(@CurrentUser('id') userId: string, @Query() q: ListTasksDto) {
    // No new parameter: the list as it always was.
    const plain = !q.envelope && !q.include && !q.q && !q.filter && !q.policyId && q.sort === 'created_desc' && q.limit === undefined && !q.cursor;
    if (plain) return (await this.tasks.listTasks(userId)).map(taskView);
    const page = await this.summaries.list(userId, q);
    const items = page.items.map(taskView);
    return q.envelope ? { items, nextCursor: page.nextCursor, total: page.total } : items;
  }

  @Get(':id')
  @ApiOperation({ summary: 'One task', description: '`include=summary` adds the same `summary` object the list returns.' })
  @ApiDataResponse(TaskDetailResponseDto)
  @Auth({ permissions: ['tasks:read'] })
  async get(@CurrentUser('id') userId: string, @Param('id', ParseUUIDPipe) id: string, @Query() q: GetTaskQueryDto) {
    return taskView(q.include === 'summary' ? await this.summaries.one(userId, id) : await this.tasks.getTask(userId, id));
  }

  @Post()
  @ApiOperation({
    summary: 'Create a task, with its schedules',
    description:
      'Optional `schedules` (at most 10) are created with the task in one transaction. One invalid schedule fails the whole request with 400, a typed `code` and `details.path` naming it (`schedules[1].cron`, `schedules[0].policyId`); nothing is created. A schedule without `timezone` gets the profile time zone (`GET /schedules/defaults`). The response is the task with its `summary`.',
  })
  @ApiDataResponse(TaskWithSummaryResponseDto, { status: 201 })
  @Auth({ permissions: ['tasks:write'] })
  async create(@CurrentUser('id') userId: string, @Body() body: CreateTaskDto, @Req() req: FastifyRequest, @Res({ passthrough: true }) reply: FastifyReply) {
    flagLegacyFields(req.body, reply);
    const task = await this.tasks.createTask(userId, body, req);
    return taskView(await this.summaries.one(userId, task.id));
  }

  @Patch(':id')
  @ApiDataResponse(TaskResponseDto)
  @Auth({ permissions: ['tasks:write'] })
  async update(@CurrentUser('id') userId: string, @Param('id', ParseUUIDPipe) id: string, @Body() body: UpdateTaskDto, @Req() req: FastifyRequest, @Res({ passthrough: true }) reply: FastifyReply) {
    flagLegacyFields(req.body, reply);
    return taskView(await this.tasks.updateTask(userId, id, body));
  }

  @Delete(':id')
  @ApiOperation({ summary: 'Delete a task', description: 'Its schedules are deleted with it. Its runs are kept, with `taskId` set to null (they stay in the runs list as one-off runs).' })
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
