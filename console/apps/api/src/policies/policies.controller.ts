import { Body, Controller, Delete, Get, Headers, HttpCode, Param, Patch, Post, Put, Query, Res } from '@nestjs/common';
import { ApiDataResponse } from '@marinoscar/platform-api/core';
import { Auth, CurrentUser } from '@marinoscar/platform-api/identity';
import { ApiHeader, ApiOkResponse, ApiOperation, ApiProduces, ApiTags } from '@nestjs/swagger';
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
  @ApiOperation({ summary: 'List agent policies', description: 'The four built-in policies (`builtin:economy`, `builtin:balanced`, `builtin:thorough`, `builtin:unlimited`) and your own, each with its spec, version, whether it is your default (`isDefault`), the tasks and schedules that use it (`usage`) and whether it has no hard stop (`hasNoHardStop`: every budget is `null`, so only finishing, Stop or stall detection ends a run).' })
  list(@CurrentUser('id') userId: string) {
    return this.policies.list(userId);
  }

  // Declared before `:id`, which would otherwise take "default".
  @Get('default')
  @ApiDataResponse(DefaultPolicyResponseDto)
  @Auth({ permissions: ['agent_policies:read'] })
  @ApiOperation({ summary: 'Get your default policy', description: 'The policy a run uses when nothing more specific names one. `explicit` is false while you have not chosen one: the default is then `builtin:balanced`.' })
  getDefault(@CurrentUser('id') userId: string) {
    return this.policies.getDefault(userId);
  }

  @Put('default')
  @ApiDataResponse(DefaultPolicyResponseDto)
  @Auth({ permissions: ['agent_policies:write'] })
  @ApiOperation({ summary: 'Set your default policy', description: "Body `{ policyId }`: an own policy's id or `builtin:<key>`; `null` goes back to `builtin:balanced`. Runs already started keep the policy they started with." })
  setDefault(@CurrentUser('id') userId: string, @Body() body: SetDefaultPolicyDto) {
    return this.policies.setDefault(userId, body.policyId);
  }

  // Declared before `:id`, which would otherwise take "model-tiers".
  @Get('model-tiers/effective')
  @ApiDataResponse(EffectiveTiersResponseDto)
  @Auth({ permissions: ['agent_policies:read'] })
  @ApiOperation({ summary: 'Read the model each tier resolves to', description: 'The Fast, Standard and Frontier models a new run of your default policy would use (`policyId` resolves for another policy), with where each value came from (`pin`, `user`, `deployment`, `fill_down` or `ai_default`) and whether the model supports tools and images.' })
  effectiveTiers(@CurrentUser('id') userId: string, @Query() q: EffectiveTiersQueryDto) {
    return this.modelTiers.effective(userId, q.policyId);
  }

  // `export` and `import` are declared before every `:id` route (Fastify prefers a static path anyway).
  @Get('export')
  @ApiOkResponse({ type: PolicyFileDto, description: 'The policies as a portable JSON file (not wrapped in the `data` envelope), sent as an attachment `agent-policies-<yyyymmdd>.json`.' })
  @ApiProduces('application/json')
  @Auth({ permissions: ['agent_policies:read'] })
  @ApiOperation({ summary: 'Export policies as a JSON file', description: 'Returns a `hexactra.agent-policies` file (`formatVersion` 1) of your policies and, with `ids=all` (the default), the built-ins too. The file holds names, descriptions and specs only: no ids, user, version, usage or secret. `includePins=false` strips model pins, so the file works on any deployment.' })
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
  @ApiOperation({ summary: 'Import policies from a JSON file', description: 'Creates the policies of a file made by the export route, in one transaction: an invalid entry rejects the whole file (`400 POLICY_IMPORT_INVALID`, listing every error). `onConflict` decides what happens when you already have a policy of that name: `rename` (default), `skip` or `replace`. Pins to models this deployment cannot use are dropped and budgets above the deployment ceilings are flagged, both as `warnings`. At most 100 policies and 256 KB.' })
  import(@CurrentUser('id') userId: string, @Body() body: ImportPoliciesDto) {
    return this.transfer.import(userId, body.file, body.onConflict);
  }

  @Post()
  @ApiDataResponse(AgentPolicyResponseDto, { status: 201 })
  @Auth({ permissions: ['agent_policies:write'] })
  @ApiOperation({ summary: 'Create a policy', description: 'Creates a personal policy from a full spec. Names are unique among your policies. A budget of `null` is unlimited. A model pin must name a model enabled for you with tool calls and vision (`400 POLICY_PIN_INVALID`).' })
  create(@CurrentUser('id') userId: string, @Body() body: CreatePolicyDto) {
    return this.policies.create(userId, body);
  }

  @Get(':id')
  @ApiDataResponse(AgentPolicyResponseDto)
  @Auth({ permissions: ['agent_policies:read'] })
  @ApiOperation({ summary: 'Get one policy', description: "`id` is an own policy's UUID or `builtin:<key>`." })
  get(@CurrentUser('id') userId: string, @Param('id') id: string) {
    return this.policies.get(userId, id);
  }

  @Patch(':id')
  @ApiHeader({ name: 'If-Match', required: false, description: 'The `version` you edited. 412 `POLICY_VERSION_CONFLICT` when it moved; omit to overwrite. Built-in policies answer 403.' })
  @ApiDataResponse(AgentPolicyResponseDto)
  @Auth({ permissions: ['agent_policies:write'] })
  @ApiOperation({ summary: 'Edit a policy', description: 'Changes the name, the description or the whole spec of your own policy and bumps its `version`. Send `If-Match: <version>` to refuse the edit when the policy moved meanwhile (`412 POLICY_VERSION_CONFLICT`). Built-in policies are read-only (`403`). Runs already started keep their own snapshot.' })
  update(@CurrentUser('id') userId: string, @Param('id') id: string, @Body() body: UpdatePolicyDto, @Headers('if-match') ifMatch?: string) {
    return this.policies.update(userId, id, body, parseIfMatch(ifMatch));
  }

  @Delete(':id')
  @HttpCode(204)
  @Auth({ permissions: ['agent_policies:write'] })
  @ApiOperation({ summary: 'Delete a policy', description: 'Refused with `409 POLICY_IN_USE` (listing the tasks and schedules that use it) unless `reassignTo` names the policy they move to, and with `409 POLICY_IS_DEFAULT` for your default. Built-ins cannot be deleted.' })
  async remove(@CurrentUser('id') userId: string, @Param('id') id: string, @Query() q: DeletePolicyQueryDto): Promise<void> {
    await this.policies.remove(userId, id, q.reassignTo);
  }

  @Post(':id/duplicate')
  @ApiDataResponse(AgentPolicyResponseDto, { status: 201 })
  @Auth({ permissions: ['agent_policies:write'] })
  @ApiOperation({ summary: 'Duplicate a policy', description: 'Copies any policy, built-in or your own, under the given name. Use it to start from a built-in.' })
  duplicate(@CurrentUser('id') userId: string, @Param('id') id: string, @Body() body: DuplicatePolicyDto) {
    return this.policies.duplicate(userId, id, body.name);
  }
}
