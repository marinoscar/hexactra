import { Module, type OnModuleInit } from '@nestjs/common';

import { DiagnosticsRegistry } from '../../diagnostics/diagnostics.registry';
import { CapabilityProviderRegistry } from '../capability-provider.registry';
import { ConnectionAppDiagnostics } from '../connection-app-diagnostics.service';
import { ConnectionProviderRegistry } from '../connection-provider.registry';
import { ConnectionTokensService } from '../connection-tokens.service';
import { ConnectionsModule } from '../connections.module';
import { GraphClient } from './graph-client';
import { MicrosoftConnectionAdapter } from './microsoft.adapter';
import { MicrosoftCapabilityProvider } from './microsoft.provider';

/**
 * Microsoft for Connections (E39.4, #602): registers the sign-in adapter with `ConnectionProviderRegistry` and the mail, calendar
 * and documents implementation with `CapabilityProviderRegistry`. Mounted next to `ConnectionsModule` (app.module.ts); until it is,
 * Microsoft is listed as "not available on this deployment yet".
 */
@Module({ imports: [ConnectionsModule] })
export class MicrosoftConnectionsModule implements OnModuleInit {
  constructor(
    private readonly adapters: ConnectionProviderRegistry,
    private readonly capabilities: CapabilityProviderRegistry,
    private readonly tokens: ConnectionTokensService,
    private readonly diagnostics: DiagnosticsRegistry,
    private readonly appDiagnostics: ConnectionAppDiagnostics,
  ) {}

  onModuleInit(): void {
    this.adapters.register(new MicrosoftConnectionAdapter());
    // E50.11: the check of the deployment's app registration.
    this.diagnostics.register('provider_app', 'microsoft', this.appDiagnostics.diagnosable('microsoft'));
    // The access token comes from the token service (refreshed and rotated there); it is attached inside the Graph client only.
    this.capabilities.register(new MicrosoftCapabilityProvider(new GraphClient({ tokens: (ctx, opts) => this.tokens.getAccessToken(ctx.connectionId, ctx.userId, { forceRefresh: opts?.forceRefresh }) })));
  }
}
