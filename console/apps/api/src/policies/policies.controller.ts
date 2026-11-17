import { Body, Controller, Delete, Get, Headers, HttpCode, Param, Patch, Post, Put, Query, Res } from '@nestjs/common';
import { ApiDataResponse } from '@marinoscar/platform-api/core';
import { Auth, CurrentUser } from '@marinoscar/platform-api/identity';
import { ApiHeader, ApiOkResponse, ApiProduces, ApiTags } from '@nestjs/swagger';
import type { FastifyReply } from 'fastify';

import {
  AgentPolicyResponseDto,
  CreatePolicyDto,
  DefaultPolicyResponseDto,
  DeletePolicyQueryDto,
  DuplicatePolicyDto,
  EffectiveTiersQueryDto,
  EffectiveTiersResponseDto,
  SetDefaultPolicyDto,
  UpdatePolicyDto,
} from './policies.schemas';
import { ModelTiersService } from './model-tiers.service';
import { PoliciesService } from './policies.service';
import { ExportPoliciesQueryDto, ImportPoliciesDto, ImportPoliciesResponseDto, PolicyFileDto } from './policy-transfer.schemas';
import { PolicyTransferService } from './policy-transfer.service';

/** `If-Match: 4`, `"4"` or `W/"4"`; anything else is treated as absent. */
export function parseIfMatch(header: string | undefined): number | undefined {
  const m = typeof header === 'string' ? /^\s*(?:W\/)?"?(\d{1,9})"?\s*$/.exec(header) : null;
  return m ? Number(m[1]) : undefined;
}

/** `/api/agent-policies`: the signed-in user's agent policies, plus the built-in ones. */
@ApiTags('Agent policies')
@Controller('agent-policies')
export class PoliciesController {
  constructor(
    private readonly policies: PoliciesService,
    private readonly modelTiers: ModelTiersService,
    private readonly transfer: PolicyTransferService,
  ) {}

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

  // Declared before `:id`, which would otherwise take "model-tiers".
  @Get('model-tiers/effective')
  @ApiDataResponse(EffectiveTiersResponseDto)
  @Auth({ permissions: ['agent_policies:read'] })
  effectiveTiers(@CurrentUser('id') userId: string, @Query() q: EffectiveTiersQueryDto) {
    return this.modelTiers.effective(userId, q.policyId);
  }

  // `export` and `import` are declared before every `:id` route (Fastify prefers a static path anyway).
  @Get('export')
  @ApiOkResponse({ type: PolicyFileDto, description: 'The policies as a portable JSON file (not wrapped in the `data` envelope), sent as an attachment `agent-policies-<yyyymmdd>.json`.' })
  @ApiProduces('application/json')
  @Auth({ permissions: ['agent_policies:read'] })
  async export(@CurrentUser('id') userId: string, @Query() q: ExportPoliciesQueryDto, @Res() reply: FastifyReply): Promise<void> {
    const { file, filename } = await this.transfer.export(userId, q.ids, q.includePins);
    await reply
      .header('content-disposition', `attachment; filename="${filename}"`)
      .header('cache-control', 'no-store')
      .type('application/json; charset=utf-8')
      .send(JSON.stringify(file, null, 2));
  }

  @Post('import')
  @ApiDataResponse(ImportPoliciesResponseDto)
  @Auth({ permissions: ['agent_policies:write'] })
  import(@CurrentUser('id') userId: string, @Body() body: ImportPoliciesDto) {
    return this.transfer.import(userId, body.file, body.onConflict);
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
