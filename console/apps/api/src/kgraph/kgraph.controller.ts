import { Body, Controller, Delete, Get, HttpCode, Optional, Param, ParseUUIDPipe, Post, Put } from '@nestjs/common';
import { JobsService } from '@marinoscar/platform-api/jobs';
import { KGRAPH_UPKEEP_JOB } from './upkeep.job';
import { ApiDataResponse } from '@marinoscar/platform-api/core';
import { Auth, CurrentUser } from '@marinoscar/platform-api/identity';
import { ApiOperation, ApiTags } from '@nestjs/swagger';

import { ForgottenResponseDto, KgraphPurgeResponseDto, KgraphStatusResponseDto, PutTaskKgraphDto, RestoredResponseDto, RestoreVersionDto, TaskKgraphResponseDto } from './kgraph.schemas';
import { KgraphService } from './kgraph.service';

/**
 * The Knowledge Graph's switches (E46.3, #777; docs/decisions/knowledge-graph.md). New routes only; every route is the caller's own and
 * another user's task is a 404 like a missing one. No MCP tool changes a switch.
 */
@ApiTags('Knowledge Graph')
@Controller()
export class KgraphController {
  constructor(
    private readonly kgraph: KgraphService,
    @Optional() private readonly jobs?: JobsService,
  ) {}

  @Get('kgraph/status')
  @ApiDataResponse(KgraphStatusResponseDto)
  @Auth({ permissions: ['kgraph:read'] })
  @ApiOperation({ summary: 'Whether the Knowledge Graph is available to you', description: 'The deployment switch (your administrator), your own switch, and whether both are on. Both are off by default.' })
  status(@CurrentUser('id') userId: string) {
    return this.kgraph.status(userId);
  }

  @Delete('kgraph')
  @ApiDataResponse(KgraphPurgeResponseDto)
  @Auth({ permissions: ['kgraph:write'] })
  @ApiOperation({ summary: 'Delete everything learned', description: 'Removes every Knowledge Graph record of yours: procedures, versions, evidence, reviews, task modes, run records and site facts. Nobody else\'s. Turning a switch off deletes nothing; this does.' })
  purge(@CurrentUser('id') userId: string) {
    return this.kgraph.purge(userId);
  }

  @Get('tasks/:id/kgraph')
  @ApiDataResponse(TaskKgraphResponseDto)
  @Auth({ permissions: ['kgraph:read'] })
  @ApiOperation({ summary: "A task's Knowledge Graph mode", description: '`off` (default), `learn` or `reuse`, and whether the switches above it are on.' })
  getTask(@CurrentUser('id') userId: string, @Param('id', ParseUUIDPipe) id: string) {
    return this.kgraph.taskSettings(userId, id);
  }

  @Put('tasks/:id/kgraph')
  @ApiDataResponse(TaskKgraphResponseDto)
  @Auth({ permissions: ['kgraph:write'] })
  @ApiOperation({ summary: "Set a task's Knowledge Graph mode", description: 'Refused with `409 KGRAPH_OFF` while the deployment or your own switch is off.' })
  putTask(@CurrentUser('id') userId: string, @Param('id', ParseUUIDPipe) id: string, @Body() body: PutTaskKgraphDto) {
    return this.kgraph.setTaskMode(userId, id, body.mode);
  }

  @Post('kgraph/procedures/:id/restore')
  @HttpCode(200)
  @ApiDataResponse(RestoredResponseDto)
  @Auth({ permissions: ['kgraph:write'] })
  @ApiOperation({ summary: 'Restore an earlier version of a procedure', description: 'A retired or suspended version comes back as a new candidate copy; the other usable versions retire. Its next run is a verification run (it asks before every step that sends or pays), then it is active. `409 KGRAPH_VERSION_NOT_RESTORABLE` otherwise.' })
  restore(@CurrentUser('id') userId: string, @Param('id') id: string, @Body() body: RestoreVersionDto) {
    return this.kgraph.restore(userId, id, body.versionId);
  }

  @Post('kgraph/procedures/:id/forget')
  @HttpCode(200)
  @ApiDataResponse(ForgottenResponseDto)
  @Auth({ permissions: ['kgraph:write'] })
  @ApiOperation({ summary: 'Forget a procedure', description: 'Every version retires (kept for history); the task learns again from its next successful run.' })
  forget(@CurrentUser('id') userId: string, @Param('id') id: string) {
    return this.kgraph.forget(userId, id);
  }

  @Post('kgraph/admin/upkeep')
  @HttpCode(202)
  @Auth({ permissions: ['kgraph:admin'] })
  @ApiOperation({ summary: 'Run Knowledge Graph upkeep now', description: 'Enqueues the daily upkeep job (traces, old versions, stale procedures, orphans, duplicates, health). Administrators.' })
  async upkeepNow() {
    if (!this.jobs) return { queued: false };
    await this.jobs.enqueue({ type: KGRAPH_UPKEEP_JOB, reason: 'kgraph_upkeep', subjectType: 'kgraph', subjectId: 'upkeep', orgId: null, payload: {} });
    return { queued: true };
  }
}
