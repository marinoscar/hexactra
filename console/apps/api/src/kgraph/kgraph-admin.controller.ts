import { Body, Controller, Get, Put } from '@nestjs/common';
import { ApiDataResponse } from '@marinoscar/platform-api/core';
import { Auth, CurrentUser } from '@marinoscar/platform-api/identity';
import { ApiOperation, ApiTags } from '@nestjs/swagger';

import { KgraphAdminService } from './kgraph-admin.service';
import { AdminSettingsResponseDto, PutAdminSettingsDto } from './kgraph-read.schemas';

/** The deployment switch and its numbers (E46.19, #793): the system settings' `kgraph` namespace, for an administrator. */
@ApiTags('Knowledge Graph')
@Controller('admin/kgraph')
export class KgraphAdminController {
  constructor(private readonly admin: KgraphAdminService) {}

  @Get('settings')
  @ApiDataResponse(AdminSettingsResponseDto)
  @Auth({ permissions: ['kgraph:admin'] })
  @ApiOperation({ summary: 'The Knowledge Graph deployment settings', description: 'Whether the Knowledge Graph is allowed on this deployment, and its audit, suspension, retention and pacing rules (the system setting `kgraph`).' })
  get() {
    return this.admin.get();
  }

  @Put('settings')
  @ApiDataResponse(AdminSettingsResponseDto)
  @Auth({ permissions: ['kgraph:admin'] })
  @ApiOperation({ summary: 'Change the Knowledge Graph deployment settings', description: 'The fields sent change; the others keep their value. Turning it off keeps everything learned. Answers whatever the switches are.' })
  put(@CurrentUser('id') userId: string, @Body() body: PutAdminSettingsDto) {
    return this.admin.put(userId, body);
  }
}
