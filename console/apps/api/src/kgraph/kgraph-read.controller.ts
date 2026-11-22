import { Controller, Get, Param, ParseIntPipe, ParseUUIDPipe, Query } from '@nestjs/common';
import { ApiDataResponse } from '@marinoscar/platform-api/core';
import { Auth, CurrentUser } from '@marinoscar/platform-api/identity';
import { ApiOperation, ApiTags } from '@nestjs/swagger';

import { DiffQueryDto, DiffResponseDto, GraphQueryDto, GraphResponseDto, KgRunResponseDto, ProcedureDetailResponseDto, ProceduresQueryDto, ProceduresResponseDto, VersionResponseDto, VersionsResponseDto } from './kgraph-read.schemas';
import { KgraphReadService } from './kgraph-read.service';

const OFF = ' While the deployment or your own switch is off, the stored data is shown with `enabled: false`.';

/**
 * The Knowledge Graph's reads for the pages, the CLI and MCP (E46.19, #793). New routes only, read-only; every record is the caller's own and
 * another user's id is a 404 like a missing one. Labels are masked as in the run trace; a saved login is shown by its label, a sensitive
 * parameter by its name, never a value.
 */
@ApiTags('Knowledge Graph')
@Controller('kgraph')
export class KgraphReadController {
  constructor(private readonly read: KgraphReadService) {}

  @Get('procedures')
  @ApiDataResponse(ProceduresResponseDto)
  @Auth({ permissions: ['kgraph:read'] })
  @ApiOperation({ summary: 'Your learned procedures', description: `Each with its shown version's state and health, its step count and its task's ledger summary. Filters: \`taskId\`, \`state\`, \`q\`.${OFF}` })
  procedures(@CurrentUser('id') userId: string, @Query() q: ProceduresQueryDto) {
    return this.read.procedures(userId, q);
  }

  @Get('procedures/:id')
  @ApiDataResponse(ProcedureDetailResponseDto)
  @Auth({ permissions: ['kgraph:read'] })
  @ApiOperation({ summary: 'One procedure', description: `The active version (else the newest) as an ordered step list: kind, tool, target, whether it uses AI, health, and each argument by where it comes from; its parameters and outputs.${OFF}` })
  procedure(@CurrentUser('id') userId: string, @Param('id') id: string) {
    return this.read.procedure(userId, id);
  }

  @Get('procedures/:id/versions')
  @ApiDataResponse(VersionsResponseDto)
  @Auth({ permissions: ['kgraph:read'] })
  @ApiOperation({ summary: "A procedure's versions", description: `Newest first, with state, change class, health and evidence counts.${OFF}` })
  versions(@CurrentUser('id') userId: string, @Param('id') id: string) {
    return this.read.versions(userId, id);
  }

  @Get('procedures/:id/versions/:version')
  @ApiDataResponse(VersionResponseDto)
  @Auth({ permissions: ['kgraph:read'] })
  @ApiOperation({ summary: 'One version of a procedure', description: `By its number, as an ordered step list.${OFF}` })
  version(@CurrentUser('id') userId: string, @Param('id') id: string, @Param('version', ParseIntPipe) version: number) {
    return this.read.version(userId, id, version);
  }

  @Get('procedures/:id/versions/:version/diff')
  @ApiDataResponse(DiffResponseDto)
  @Auth({ permissions: ['kgraph:read'] })
  @ApiOperation({ summary: 'What changed in a version', description: `Step by step in plain words, against \`against\` (a version number), else its parent, else the version before it.${OFF}` })
  diff(@CurrentUser('id') userId: string, @Param('id') id: string, @Param('version', ParseIntPipe) version: number, @Query() q: DiffQueryDto) {
    return this.read.diff(userId, id, version, q.against);
  }

  @Get('graph')
  @ApiDataResponse(GraphResponseDto)
  @Auth({ permissions: ['kgraph:read'] })
  @ApiOperation({
    summary: 'The Knowledge Graph map',
    description: `Nodes (procedures, steps, tools, sites, accounts, saved logins, parameters, outputs) with type, label, health and counts; edges; clusters per site and per account. Your connected accounts, added MCP tools and saved logins no procedure uses yet are included, flagged \`unused\` (not with \`taskId\` or \`site\`). Above 2,000 nodes, steps fold into their procedures, then the procedures are paged (\`cursor\`).${OFF}`,
  })
  graph(@CurrentUser('id') userId: string, @Query() q: GraphQueryDto) {
    return this.read.graph(userId, q);
  }

  @Get('runs/:runId')
  @ApiDataResponse(KgRunResponseDto)
  @Auth({ permissions: ['kgraph:read'] })
  @ApiOperation({ summary: 'How a run used the Knowledge Graph', description: `Its mode and outcome, and which steps of the procedure were replayed, recovered, judged (one small model call) or done by the agent.${OFF}` })
  run(@CurrentUser('id') userId: string, @Param('runId', ParseUUIDPipe) runId: string) {
    return this.read.run(userId, runId);
  }
}
