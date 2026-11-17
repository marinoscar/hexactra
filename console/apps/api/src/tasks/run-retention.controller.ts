import { Controller, Get, HttpCode, Post, Query } from '@nestjs/common';
import { ApiDataResponse } from '@marinoscar/platform-api/core';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import { Auth, CurrentUser } from '@marinoscar/platform-api/identity';

import { RetentionApplyResponseDto, RetentionPreviewQueryDto, RetentionPreviewResponseDto, RetentionSettingsResponseDto } from './run-retention.schemas';
import { RunRetentionService } from './run-retention.service';

/** The fields of the signed-in user these routes read. */
interface Principal {
  id: string;
  activeOrgId?: string | null;
}

/**
 * Run retention (#422), under `/api/runs`: the caller's rule, what it would
 * delete, and "apply now". Always the caller's own runs: there is no user
 * parameter. Behind `runs:delete`, like every route that erases runs. The rule
 * itself is saved through `PATCH /api/user-settings` (`{ runs: { … } }`).
 */
@ApiTags('Runs')
@Controller('runs/retention')
export class RunRetentionController {
  constructor(private readonly retention: RunRetentionService) {}

  @Get()
  @ApiOperation({
    summary: "The caller's run retention rule",
    description: 'The saved rule, or the defaults (keep 90 days) while none was saved, with the deployment ceiling and the floor. Save it with `PATCH /api/user-settings` (`{ "runs": { "keepDays": 30 } }`).',
  })
  @ApiDataResponse(RetentionSettingsResponseDto)
  @Auth({ permissions: ['runs:delete'] })
  async settings(@CurrentUser() user: Principal) {
    const [{ limits, noticeSentAt }, maxKeepDays, floorHours] = await Promise.all([this.retention.userRetention(user.id), this.retention.maxKeepDays(), this.retention.floorHours()]);
    return { ...limits, saved: noticeSentAt !== null, maxKeepDays, floorHours };
  }

  @Get('preview')
  @ApiOperation({
    summary: 'What a retention rule would delete now',
    description:
      "Counts the caller's finished runs the given limits would delete, with the same query the nightly job uses, and deletes nothing. An empty or absent limit means none. The deployment ceiling is applied; live runs, runs younger than the floor and runs with a pending question are never counted.",
  })
  @ApiDataResponse(RetentionPreviewResponseDto)
  @Auth({ permissions: ['runs:delete'] })
  async preview(@CurrentUser() user: Principal, @Query() q: RetentionPreviewQueryDto) {
    const [rule, floorHours] = await Promise.all([this.retention.effectiveRule(q), this.retention.floorHours()]);
    const preview = await this.retention.preview(user.id, rule, { floorHours });
    return { ...preview, maxKeepDays: rule.maxKeepDays, capped: rule.capped, floorHours };
  }

  @Post('apply')
  @HttpCode(202)
  @ApiOperation({
    summary: "Apply the caller's saved retention rule now",
    description: "Enqueues the `browser.runs.retention.apply` job for the caller's runs only, instead of waiting for the nightly pass. Permanent. Sent again while the job is pending, it answers the same job.",
  })
  @ApiDataResponse(RetentionApplyResponseDto, { status: 202 })
  @Auth({ permissions: ['runs:delete'] })
  apply(@CurrentUser() user: Principal) {
    return this.retention.enqueueForUser(user.id, user.activeOrgId ?? null);
  }
}
