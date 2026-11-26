// `/api/web-search/admin` (E50.5, #975): the deployment's web search settings and usage. The deployment's key is set through the
// service credential routes (`PUT /api/service-credentials/admin/web_search/{provider}`), never here.
import { Body, Controller, Get, Put, Query } from '@nestjs/common';
import { ApiDataResponse } from '@marinoscar/platform-api/core';
import { Auth, CurrentUser } from '@marinoscar/platform-api/identity';
import { ApiOperation, ApiTags } from '@nestjs/swagger';

import { UpdateWebSearchAdminDto, WebSearchAdminSettingsDto, WebSearchUsageQueryDto, WebSearchUsageRowDto } from './web-search.schemas';
import { WebSearchAdminService } from './web-search-admin.service';

@ApiTags('Web search')
@Controller('web-search/admin')
export class WebSearchAdminController {
  constructor(private readonly admin: WebSearchAdminService) {}

  @Get()
  @ApiDataResponse(WebSearchAdminSettingsDto)
  @Auth({ permissions: ['system_settings:read'] })
  @ApiOperation({
    summary: 'The web search settings of the deployment',
    description: 'The deployment switch, the per-provider switch and cost estimate override, the order of providers, whether everyone may use the deployment key, whether users may use their own key, and the limits per run and per user per day (`null`: unlimited). Never a key.',
  })
  get() {
    return this.admin.view();
  }

  @Put()
  @ApiDataResponse(WebSearchAdminSettingsDto)
  @Auth({ permissions: ['system_settings:write'] })
  @ApiOperation({ summary: 'Change the web search settings', description: 'A field left out is kept; providers merge per id and per field; `null` on a limit makes it unlimited. Audited (`web_search.settings_saved`, the names of the fields changed).' })
  put(@CurrentUser('id') adminId: string, @Body() body: UpdateWebSearchAdminDto) {
    return this.admin.save(adminId, body);
  }

  @Get('usage')
  @ApiDataResponse(WebSearchUsageRowDto, { isArray: true })
  @Auth({ permissions: ['system_settings:read'] })
  @ApiOperation({ summary: 'Web search usage of the deployment', description: 'Calls, failures and ESTIMATED cost by UTC day and provider, newest first. No user and no query.' })
  usage(@Query() q: WebSearchUsageQueryDto) {
    return this.admin.usageTotals(q.days);
  }
}
