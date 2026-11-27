import { Module } from '@nestjs/common';
import { CredentialsModule } from '@marinoscar/platform-api/credentials';

import { OAuthClientModule } from '../oauth-client/oauth-client.module';
import { ServiceCredentialsModule } from '../service-credentials/service-credentials.module';
import { BraveSearchProvider } from './providers/brave.provider';
import { ExaSearchProvider } from './providers/exa.provider';
import { OpenAiSearchProvider } from './providers/openai.provider';
import { SearxngSearchProvider } from './providers/searxng.provider';
import { TavilySearchProvider } from './providers/tavily.provider';
import { WebFetchDiagnosticBinding } from './fetch/web-fetch.diagnostic';
import { WebFetchService } from './fetch/web-fetch.service';
import { SearchProviderRegistry } from './search-provider';
import { WebSearchAdminController } from './web-search-admin.controller';
import { WebSearchAdminService } from './web-search-admin.service';
import { WebSearchController } from './web-search.controller';
import { WebSearchDiagnosticsController } from './web-search-diagnostics.controller';
import { WEB_FETCH_DIAGNOSTIC_HOOK, WebSearchDiagnostics } from './web-search-diagnostics.service';
import { WebSearchEgressContributor, WebSearchProviderCheck } from './web-search.doctor';
import './web-search.errors';
import './web-search.metrics';
import { WebSearchService } from './web-search.service';
import { WebSearchUsage } from './web-search.usage';

/**
 * Web search in the host (E50.5, #975): the registry of search providers, Brave Search, Tavily, Exa and SearXNG (E50.8, #978), OpenAI web search through the AI service (E50.9, #979; one
 * file each under `providers/`, docs/web-search.md "How to add a search provider"), the settings, the tiered keys (through the
 * service credentials port), the limits and the usage count, and the routes under `/api/web-search`. Mounted with the credentials
 * slice (app.module.ts), like the service credentials it reads.
 *
 * What the next issues use: `WebSearchService.forUser(userId, orgId)` (E50.7 binds the agent's `web_search` tool to it: one port per
 * run), `WebFetchService.forRun({ userId, sites })` (E50.7 binds `web_fetch` to it: one port per run; E50.6, #976) and `SearchProviderRegistry` (E50.8 and E50.9 add adapters, each registering itself from its `onModuleInit`, with a `diagnose`
 * built from `providerStages` in `web-search-diagnostics.ts`). Diagnostics (E50.13): `WebSearchDiagnostics`, the routes
 * `/api/web-search/diagnose|diagnostics` and their admin twins, the Doctor check `web_search.provider`; the `fetch` stage reads
 * through `WebFetchService` (`WebFetchDiagnosticBinding`, bound to `WEB_FETCH_DIAGNOSTIC_HOOK`).
 */
@Module({
  imports: [ServiceCredentialsModule, OAuthClientModule, CredentialsModule],
  controllers: [WebSearchController, WebSearchAdminController, WebSearchDiagnosticsController],
  providers: [
    SearchProviderRegistry,
    BraveSearchProvider,
    TavilySearchProvider,
    ExaSearchProvider,
    SearxngSearchProvider,
    OpenAiSearchProvider,
    WebSearchUsage,
    WebSearchService,
    WebSearchAdminService,
    WebSearchEgressContributor,
    WebFetchService,
    WebFetchDiagnosticBinding,
    { provide: WEB_FETCH_DIAGNOSTIC_HOOK, useExisting: WebFetchDiagnosticBinding },
    WebSearchDiagnostics,
    WebSearchProviderCheck,
  ],
  exports: [SearchProviderRegistry, WebSearchService, WebFetchService, WebSearchDiagnostics],
})
export class WebSearchModule {}
