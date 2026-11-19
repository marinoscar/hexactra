import { Injectable } from '@nestjs/common';

import { PrismaService } from '../prisma/prisma.service';
import { CapabilityHub, type CapabilityConnection } from './capability-hub';
import { CapabilityProviderRegistry } from './capability-provider.registry';
import { capabilitiesOf } from './connection-view';
import { ConnectionProviderRegistry } from './connection-provider.registry';
import { isProviderId } from './connections.constants';
import { ConnectionsService } from './connections.service';

/**
 * What a service injects to use a connection (E39.3, #601): `capabilities.mail({ connectionId, userId, signal })` and the same
 * for `calendar` and `documents`. The provider is resolved from the connection, every call is gated and validated by the hub
 * (capability-hub.ts), and nothing returned is provider-specific. Pick the account first with `ConnectionResolverService`.
 */
@Injectable()
export class ConnectionCapabilities extends CapabilityHub {
  constructor(prisma: PrismaService, providers: CapabilityProviderRegistry, adapters: ConnectionProviderRegistry, connections: ConnectionsService) {
    super({
      providers,
      markUsed: (userId, id) => connections.markUsed(userId, id),
      lookup: async (ctx): Promise<CapabilityConnection | null> => {
        const row = await prisma.connection.findFirst({ where: { id: ctx.connectionId, userId: ctx.userId } });
        if (!row || !isProviderId(row.provider)) return null;
        const adapter = adapters.get(row.provider);
        const on = capabilitiesOf(row);
        return {
          id: row.id,
          userId: row.userId,
          provider: row.provider,
          label: row.label,
          accountEmail: row.accountEmail,
          accountId: row.accountId,
          capabilities: on,
          // With no adapter installed the grants cannot be read; the switches stand in (the same rule as ConnectionsService.update).
          granted: adapter ? adapter.capabilitiesGranted(row.grantedScopes) : on,
          status: row.status,
          statusReason: row.statusReason,
        };
      },
    });
  }
}
