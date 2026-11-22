import { Body, Controller, Delete, Get, Param, ParseUUIDPipe, Put } from '@nestjs/common';
import { ApiDataResponse } from '@marinoscar/platform-api/core';
import { Auth, CurrentUser } from '@marinoscar/platform-api/identity';
import { ApiOperation, ApiTags } from '@nestjs/swagger';

import { KgraphPurgeResponseDto, KgraphStatusResponseDto, PutTaskKgraphDto, TaskKgraphResponseDto } from './kgraph.schemas';
import { KgraphService } from './kgraph.service';

/**
 * The Knowledge Graph's switches (E46.3, #777; docs/decisions/knowledge-graph.md). New routes only; every route is the caller's own and
 * another user's task is a 404 like a missing one. No MCP tool changes a switch.
 */
@ApiTags('Knowledge Graph')
@Controller()
export class KgraphController {
  constructor(private readonly kgraph: KgraphService) {}

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
  @ApiOperation({ summary: 'Delete everything learned', description: 'Removes every Knowledge Graph record of yours: procedures, versions, evidence, reviews, task modes and run records. Nobody else\'s. Turning a switch off deletes nothing; this does.' })
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
}
