import { Body, Controller, Delete, Get, Headers, HttpCode, Param, Patch, Post, Put, Query } from '@nestjs/common';
import { ApiDataResponse } from '@marinoscar/platform-api/core';
import { Auth, CurrentUser } from '@marinoscar/platform-api/identity';
import { ApiHeader, ApiTags } from '@nestjs/swagger';

import {
  AgentPolicyResponseDto,
  CreatePolicyDto,
  DefaultPolicyResponseDto,
  DeletePolicyQueryDto,
  DuplicatePolicyDto,
  SetDefaultPolicyDto,
  UpdatePolicyDto,
} from './policies.schemas';
import { PoliciesService } from './policies.service';

/** `If-Match: 4`, `"4"` or `W/"4"`; anything else is treated as absent. */
export function parseIfMatch(header: string | undefined): number | undefined {
  const m = typeof header === 'string' ? /^\s*(?:W\/)?"?(\d{1,9})"?\s*$/.exec(header) : null;
  return m ? Number(m[1]) : undefined;
}

/** `/api/agent-policies`: the signed-in user's agent policies, plus the built-in ones. */
@ApiTags('Agent policies')
@Controller('agent-policies')
export class PoliciesController {
  constructor(private readonly policies: PoliciesService) {}

  @Get()
  @ApiDataResponse(AgentPolicyResponseDto, { isArray: true })
  @Auth({ permissions: ['agent_policies:read'] })
  list(@CurrentUser('id') userId: string) {
    return this.policies.list(userId);
  }

  // Declared before `:id`, which would otherwise take "default".
  @Get('default')
  @ApiDataResponse(DefaultPolicyResponseDto)
  @Auth({ permissions: ['agent_policies:read'] })
  getDefault(@CurrentUser('id') userId: string) {
    return this.policies.getDefault(userId);
  }

  @Put('default')
  @ApiDataResponse(DefaultPolicyResponseDto)
  @Auth({ permissions: ['agent_policies:write'] })
  setDefault(@CurrentUser('id') userId: string, @Body() body: SetDefaultPolicyDto) {
    return this.policies.setDefault(userId, body.policyId);
  }

  @Post()
  @ApiDataResponse(AgentPolicyResponseDto, { status: 201 })
  @Auth({ permissions: ['agent_policies:write'] })
  create(@CurrentUser('id') userId: string, @Body() body: CreatePolicyDto) {
    return this.policies.create(userId, body);
  }

  @Get(':id')
  @ApiDataResponse(AgentPolicyResponseDto)
  @Auth({ permissions: ['agent_policies:read'] })
  get(@CurrentUser('id') userId: string, @Param('id') id: string) {
    return this.policies.get(userId, id);
  }

  @Patch(':id')
  @ApiHeader({ name: 'If-Match', required: false, description: 'The `version` you edited. 412 `POLICY_VERSION_CONFLICT` when it moved; omit to overwrite. Built-in policies answer 403.' })
  @ApiDataResponse(AgentPolicyResponseDto)
  @Auth({ permissions: ['agent_policies:write'] })
  update(@CurrentUser('id') userId: string, @Param('id') id: string, @Body() body: UpdatePolicyDto, @Headers('if-match') ifMatch?: string) {
    return this.policies.update(userId, id, body, parseIfMatch(ifMatch));
  }

  @Delete(':id')
  @HttpCode(204)
  @Auth({ permissions: ['agent_policies:write'] })
  async remove(@CurrentUser('id') userId: string, @Param('id') id: string, @Query() q: DeletePolicyQueryDto): Promise<void> {
    await this.policies.remove(userId, id, q.reassignTo);
  }

  @Post(':id/duplicate')
  @ApiDataResponse(AgentPolicyResponseDto, { status: 201 })
  @Auth({ permissions: ['agent_policies:write'] })
  duplicate(@CurrentUser('id') userId: string, @Param('id') id: string, @Body() body: DuplicatePolicyDto) {
    return this.policies.duplicate(userId, id, body.name);
  }
}
