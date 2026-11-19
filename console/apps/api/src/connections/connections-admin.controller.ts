// `/api/connections/admin/apps` (E39.2, #599): the deployment's apps at Google and Microsoft (bring your own app). The
// administrator's page. It reads and writes the app credentials ONLY: no route here, and no permission it checks, reaches a user's
// connections. The client secret is write-only.
import { Body, Controller, Delete, Get, Param, Put } from '@nestjs/common';
import { ApiDataResponse } from '@marinoscar/platform-api/core';
import { Auth, CurrentUser } from '@marinoscar/platform-api/identity';
import { ApiOperation, ApiTags } from '@nestjs/swagger';

import { ConnectionApps } from './connection-apps.service';
import { AdminProviderResponseDto, ProviderParamDto, SaveConnectionAppDto } from './connections.schemas';

@ApiTags('Connections')
@Controller('connections/admin/apps')
export class ConnectionsAdminController {
  constructor(private readonly apps: ConnectionApps) {}

  @Get()
  @ApiDataResponse(AdminProviderResponseDto, { isArray: true })
  @Auth({ permissions: ['system_settings:read'] })
  @ApiOperation({ summary: 'The deployment\'s apps at Google and Microsoft', description: 'Per provider: the switch, the client id, whether a client secret is stored (never the secret), the redirect URI to register, the setup checklist and the kinds of account that work. Never a user\'s connection.' })
  list() {
    return this.apps.adminView();
  }

  @Put(':provider')
  @ApiDataResponse(AdminProviderResponseDto, { isArray: true })
  @Auth({ permissions: ['system_settings:write'] })
  @ApiOperation({ summary: 'Set a provider\'s app', description: 'The client id, the write-only client secret (omit it to keep the stored one), the Microsoft tenant and the switch. Owners can connect a provider only while it is on and fully set. Existing connections keep refreshing when it is switched off.' })
  save(@CurrentUser('id') adminId: string, @Param() p: ProviderParamDto, @Body() body: SaveConnectionAppDto) {
    return this.apps.saveApp(adminId, p.provider, body);
  }

  @Delete(':provider')
  @ApiDataResponse(AdminProviderResponseDto, { isArray: true })
  @Auth({ permissions: ['system_settings:write'] })
  @ApiOperation({ summary: 'Remove a provider\'s app', description: 'Removes the client id and secret and switches the provider off. Existing connections stay, but cannot refresh until an app is set again.' })
  remove(@CurrentUser('id') adminId: string, @Param() p: ProviderParamDto) {
    return this.apps.removeApp(adminId, p.provider);
  }
}
