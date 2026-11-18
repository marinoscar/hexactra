// `/api/approval-rules` (#554): the signed-in owner's saved approvals.
//
// THERE IS NO ROUTE THAT CREATES A RULE, AND THERE MUST NEVER BE ONE. A saved
// approval is created only by the owner's own tick on a question the server
// issued (`ApprovalRulesService.createFromAnswer`, called by the question answer
// handler of #555). This controller lists, narrows, disables, re-enables and
// deletes rules and pauses them all; `test/approval-rules.spec.ts` fails if a
// route, a CLI command or an MCP tool that creates one is added.
import { Body, Controller, Delete, Get, HttpCode, Param, ParseUUIDPipe, Patch, Put, Query } from '@nestjs/common';
import { ApiDataResponse } from '@marinoscar/platform-api/core';
import { Auth, CurrentUser } from '@marinoscar/platform-api/identity';
import { ApiOperation, ApiResponse, ApiTags } from '@nestjs/swagger';

import {
  ApprovalRuleDetailResponseDto,
  ApprovalRuleResponseDto,
  ApprovalRulesListResponseDto,
  ApprovalsPausedResponseDto,
  ListApprovalRulesQueryDto,
  PatchApprovalRuleDto,
  SetApprovalsPausedDto,
} from './approval-rules.schemas';
import { ApprovalRulesService } from './approval-rules.service';

/** The fields of the signed-in user these routes read. */
interface Principal {
  id: string;
  activeOrgId?: string | null;
}

@ApiTags('Saved approvals')
@Controller('approval-rules')
export class ApprovalRulesController {
  constructor(private readonly rules: ApprovalRulesService) {}

  @Get()
  @ApiDataResponse(ApprovalRulesListResponseDto)
  @Auth({ permissions: ['approvals:read'] })
  @ApiOperation({
    summary: 'List your saved approvals',
    description:
      'Steps you told the agent not to ask about again, newest first, and whether "Pause all" is on (`paused`). A rule matches only on its site (the registrable domain of the page\'s real address), its kind and category and the exact label of the element (digits compared as `#`), within its limits. Rules are made only by ticking "Don\'t ask again" on a request; nothing here creates one.',
  })
  list(@CurrentUser('id') userId: string, @Query() q: ListApprovalRulesQueryDto) {
    return this.rules.list(userId, q);
  }

  // Declared before `:id`.
  @Put('paused')
  @ApiDataResponse(ApprovalsPausedResponseDto)
  @Auth({ permissions: ['approvals:write'] })
  @ApiOperation({ summary: 'Pause or resume every saved approval', description: 'Body `{ paused }`. While paused, no rule matches: every step and question is asked again. The rules themselves are kept.' })
  setPaused(@CurrentUser() user: Principal, @Body() body: SetApprovalsPausedDto) {
    return this.rules.setPaused(user.id, body.paused, { orgId: user.activeOrgId ?? null });
  }

  @Get(':id')
  @ApiDataResponse(ApprovalRuleDetailResponseDto)
  @ApiResponse({ status: 404, description: "`APPROVAL_RULE_NOT_FOUND`: no such rule, or it is another user's." })
  @Auth({ permissions: ['approvals:read'] })
  @ApiOperation({ summary: 'Get one saved approval', description: 'The rule with its newest 20 uses (run and time).' })
  get(@CurrentUser('id') userId: string, @Param('id', ParseUUIDPipe) id: string) {
    return this.rules.get(userId, id);
  }

  @Patch(':id')
  @ApiDataResponse(ApprovalRuleResponseDto)
  @ApiResponse({ status: 400, description: '`RULE_CANNOT_WIDEN`: the patch would loosen the rule (raise or remove a limit, lengthen or remove the expiry, remove or change a scope).' })
  @ApiResponse({ status: 404, description: "`APPROVAL_RULE_NOT_FOUND`: no such rule, or it is another user's." })
  @Auth({ permissions: ['approvals:write'] })
  @ApiOperation({
    summary: 'Narrow, disable or re-enable a saved approval',
    description: 'Only `enabled`, `maxAmount`, `expiresAt`, `taskId` and `conversationId`, and only to narrow: set or lower the amount limit, set or bring forward the expiry, add a task or chat scope, or disable. Re-enabling a rule you disabled is allowed. A looser rule is made by answering a new request.',
  })
  patch(@CurrentUser() user: Principal, @Param('id', ParseUUIDPipe) id: string, @Body() body: PatchApprovalRuleDto) {
    return this.rules.patch(user.id, id, body, { orgId: user.activeOrgId ?? null });
  }

  @Delete(':id')
  @HttpCode(204)
  @ApiResponse({ status: 204, description: 'Deleted, with its uses.' })
  @ApiResponse({ status: 404, description: "`APPROVAL_RULE_NOT_FOUND`: no such rule, or it is another user's." })
  @Auth({ permissions: ['approvals:write'] })
  @ApiOperation({ summary: 'Delete a saved approval', description: 'Permanent. The next time the step comes up, you are asked again.' })
  async remove(@CurrentUser() user: Principal, @Param('id', ParseUUIDPipe) id: string): Promise<void> {
    await this.rules.remove(user.id, id, { orgId: user.activeOrgId ?? null });
  }
}
