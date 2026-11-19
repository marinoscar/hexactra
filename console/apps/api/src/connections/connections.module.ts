import { Module, type OnModuleInit } from '@nestjs/common';
import { CredentialsModule, UserCredentialsModule } from '@marinoscar/platform-api/credentials';

import { PrismaService } from '../prisma/prisma.service';
import { agentConnectionUsage } from './agent-connections';
import { CapabilityProviderRegistry } from './capability-provider.registry';
import { ConnectionApps } from './connection-apps.service';
import { ConnectionCapabilities } from './connection-capabilities.service';
import { ConnectionFlowService } from './connection-flow.service';
import { ConnectionProviderRegistry } from './connection-provider.registry';
import { ConnectionResolverService } from './connection-resolver.service';
import { ConnectionTokenStore } from './connection-token.store';
import { ConnectionTokensService } from './connection-tokens.service';
import { ConnectionUsageRegistry } from './connection-usage.registry';
import { ConnectionActivityService } from './connection-activity.service';
import { ConnectionFilesController } from './connection-files.controller';
import { ConnectionFilesService } from './connection-files.service';
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
  controllers: [ConnectionsController, ConnectionsAdminController, ConnectionFilesController],
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
    ConnectionFilesService,
    ConnectionActivityService,
    ConnectionCapabilities,
    ConnectionsHealth,
    ConnectionsHealthHandler,
    ConnectionsHealthTask,
  ],
  exports: [ConnectionProviderRegistry, CapabilityProviderRegistry, ConnectionCapabilities, ConnectionUsageRegistry, ConnectionResolverService, ConnectionTokensService, ConnectionsService, ConnectionApps],
})
export class ConnectionsModule implements OnModuleInit {
  constructor(
    private readonly usage: ConnectionUsageRegistry,
    private readonly prisma: PrismaService,
  ) {}

  /** The tasks and chats that use a connection (E39.7) show in the Disconnect dialog, and are cleared when it is removed. */
  onModuleInit(): void {
    for (const source of agentConnectionUsage(this.prisma)) this.usage.register(source);
  }
}
