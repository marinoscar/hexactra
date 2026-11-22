import { Body, Controller, Get, Post, Query, Res } from '@nestjs/common';
import { ApiDataResponse } from '@marinoscar/platform-api/core';
import { Auth, CurrentUser } from '@marinoscar/platform-api/identity';
import { ApiOkResponse, ApiOperation, ApiProduces, ApiTags } from '@nestjs/swagger';
import type { FastifyReply } from 'fastify';
import { createZodDto } from 'nestjs-zod';
import { z } from 'zod';

import { KgraphTransferService } from './transfer.service';

class ExportQueryDto extends createZodDto(z.object({ procedureIds: z.string().max(4000).optional().describe('Comma-separated procedure ids; all active procedures when omitted.') }).strict()) {}
class ImportBodyDto extends createZodDto(
  z.object({
    file: z.unknown().describe('A `hexactra.kgraph` file (formatVersion 1).'),
    accounts: z.record(z.string().max(100), z.string().uuid()).optional().describe('Which of your accounts stands for each exported placeholder (`account-1`).'),
    attach: z.record(z.string().max(5), z.string().uuid()).optional().describe('Attach procedure N (its index) to one of your tasks; otherwise a new task in learn mode is created.'),
  }).strict(),
) {}
const importResultSchema = z.object({
  imported: z.array(z.object({ index: z.number(), taskId: z.string(), procedureId: z.string(), versionId: z.string(), reviewId: z.string() })),
  skipped: z.array(z.object({ index: z.number(), reason: z.string() })),
});
class ImportResultDto extends createZodDto(importResultSchema) {}

/** Export and import (E46.23). An import waits for the owner's review of the whole procedure and a verification run. */
@ApiTags('Knowledge Graph')
@Controller('kgraph')
export class KgraphTransferController {
  constructor(private readonly transfer: KgraphTransferService) {}

  @Get('export')
  @ApiOkResponse({ description: 'A `hexactra.kgraph` JSON file (not wrapped in the `data` envelope), sent as an attachment. No ids, tokens, secret values or evidence.' })
  @ApiProduces('application/json')
  @Auth({ permissions: ['kgraph:read'] })
  @ApiOperation({ summary: 'Export your procedures as a file' })
  async export(@CurrentUser('id') userId: string, @Query() q: ExportQueryDto, @Res() reply: FastifyReply): Promise<void> {
    const ids = q.procedureIds ? q.procedureIds.split(',').map((s) => s.trim()).filter(Boolean) : null;
    const { file, filename } = await this.transfer.export(userId, ids);
    await reply.header('content-disposition', `attachment; filename="${filename}"`).header('cache-control', 'no-store').type('application/json; charset=utf-8').send(JSON.stringify(file, null, 2));
  }

  @Post('import')
  @ApiDataResponse(ImportResultDto, { status: 201 })
  @Auth({ permissions: ['kgraph:write'] })
  @ApiOperation({ summary: 'Import procedures from a file', description: 'Each procedure is validated, mapped only to accounts you choose, and stored as a candidate that needs your review and a verification run. `400 KGRAPH_IMPORT_INVALID` for a malformed, newer-format or over-limit file (nothing is imported).' })
  import(@CurrentUser('id') userId: string, @Body() body: ImportBodyDto) {
    return this.transfer.import(userId, body.file, { ...(body.accounts ? { accounts: body.accounts } : {}), ...(body.attach ? { attach: body.attach } : {}) });
  }
}
