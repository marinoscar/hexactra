import { Body, Controller, Delete, Get, HttpCode, Param, ParseUUIDPipe, Patch, Post, Query } from '@nestjs/common';
import { ApiDataResponse } from '@marinoscar/platform-api/core';
import { Auth, CurrentUser } from '@marinoscar/platform-api/identity';
import { ApiOperation, ApiTags } from '@nestjs/swagger';

import { CreateSkillDto, ListSkillsQueryDto, SkillResponseDto, UpdateSkillDto } from './skills.schemas';
import { SkillsService } from './skills.service';

/**
 * `/api/skills` (#1008): the playbooks the signed-in user writes for the agent. Every route is the caller's own; another user's id is a
 * 404 like a missing one. A body never sets `userId`, `useCount` or the dates. No MCP tool, agent tool, chat tool or webhook reads or
 * writes a skill: the signed-in console and the owner's own CLI (a personal access token) use these routes.
 */
@ApiTags('Skills')
@Controller('skills')
export class SkillsController {
  constructor(private readonly skills: SkillsService) {}

  @Get()
  @ApiDataResponse(SkillResponseDto, { isArray: true })
  @Auth({ permissions: ['skills:read'] })
  @ApiOperation({ summary: 'List your skills', description: 'The skills in use by default (`archived=true` lists the archived ones, `all` both). `q` searches the name, the description and the sites, ignoring case.' })
  list(@CurrentUser('id') userId: string, @Query() q: ListSkillsQueryDto) {
    return this.skills.list(userId, q);
  }

  @Get(':id')
  @ApiDataResponse(SkillResponseDto)
  @Auth({ permissions: ['skills:read'] })
  @ApiOperation({ summary: 'Get one skill', description: 'With its text.' })
  get(@CurrentUser('id') userId: string, @Param('id', ParseUUIDPipe) id: string) {
    return this.skills.get(userId, id);
  }

  @Post()
  @ApiDataResponse(SkillResponseDto, { status: 201 })
  @Auth({ permissions: ['skills:write'] })
  @ApiOperation({ summary: 'Add a skill', description: 'Refused with `400 SKILL_SECRET` when a field looks like a password, a code, a token or a full card, account, IBAN or Social Security number; `400 INVALID_SITE` for a site that is not a registrable domain; `409 SKILL_NAME_TAKEN` and `409 SKILL_LIMIT` (100 skills).' })
  create(@CurrentUser('id') userId: string, @Body() body: CreateSkillDto) {
    return this.skills.create(userId, body);
  }

  @Patch(':id')
  @ApiDataResponse(SkillResponseDto)
  @Auth({ permissions: ['skills:write'] })
  @ApiOperation({ summary: 'Edit a skill', description: 'The name, when to use it, the text, the sites and whether it is on. The same checks as when it is added.' })
  update(@CurrentUser('id') userId: string, @Param('id', ParseUUIDPipe) id: string, @Body() body: UpdateSkillDto) {
    return this.skills.update(userId, id, body);
  }

  @Post(':id/archive')
  @HttpCode(200)
  @ApiDataResponse(SkillResponseDto)
  @Auth({ permissions: ['skills:write'] })
  @ApiOperation({ summary: 'Archive a skill', description: 'An archived skill is kept but never offered to a run or a chat.' })
  archive(@CurrentUser('id') userId: string, @Param('id', ParseUUIDPipe) id: string) {
    return this.skills.setArchived(userId, id, true);
  }

  @Post(':id/unarchive')
  @HttpCode(200)
  @ApiDataResponse(SkillResponseDto)
  @Auth({ permissions: ['skills:write'] })
  @ApiOperation({ summary: 'Unarchive a skill', description: 'It is offered again when it fits a job (and it is on).' })
  unarchive(@CurrentUser('id') userId: string, @Param('id', ParseUUIDPipe) id: string) {
    return this.skills.setArchived(userId, id, false);
  }

  @Delete(':id')
  @HttpCode(204)
  @Auth({ permissions: ['skills:write'] })
  @ApiOperation({ summary: 'Delete a skill', description: 'Permanently. Runs that read it keep its id.' })
  async remove(@CurrentUser('id') userId: string, @Param('id', ParseUUIDPipe) id: string): Promise<void> {
    await this.skills.remove(userId, id);
  }
}
