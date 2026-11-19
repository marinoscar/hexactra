import { Module } from '@nestjs/common';
import { CredentialsModule, UserCredentialsModule } from '@marinoscar/platform-api/credentials';

import { CapabilityProviderRegistry } from './capability-provider.registry';
import { ConnectionApps } from './connection-apps.service';
import { ConnectionCapabilities } from './connection-capabilities.service';
import { ConnectionFlowService } from './connection-flow.service';
import { ConnectionProviderRegistry } from './connection-provider.registry';
import { ConnectionResolverService } from './connection-resolver.service';
import { ConnectionTokenStore } from './connection-token.store';
import { ConnectionTokensService } from './connection-tokens.service';
import { ConnectionUsageRegistry } from './connection-usage.registry';
import { ConnectionsAdminController } from './connections-admin.controller';
import { ConnectionsController } from './connections.controller';
import { ConnectionEvents } from './connections.events';
import { ConnectionsHealth, ConnectionsHealthHandler, ConnectionsHealthTask } from './connections.jobs';
import { ConnectionsService } from './connections.service';

/**
 * Connections (E39.2, #599): the owner's accounts at Google and Microsoft, several per service, each with a label and its own
 * switches for Mail, Calendar and Documents. Tokens are encrypted in the credential store, refreshed in the background and
 * never leave the server. Mounted only with the credentials and notifications slices (app.module.ts).
 *
 * What the next issues use: `ConnectionProviderRegistry` (E39.3 and E39.4 register their adapters), `ConnectionResolverService`
 * (`resolveConnection`), `ConnectionTokensService` (`getAccessToken`), `ConnectionUsageRegistry` (deliveries, tools and triggers
 * register what references a connection), `ConnectionCapabilities` (`mail`, `calendar`, `documents` of one connection: E39.3).
 */
@Module({
  imports: [CredentialsModule, UserCredentialsModule],
  controllers: [ConnectionsController, ConnectionsAdminController],
  providers: [
    ConnectionProviderRegistry,
    CapabilityProviderRegistry,
    ConnectionUsageRegistry,
    ConnectionEvents,
    ConnectionTokenStore,
    ConnectionApps,
    ConnectionTokensService,
    ConnectionFlowService,
    ConnectionResolverService,
    ConnectionsService,
    ConnectionCapabilities,
    ConnectionsHealth,
    ConnectionsHealthHandler,
    ConnectionsHealthTask,
  ],
  exports: [ConnectionProviderRegistry, CapabilityProviderRegistry, ConnectionCapabilities, ConnectionUsageRegistry, ConnectionResolverService, ConnectionTokensService, ConnectionsService, ConnectionApps],
})
export class ConnectionsModule {}
