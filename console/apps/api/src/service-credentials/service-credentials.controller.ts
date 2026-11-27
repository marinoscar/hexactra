// `/api/service-credentials` (E50.2, #972): the keys of outside services the console calls (a search provider), in three tiers.
// WRITE-ONLY: there is no route that returns a value or any part of one. The organization is always the caller's active one, never
// request input. The request log prints the method and the path only; the body (the key) is never logged.
import { Body, Controller, Delete, Get, HttpCode, Param, Post, Put } from '@nestjs/common';
import { ApiDataResponse } from '@marinoscar/platform-api/core';
import { Auth, CurrentOrg, CurrentUser } from '@marinoscar/platform-api/identity';
import { ApiOperation, ApiResponse, ApiTags } from '@nestjs/swagger';

import type { Who } from './service-credential.port';
import { MoveServiceCredentialDto, MoveServiceCredentialResponseDto, ServiceCredentialRefParamDto, ServiceCredentialResponseDto, SetServiceCredentialDto } from './service-credentials.schemas';
import { ServiceCredentialsService } from './service-credentials.service';

/** The organization permission the AI key routes use (`/api/admin/ai/org-keys`). */
export const ORG_SERVICE_CREDENTIAL_PERMISSION = 'org_ai_config:write';

const who = (userId: string, orgId: string | undefined | null): Who => ({ userId, orgId: orgId ?? null });

@ApiTags('Service credentials')
@Controller('service-credentials')
export class ServiceCredentialsController {
  constructor(private readonly service: ServiceCredentialsService) {}

  @Get()
  @ApiDataResponse(ServiceCredentialResponseDto, { isArray: true })
  @Auth({ permissions: ['connections:read'] })
  @ApiOperation({
    summary: 'The keys of outside services, and which tiers hold one',
    description: 'One entry per key the console can use (a web search provider\'s): for you, whether your own key, your organization\'s and the deployment\'s are stored and when, and which one your requests use now. **Never a key, nor any part of one.**',
  })
  list(@CurrentUser('id') userId: string, @CurrentOrg() orgId: string | undefined) {
    return this.service.list(who(userId, orgId));
  }

  @Put('admin/:service/:name')
  @HttpCode(204)
  @Auth({ permissions: ['system_settings:write'] })
  @ApiOperation({ summary: 'Set the deployment\'s key', description: 'Stores the deployment\'s key for this service, encrypted. Write-only. Audited (`service_credential.set`, tier `system`).' })
  @ApiResponse({ status: 204, description: 'Stored' })
  setSystem(@CurrentUser('id') userId: string, @Param() p: ServiceCredentialRefParamDto, @Body() body: SetServiceCredentialDto): Promise<void> {
    return this.service.set(p, 'system', who(userId, null), body.value);
  }

  @Delete('admin/:service/:name')
  @HttpCode(204)
  @Auth({ permissions: ['system_settings:write'] })
  @ApiOperation({ summary: 'Remove the deployment\'s key', description: 'Idempotent. Audited (`service_credential.removed`, tier `system`).' })
  @ApiResponse({ status: 204, description: 'Removed (or there was nothing to remove)' })
  removeSystem(@CurrentUser('id') userId: string, @Param() p: ServiceCredentialRefParamDto): Promise<void> {
    return this.service.remove(p, 'system', who(userId, null));
  }

  @Put('org/:service/:name')
  @HttpCode(204)
  @Auth({ permissions: [ORG_SERVICE_CREDENTIAL_PERMISSION] })
  @ApiOperation({ summary: 'Set your organization\'s key', description: 'Stores your active organization\'s key for this service, encrypted. Write-only. Needs `org_ai_config:write` in that organization. Audited with the organization\'s id.' })
  @ApiResponse({ status: 204, description: 'Stored' })
  setOrg(@CurrentUser('id') userId: string, @CurrentOrg() orgId: string | undefined, @Param() p: ServiceCredentialRefParamDto, @Body() body: SetServiceCredentialDto): Promise<void> {
    return this.service.set(p, 'organization', who(userId, orgId), body.value);
  }

  @Delete('org/:service/:name')
  @HttpCode(204)
  @Auth({ permissions: [ORG_SERVICE_CREDENTIAL_PERMISSION] })
  @ApiOperation({ summary: 'Remove your organization\'s key', description: 'Idempotent. Audited with the organization\'s id.' })
  @ApiResponse({ status: 204, description: 'Removed (or there was nothing to remove)' })
  removeOrg(@CurrentUser('id') userId: string, @CurrentOrg() orgId: string | undefined, @Param() p: ServiceCredentialRefParamDto): Promise<void> {
    return this.service.remove(p, 'organization', who(userId, orgId));
  }

  @Post(':service/:name/move')
  @HttpCode(200)
  @ApiDataResponse(MoveServiceCredentialResponseDto)
  @Auth({ permissions: ['connections:write'] })
  @ApiOperation({
    summary: 'Move your own key between the console and your secrets provider',
    description:
      'Moves your own key (E50.3) to `credential_store` (the console) or `secrets_provider` (your Vault or the built-in store, `secrets.provider`). It is read, written to the other side, and the old copy is removed only after the write is confirmed: a failed write leaves the key where it was. Into a remote Vault the console cannot write: add the key there as a "Service key" opened to the agent, then Move checks that the Vault answers with it and removes the console\'s copy. Out of a remote Vault the copy there stays (remove it in Vault). The value is never returned. Audited (`service_credential.moved`). Errors: `SERVICE_CREDENTIAL_NOT_SET`, `SERVICE_CREDENTIAL_NOT_IN_PROVIDER`, `SERVICE_CREDENTIAL_PROVIDER_UNAVAILABLE`.',
  })
  move(@CurrentUser('id') userId: string, @CurrentOrg() orgId: string | undefined, @Param() p: ServiceCredentialRefParamDto, @Body() body: MoveServiceCredentialDto) {
    return this.service.move(p, who(userId, orgId), body.to);
  }

  @Put(':service/:name')
  @HttpCode(204)
  @Auth({ permissions: ['connections:write'] })
  @ApiOperation({ summary: 'Set your own key', description: 'Stores your own key for this service, encrypted, where your keys are kept (`serviceCredentials`: the console by default, or the built-in store; a key kept in your remote Vault is changed in Vault: `SERVICE_CREDENTIAL_PROVIDER_READ_ONLY`). Your requests use it before your organization\'s or the deployment\'s. Write-only: it is never returned. Audited (`service_credential.set`, tier `user`).' })
  @ApiResponse({ status: 204, description: 'Stored' })
  setOwn(@CurrentUser('id') userId: string, @CurrentOrg() orgId: string | undefined, @Param() p: ServiceCredentialRefParamDto, @Body() body: SetServiceCredentialDto): Promise<void> {
    return this.service.set(p, 'user', who(userId, orgId), body.value);
  }

  @Delete(':service/:name')
  @HttpCode(204)
  @Auth({ permissions: ['connections:write'] })
  @ApiOperation({ summary: 'Remove your own key', description: 'Idempotent. Audited (`service_credential.removed`, tier `user`).' })
  @ApiResponse({ status: 204, description: 'Removed (or there was nothing to remove)' })
  removeOwn(@CurrentUser('id') userId: string, @CurrentOrg() orgId: string | undefined, @Param() p: ServiceCredentialRefParamDto): Promise<void> {
    return this.service.remove(p, 'user', who(userId, orgId));
  }
}
