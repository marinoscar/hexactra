import { BadRequestException, Body, Controller, Get, HttpCode, Param, ParseUUIDPipe, Post, Query, Req } from '@nestjs/common';
import { ApiDataResponse } from '@marinoscar/platform-api/core';
import { Auth, CurrentUser } from '@marinoscar/platform-api/identity';
import { ApiBody, ApiTags } from '@nestjs/swagger';
import { createZodDto } from 'nestjs-zod';
import { z } from 'zod';

import { ConnectedAppsService } from '../connected-apps/connected-apps.service';
import { RequestClientService, clientColumns } from '../connected-apps/request-client';
import { BatchPageResponseDto, BatchResponseDto } from '../openapi/console.responses';
import { PoliciesService } from '../policies/policies.service';
import { policyRefSchema } from '../policies/policies.schemas';
import { RunBatchService } from '../tasks/run-batch.service';
import { taskInputsField } from '../tasks/task-params.schemas';
import { TasksService } from '../tasks/tasks.service';

/** `POST /tasks/{id}/batches`: the rows (2 to `runs.batchMaxRows`, default 25; the service checks the count). */
export const createBatchSchema = z.object({
  rows: z
    .array(z.object({ inputs: taskInputsField.optional().describe("This row's values for the task's `{{Name}}` parameters, by key or display name.") }))
    .min(1)
    .max(100)
    .describe('One object per run, in order. 2 to 25 rows (the deployment setting `runs.batchMaxRows`). Every row is checked before anything is written.'),
  policyId: policyRefSchema.optional().describe("Run every row under this agent policy instead of the task's or the user's default."),
  onFailure: z.enum(['continue', 'stop']).default('continue').describe('`continue` (the default): a failed row does not stop the batch. `stop`: it does, and the rows not started are skipped.'),
});
class CreateBatchDto extends createZodDto(createBatchSchema) {}

const startBatchSchema = z.object({
  rows: z.array(z.number().int().min(1).max(100)).min(1).max(100).optional().describe('The rows to keep (their `seq`), default all; the others are skipped. At least one.'),
});
class StartBatchDto extends createZodDto(startBatchSchema) {}

const listBatchesSchema = z.object({
  limit: z.coerce.number().int().min(1).max(100).default(20).describe('Batches to return, 1 to 100. Default 20.'),
  cursor: z.uuid().optional().describe("The previous page's `nextCursor`."),
});
class ListBatchesDto extends createZodDto(listBatchesSchema) {}

interface Principal {
  id: string;
  activeOrgId?: string | null;
}

/**
 * Batch runs (E51.1, #1006): a saved task run once per row of values, one run after another. Permissions as `POST /tasks/{id}/runs`.
 * Every row is an ordinary run with its own gates; the batch only decides when the next row starts.
 */
@ApiTags('Runs')
@Controller()
export class RunBatchesController {
  constructor(
    private readonly tasks: TasksService,
    private readonly batches: RunBatchService,
    private readonly policies: PoliciesService,
    private readonly clients: RequestClientService,
    private readonly apps: ConnectedAppsService,
  ) {}

  /** Run a saved task once per row of values. Starts at once: the caller wrote the rows. */
  @Post('tasks/:id/batches')
  @ApiDataResponse(BatchResponseDto, { status: 201 })
  @Auth({ permissions: ['runs:write'] })
  @ApiBody({ type: CreateBatchDto })
  async create(@CurrentUser() user: Principal, @Param('id', ParseUUIDPipe) id: string, @Body() body: CreateBatchDto, @Req() req: object) {
    const task = await this.tasks.getTask(user.id, id);
    await this.policies.assertAssignable(user.id, body.policyId);
    // Every row before anything else: a bad row writes nothing.
    await this.batches.checkRows(user.id, task, body.rows);
    const client = await this.clients.resolve(req);
    const decision = await this.apps.checkStart(user.id, client, { kind: 'run', policyId: body.policyId, taskPolicyRef: task.policyRef, allowedDomains: task.allowedDomains });
    const policyId = body.policyId ?? decision.policyOverride;
    const cols = clientColumns(client);
    return this.batches.create(user, task, body.rows, {
      onFailure: body.onFailure,
      trigger: cols.origin === 'mcp' ? 'mcp' : 'manual',
      origin: cols.origin,
      policyRef: policyId ?? null,
      client: { clientId: cols.clientId, clientName: cols.clientName, grantId: cols.grantId },
      ...(decision.appLimits ? { appLimits: decision.appLimits as never } : {}),
    });
  }

  /** A task's batches, newest first. */
  @Get('tasks/:id/batches')
  @ApiDataResponse(BatchPageResponseDto)
  @Auth({ permissions: ['runs:read'] })
  list(@CurrentUser() user: Principal, @Param('id', ParseUUIDPipe) id: string, @Query() q: ListBatchesDto) {
    return this.batches.listForTask(user.id, id, { limit: q.limit, cursor: q.cursor ?? null });
  }

  /** A batch with its rows (values masked) and how each ended. */
  @Get('batches/:id')
  @ApiDataResponse(BatchResponseDto)
  @Auth({ permissions: ['runs:read'] })
  get(@CurrentUser() user: Principal, @Param('id', ParseUUIDPipe) id: string) {
    return this.batches.get(user.id, id);
  }

  /** Start a batch waiting for review (a chat's): the owner's act. `rows` are the rows to keep. */
  @Post('batches/:id/start')
  @HttpCode(200)
  @ApiDataResponse(BatchResponseDto)
  @Auth({ permissions: ['runs:write'] })
  @ApiBody({ type: StartBatchDto, required: false })
  async start(@CurrentUser() user: Principal, @Param('id', ParseUUIDPipe) id: string, @Body() raw?: unknown) {
    const parsed = startBatchSchema.safeParse(raw ?? {});
    if (!parsed.success) throw new BadRequestException({ code: 'VALIDATION_ERROR', message: parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ') });
    return this.batches.start(user, id, parsed.data.rows);
  }

  /** Cancel a batch: its live run is stopped and the rows not started are skipped. */
  @Post('batches/:id/cancel')
  @HttpCode(200)
  @ApiDataResponse(BatchResponseDto)
  @Auth({ permissions: ['runs:write'] })
  cancel(@CurrentUser() user: Principal, @Param('id', ParseUUIDPipe) id: string) {
    return this.batches.cancel(user.id, id);
  }
}
