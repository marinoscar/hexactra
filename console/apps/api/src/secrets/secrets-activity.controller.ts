// `/api/secrets/activity`, `/api/secrets/reach` and `/api/secrets/admin/summary` (E37.4, #593): what the agent used,
// which logins it has reached, and the administrator's counts. NOTHING HERE RETURNS A LOGIN, A USERNAME, A PASSWORD OR
// A CODE: every field is a column of `secrets_activity`, which holds ids, hosts, field kinds and outcome codes only.
import { Controller, Get, Query } from '@nestjs/common';
import { ApiDataResponse } from '@marinoscar/platform-api/core';
import { Auth, CurrentUser } from '@marinoscar/platform-api/identity';
import { ApiOperation, ApiTags } from '@nestjs/swagger';

import { SecretsActivityService } from './secrets-activity.service';
import { AdminSummaryResponseDto, ActivityListResponseDto, CardListingResponseDto, CardQueryDto, IdentityListingResponseDto, ReachResponseDto } from './secrets-activity.schemas';
import { SecretsCardsService } from './secrets-cards.service';
import { SecretsIdentityService } from './secrets-identity.service';
import { SecretsPolicyService } from './secrets-policy.service';
import { VaultConnectionService } from './vault-connection.service';

@ApiTags('Secrets')
@Controller('secrets')
export class SecretsActivityController {
  constructor(
    private readonly activity: SecretsActivityService,
    private readonly policy: SecretsPolicyService,
    private readonly vault: VaultConnectionService,
    private readonly identity: SecretsIdentityService,
    private readonly cards: SecretsCardsService,
  ) {}

  @Get('identity')
  @ApiDataResponse(IdentityListingResponseDto)
  @Auth({ permissions: ['secrets:read'] })
  @ApiOperation({
    summary: 'The identity details you saved',
    description:
      "The identity items you opened to the agent, by name, with each field's label and whether it is sensitive (a date of birth, an ID number: typed only on the sites you listed for the item in your provider). Read-only: manage them, and their allowed sites, in the provider (`manageUrl`). Never a value, never a length. `available` is false, with a `reason`, until Vault is connected with the identity permissions and its identity details are switched on.",
  })
  async identityDetails(@CurrentUser('id') userId: string) {
    return this.identity.list(userId);
  }

  @Get('cards')
  @ApiDataResponse(CardListingResponseDto)
  @Auth({ permissions: ['secrets:read'] })
  @ApiOperation({
    summary: 'The cards you granted for a merchant',
    description:
      "The cards you opened to the agent that hold a live permission for ONE merchant (`merchant`: a host or an https address), by name, with brand, last four digits, expiry and the permission's limit, currency and whether the security code is included. Read-only: the provider lists a card only for a merchant it is granted for, so there is no list of every card; permissions are made in the provider (`manageUrl`). Never a number, never a code. `available` is false, with a `reason`, until Vault is connected with the card permissions and its card release is switched on.",
  })
  async cardList(@CurrentUser('id') userId: string, @Query() q: CardQueryDto) {
    return this.cards.list(userId, q.merchant);
  }

  @Get('activity')
  @ApiDataResponse(ActivityListResponseDto)
  @Auth({ permissions: ['secrets:read'] })
  @ApiOperation({
    summary: 'What the agent did with your saved secrets',
    description:
      'Your newest 100 uses and refusals, from the fabric\'s own audit events: when, the run, the site, which field kind was typed (`username`, `password`, `one_time_code`) and the outcome (`typed`, or why nothing was typed: `origin_mismatch`, `not_found`, `disabled`, ...). Never a value, a username or a code. `providerActivityUrl` is your provider\'s own activity page.',
  })
  async list(@CurrentUser('id') userId: string) {
    const [items, status] = await Promise.all([this.activity.list(userId), this.vault.status(userId)]);
    const v = status.providers.vault;
    return { items, providerActivityUrl: v.status === 'connected' && v.baseUrl ? `${v.baseUrl.replace(/\/+$/, '')}/settings/agent-activity` : null };
  }

  @Get('reach')
  @ApiDataResponse(ReachResponseDto)
  @Auth({ permissions: ['secrets:read'] })
  @ApiOperation({
    summary: 'The logins the agent has used so far',
    description:
      'Vault can look logins up only for a page (per origin), so there is no call that lists every login the agent may reach. This lists the logins used so far, by site, with the fields typed and when. Which logins are open to agents is decided in the provider.',
  })
  async reach(@CurrentUser('id') userId: string) {
    return { listing: 'per_origin' as const, items: await this.activity.reach(userId) };
  }

  @Get('admin/summary')
  @ApiDataResponse(AdminSummaryResponseDto)
  @Auth({ permissions: ['system_settings:read'] })
  @ApiOperation({
    summary: 'Secrets: counts for the administrator',
    description: 'The deployment switch, how many owners are connected (and how many need to reconnect), and how many fields were typed and how many actions were refused in the last 7 days. Counts only: no owner, no site, no login.',
  })
  async adminSummary() {
    return this.activity.adminSummary((await this.policy.system()).agentUse.enabled);
  }
}
