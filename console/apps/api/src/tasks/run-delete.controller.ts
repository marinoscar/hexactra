import { Body, Controller, Delete, HttpCode, Param, ParseUUIDPipe, Post, Res } from '@nestjs/common';
import type { FastifyReply } from 'fastify';
import { ApiDataResponse } from '@marinoscar/platform-api/core';
import { ApiOperation, ApiResponse, ApiTags } from '@nestjs/swagger';
import { Auth, CurrentUser } from '@marinoscar/platform-api/identity';

import { DeleteRunsDto, RunsDeleteQueuedResponseDto, RunsDeletedResponseDto } from './run-delete.schemas';
import { RunDeleteService } from './run-delete.service';

/** The fields of the signed-in user these routes read. */
interface Principal {
  id: string;
  activeOrgId?: string | null;
}

/**
 * Deleting runs (#421), under `/api/runs` with the routes of `RunsController`.
 * Permanent, own runs only, never a live run. Behind `runs:delete`, apart from
 * `runs:write`, so a role can start and answer runs without erasing history.
 */
@ApiTags('Runs')
@Controller('runs')
export class RunsDeleteController {
  constructor(private readonly runs: RunDeleteService) {}

  /** Declared before `:id`. */
  @Post('delete')
  @HttpCode(200)
  @ApiOperation({
    summary: 'Delete runs: a list of ids, or every finished run that matches a filter',
    description:
      'Permanent. Send exactly one of `ids` or `filter`. Live runs (queued, running, waiting_human) are never deleted: with `ids` they are listed in `skippedLive`, with `filter` they are not matched. ' +
      'A filter that matches more than 500 finished runs answers 202 and a queue job deletes them. Deleting runs also removes their cost and stop-reason history from task spend and from alert counts.',
  })
  @ApiDataResponse(RunsDeletedResponseDto, { description: 'The runs were deleted in the request.' })
  @ApiDataResponse(RunsDeleteQueuedResponseDto, { status: 202, description: 'More than 500 finished runs matched the filter: the `browser.runs.delete` job deletes them.' })
  @ApiResponse({ status: 409, description: '`COUNT_CHANGED`: the matching count is more than 5 % away from `expectedCount`; `details.matched` is the real count. Nothing was deleted.' })
  @Auth({ permissions: ['runs:delete'] })
  async deleteMany(@CurrentUser() user: Principal, @Body() body: DeleteRunsDto, @Res({ passthrough: true }) reply: FastifyReply) {
    const orgId = user.activeOrgId ?? null;
    if (body.ids) return this.runs.deleteByIds(user.id, body.ids, { orgId });
    const result = await this.runs.deleteByFilter(user.id, body.filter ?? {}, { expectedCount: body.expectedCount, orgId });
    if ('jobId' in result) reply.status(202);
    return result;
  }

  @Delete(':id')
  @HttpCode(204)
  @ApiOperation({ summary: 'Delete one finished run', description: 'Permanent: the run, its steps and its questions. 409 `RUN_LIVE` while the run is queued, running or waiting for a person: cancel it first.' })
  @ApiResponse({ status: 204, description: 'Deleted.' })
  @ApiResponse({ status: 404, description: "`RUN_NOT_FOUND`: no such run, or it is another user's." })
  @ApiResponse({ status: 409, description: '`RUN_LIVE`: the run is live. Cancel it first.' })
  @Auth({ permissions: ['runs:delete'] })
  async deleteOne(@CurrentUser() user: Principal, @Param('id', ParseUUIDPipe) id: string): Promise<void> {
    await this.runs.deleteOne(user.id, id, { orgId: user.activeOrgId ?? null });
  }
}
