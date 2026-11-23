import { Controller, Get, Query } from '@nestjs/common';
import { ApiDataResponse } from '@marinoscar/platform-api/core';
import { Auth, CurrentUser } from '@marinoscar/platform-api/identity';
import { ApiOperation, ApiTags } from '@nestjs/swagger';

import { KgraphSummaryResponseDto, LedgerQueryDto, LedgerResponseDto } from './ledger.schemas';
import { LedgerService } from './ledger.service';

/**
 * The savings ledger (E46.6, #780; docs/runbooks/kgraph-measurement.md). New routes only, read-only; every row is the caller's own and
 * another user's task is a 404 like a missing one.
 */
@ApiTags('Knowledge Graph')
@Controller()
export class KgraphLedgerController {
  constructor(private readonly ledger: LedgerService) {}

  @Get('kgraph/ledger')
  @ApiDataResponse(LedgerResponseDto)
  @Auth({ permissions: ['kgraph:read'] })
  @ApiOperation({ summary: "A task's savings ledger", description: "One row per run of the task with the Knowledge Graph on (newest first): steps by how they ran, model calls, tokens, cost and active time, and the task's AI-only baseline. A cost with `costKnown: false` is a lower bound." })
  ledgerOf(@CurrentUser('id') userId: string, @Query() q: LedgerQueryDto) {
    return this.ledger.ledger(userId, q.taskId);
  }

  @Get('kgraph/summary')
  @ApiDataResponse(KgraphSummaryResponseDto)
  @Auth({ permissions: ['kgraph:read'] })
  @ApiOperation({ summary: 'What the Knowledge Graph saved', description: 'Per task with ledger rows: runs, the clean-replay rate, and model calls, cost and time against the AI-only baseline. With no baseline yet, no saving is shown.' })
  summary(@CurrentUser('id') userId: string) {
    return this.ledger.summary(userId);
  }
}
