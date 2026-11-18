import { Body, Controller, Delete, Get, HttpCode, Param, ParseUUIDPipe, Patch, Post, Query, Res } from '@nestjs/common';
import { ApiDataResponse } from '@marinoscar/platform-api/core';
import { Auth, CurrentUser } from '@marinoscar/platform-api/identity';
import { ApiOkResponse, ApiOperation, ApiProduces, ApiTags } from '@nestjs/swagger';
import { createZodDto } from 'nestjs-zod';
import type { FastifyReply } from 'fastify';

import {
  CreateMemoryDto,
  ListMemoriesQueryDto,
  MemoryDetailResponseDto,
  MemoryResponseDto,
  SupersedeMemoryDto,
  UpdateMemoryDto,
} from './memories.schemas';
import { MemoriesService } from './memories.service';
import { memoryFileSchema } from './memory-transfer';

class MemoryFileDto extends createZodDto(memoryFileSchema) {}

/**
 * `/api/memories` (#551): the facts the signed-in user lets the agent use.
 * Every route is the caller's own; another user's id is a 404 like a missing
 * one. A body never sets `source`, `status`, `userId` or the source ids: a
 * memory the agent proposed is written only by the answer to its proposal
 * (#553), never through this controller. No MCP tool reads or writes memories.
 */
@ApiTags('Memories')
@Controller('memories')
export class MemoriesController {
  constructor(private readonly memories: MemoriesService) {}

  @Get()
  @ApiDataResponse(MemoryResponseDto, { isArray: true })
  @Auth({ permissions: ['memories:read'] })
  @ApiOperation({ summary: 'List your memories', description: 'Active memories by default (`status` picks others). `kind` filters; `q` searches the label, the aliases and the attribute values, ignoring case.' })
  list(@CurrentUser('id') userId: string, @Query() q: ListMemoriesQueryDto) {
    return this.memories.list(userId, q);
  }

  // Declared before `:id`.
  @Get('export')
  @ApiOkResponse({ type: MemoryFileDto, description: 'The memories as a `hexactra.memories` JSON file (not wrapped in the `data` envelope), sent as an attachment.' })
  @ApiProduces('application/json')
  @Auth({ permissions: ['memories:read'] })
  @ApiOperation({ summary: 'Export your memories as a JSON file', description: 'A `hexactra.memories` file (`formatVersion` 1) of your active and archived memories: kind, label, aliases, attributes, note, status, source and dates. No ids of the memory, a run or a chat.' })
  async export(@CurrentUser('id') userId: string, @Res() reply: FastifyReply): Promise<void> {
    const { file, filename } = await this.memories.export(userId);
    await reply
      .header('content-disposition', `attachment; filename="${filename}"`)
      .header('cache-control', 'no-store')
      .type('application/json; charset=utf-8')
      .send(JSON.stringify(file, null, 2));
  }

  @Get(':id')
  @ApiDataResponse(MemoryDetailResponseDto)
  @Auth({ permissions: ['memories:read'] })
  @ApiOperation({ summary: 'Get one memory', description: 'With `history`: the older versions it superseded, newest first.' })
  get(@CurrentUser('id') userId: string, @Param('id', ParseUUIDPipe) id: string) {
    return this.memories.get(userId, id);
  }

  @Post()
  @ApiDataResponse(MemoryResponseDto, { status: 201 })
  @Auth({ permissions: ['memories:write'] })
  @ApiOperation({ summary: 'Add a memory', description: 'Its `source` is always `owner`. Refused with `422 MEMORY_HOLDS_SECRET` when a field looks like a password, a code or a full card, account or Social Security number; `409 MEMORY_LABEL_TAKEN` and `409 MEMORY_LIMIT` (500 active).' })
  create(@CurrentUser('id') userId: string, @Body() body: CreateMemoryDto) {
    return this.memories.create(userId, body);
  }

  @Patch(':id')
  @ApiDataResponse(MemoryResponseDto)
  @Auth({ permissions: ['memories:write'] })
  @ApiOperation({ summary: 'Edit a memory', description: 'The label, aliases, note and kind. A value changes through `POST /memories/{id}/supersede`, which keeps the old version in the history.' })
  update(@CurrentUser('id') userId: string, @Param('id', ParseUUIDPipe) id: string, @Body() body: UpdateMemoryDto) {
    return this.memories.update(userId, id, body);
  }

  @Post(':id/supersede')
  @ApiDataResponse(MemoryResponseDto, { status: 201 })
  @Auth({ permissions: ['memories:write'] })
  @ApiOperation({ summary: 'Replace a memory with a new version', description: 'Creates the new version with these attributes and marks the old one `superseded`, in one transaction. A superseded version is never given to the agent.' })
  supersede(@CurrentUser('id') userId: string, @Param('id', ParseUUIDPipe) id: string, @Body() body: SupersedeMemoryDto) {
    return this.memories.supersede(userId, id, body);
  }

  @Post(':id/archive')
  @HttpCode(200)
  @ApiDataResponse(MemoryResponseDto)
  @Auth({ permissions: ['memories:write'] })
  @ApiOperation({ summary: 'Archive a memory', description: 'An archived memory is kept but not given to the agent.' })
  archive(@CurrentUser('id') userId: string, @Param('id', ParseUUIDPipe) id: string) {
    return this.memories.archive(userId, id);
  }

  @Post(':id/unarchive')
  @HttpCode(200)
  @ApiDataResponse(MemoryResponseDto)
  @Auth({ permissions: ['memories:write'] })
  @ApiOperation({ summary: 'Unarchive a memory', description: 'Makes it active again (the label rule and the limit apply).' })
  unarchive(@CurrentUser('id') userId: string, @Param('id', ParseUUIDPipe) id: string) {
    return this.memories.unarchive(userId, id);
  }

  @Delete(':id')
  @HttpCode(204)
  @Auth({ permissions: ['memories:write'] })
  @ApiOperation({ summary: 'Delete a memory', description: 'Permanently, with its older versions.' })
  async remove(@CurrentUser('id') userId: string, @Param('id', ParseUUIDPipe) id: string): Promise<void> {
    await this.memories.remove(userId, id);
  }
}
