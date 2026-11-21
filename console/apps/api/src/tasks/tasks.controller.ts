import { Body, Controller, Delete, Get, HttpCode, Param, ParseUUIDPipe, Patch, Post, Query, Req, Res } from '@nestjs/common';
import type { FastifyReply, FastifyRequest } from 'fastify';
import { ApiDataResponse } from '@marinoscar/platform-api/core';
import { ApiExtraModels, ApiOkResponse, ApiOperation, ApiProduces, ApiTags, getSchemaPath } from '@nestjs/swagger';
import { Auth, CurrentUser } from '@marinoscar/platform-api/identity';

import { RunExportQueryDto, RunTraceDto } from './run-trace.schemas';
import { RunTraceService } from './run-trace.service';

import { CreateTaskDto, UpdateTaskDto } from './tasks.schemas';
import { ListRunsDto, RunCountsQueryDto } from './runs.schemas';
import { RunsQueryService } from './runs.query';
import { TasksService } from './tasks.service';
import { RunPauseService } from './run-pause.service';
import { runView } from '../policies/policy-snapshot';
import { RunCountsResponseDto, RunDetailResponseDto, RunListItemResponseDto, RunPageResponseDto, RunResponseDto, TaskResponseDto } from '../openapi/console.responses';
import { TaskDetailResponseDto, TaskOutputsPageResponseDto, TaskPageResponseDto, TaskWithSummaryResponseDto } from '../openapi/tasks.responses';
import { TaskOutputsQueryDto } from './task-outputs.schemas';
import { readOutputs } from './task-outputs.schemas';
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
    private readonly runs: RunsQueryService,
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

  @Get(':id/outputs')
  @ApiOperation({
    summary: "The outputs of a task's last runs",
    description:
      "What the task's finished runs returned (E39.5): `columns` are the task's outputs, `items` the runs, newest first, each with its `values` by key (the labels and types the run started with; a sensitive value is `[hidden]`). Keyset paged: pass `nextCursor` back as `cursor`. 404 `TASK_NOT_FOUND` for a task that is not yours.",
  })
  @ApiDataResponse(TaskOutputsPageResponseDto)
  @Auth({ permissions: ['runs:read'] })
  async outputs(@CurrentUser('id') userId: string, @Param('id', ParseUUIDPipe) id: string, @Query() q: TaskOutputsQueryDto) {
    const task = await this.tasks.getTask(userId, id);
    return this.runs.outputsPage(userId, id, readOutputs(task.outputs), q);
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
  constructor(
    private readonly tasks: TasksService,
    private readonly runs: RunsQueryService,
    private readonly traces: RunTraceService,
    private readonly pauses: RunPauseService,
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

  /**
   * The run as one masked JSON file (#542) or a PDF report (#543), sent as an
   * attachment with `@Res()`. `:id/export` has two segments, so it never
   * collides with `GET :id`.
   */
  @Get(':id/export')
  @ApiExtraModels(RunTraceDto)
  @ApiOkResponse({
    description: 'The run trace file (`format=json`, not wrapped in the `data` envelope) or the PDF report (`format=pdf`), sent as an attachment `hexactra-run-<first 8 of id>-<yyyymmdd>.json` or `.pdf`.',
    content: {
      'application/json': { schema: { $ref: getSchemaPath(RunTraceDto) } },
      'application/pdf': { schema: { type: 'string', format: 'binary' } },
    },
  })
  @ApiProduces('application/json', 'application/pdf')
  @Auth({ permissions: ['runs:read'] })
  @ApiOperation({
    summary: 'Export a run as a JSON trace file or a PDF report',
    description:
      'A `hexactra.run-trace` file (`formatVersion` 1): the run, its policy, budget and models, every step with its question and answer, the masked trace screenshots (`screenshots=embed`, the default; `none` leaves the images out) and the messages of its chat. Every string is masked (`masking.hits` counts what was); there is no unmasked export. Never the transcript, a token, a withheld answer or an AI app\'s grant. A live run exports with `partial: true`. `format=pdf` renders the same masked trace as a PDF report (`application/pdf`; `paper=a4`, the default, or `letter`): the goal and outcome, the confirmed steps, the questions and answers, the budget, the timeline with the key-moment screenshots, and a footer on every page; a live run prints a partial-report banner. 404 `RUN_NOT_FOUND` for a run that is not yours; 413 `EXPORT_TOO_LARGE` over 50 MB of screenshots (use `screenshots=none`); 429 `EXPORT_RATE_LIMITED` past 10 exports a minute (JSON and PDF together).',
  })
  async export(@CurrentUser('id') userId: string, @Param('id', ParseUUIDPipe) id: string, @Query() q: RunExportQueryDto, @Res() reply: FastifyReply): Promise<void> {
    if (q.format === 'pdf') {
      const report = await this.traces.exportPdf(userId, id, { screenshots: q.screenshots, paper: q.paper });
      await reply
        .header('content-disposition', `attachment; filename="${report.filename}"`)
        .header('cache-control', 'no-store')
        .type('application/pdf')
        .send(report.stream);
      return;
    }
    const file = await this.traces.exportJson(userId, id, { screenshots: q.screenshots });
    await reply
      .header('content-disposition', `attachment; filename="${file.filename}"`)
      .header('cache-control', 'no-store')
      .type('application/json; charset=utf-8')
      .send(file.body);
  }

  @Get(':id')
  @ApiDataResponse(RunDetailResponseDto)
  @Auth({ permissions: ['runs:read'] })
  async get(@CurrentUser('id') userId: string, @Param('id', ParseUUIDPipe) id: string) {
    const run = await this.tasks.getRun(userId, id);
    // The owner's unlisted accounts that could have done this without the browser (E41.5): a line for the run page, never for the model.
    return { ...runView(run), suggestedConnections: await this.tasks.suggestedConnections(userId, run) };
  }

  @Post(':id/cancel')
  @ApiDataResponse(RunResponseDto)
  @HttpCode(200)
  @Auth({ permissions: ['runs:write'] })
  async cancel(@CurrentUser('id') userId: string, @Param('id', ParseUUIDPipe) id: string) {
    return runView(await this.tasks.cancel(userId, id));
  }

  @Post(':id/pause')
  @ApiOperation({
    summary: 'Pause a run',
    description:
      'Freezes the run: it sets `pauseRequested` and answers the run. A running or queued run ends its current step and pauses before its next action (`status` becomes `paused`, the browser stays where it is, no budget time runs); a run waiting for a person pauses once the question is answered, before the agent acts on the answer. Already paused: answers the run unchanged. 409 `RUN_FINISHED` for a finished run; 409 `RUN_NOT_PAUSABLE` for an external agent\'s run. A paused run never resumes by itself: `POST /runs/{id}/resume` or Stop.',
  })
  @ApiDataResponse(RunResponseDto)
  @HttpCode(200)
  @Auth({ permissions: ['runs:write'] })
  async pause(@CurrentUser('id') userId: string, @Param('id', ParseUUIDPipe) id: string) {
    return runView(await this.pauses.pause(userId, id));
  }

  @Post(':id/resume')
  @ApiOperation({
    summary: 'Resume a paused run',
    description: 'From `paused`: clears the pause, moves the run to `queued` and starts its job (reason `resumed`); the agent looks at the page again before it acts. 409 `RUN_NOT_PAUSED` when the run is not paused.',
  })
  @ApiDataResponse(RunResponseDto)
  @HttpCode(200)
  @Auth({ permissions: ['runs:write'] })
  async resume(@CurrentUser() user: { id: string; activeOrgId?: string | null }, @Param('id', ParseUUIDPipe) id: string) {
    return runView(await this.pauses.resume(user.id, id, user.activeOrgId ?? null));
  }
}
