import { Module } from '@nestjs/common';

import { OAuthClientModule } from '../oauth-client/oauth-client.module';
import { ServiceCredentialsModule } from '../service-credentials/service-credentials.module';
import { BraveSearchProvider } from './providers/brave.provider';
import { SearchProviderRegistry } from './search-provider';
import { WebSearchAdminController } from './web-search-admin.controller';
import { WebSearchAdminService } from './web-search-admin.service';
import { WebSearchController } from './web-search.controller';
import { WebSearchEgressContributor } from './web-search.doctor';
import './web-search.errors';
import './web-search.metrics';
import { WebSearchService } from './web-search.service';
import { WebSearchUsage } from './web-search.usage';

/**
 * Web search in the host (E50.5, #975): the registry of search providers, Brave Search, the settings, the tiered keys (through the
 * service credentials port), the limits and the usage count, and the routes under `/api/web-search`. Mounted with the credentials
 * slice (app.module.ts), like the service credentials it reads.
 *
 * What the next issues use: `WebSearchService.forUser(userId, orgId)` (E50.7 binds the agent's `web_search` tool to it: one port per
 * run) and `SearchProviderRegistry` (E50.8 and E50.9 add adapters, each registering itself from its `onModuleInit`).
 */
@Module({
  imports: [ServiceCredentialsModule, OAuthClientModule],
  controllers: [WebSearchController, WebSearchAdminController],
  providers: [SearchProviderRegistry, BraveSearchProvider, WebSearchUsage, WebSearchService, WebSearchAdminService, WebSearchEgressContributor],
  exports: [SearchProviderRegistry, WebSearchService],
})
export class WebSearchModule {}
