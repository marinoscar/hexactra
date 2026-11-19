import { Module, type OnModuleInit } from '@nestjs/common';
import { AppMetricsService } from '@marinoscar/platform-api/host';

import { OAuthClientModule, OAuthClientService, OutboundHttp } from '../../oauth-client';
import { CapabilityProviderRegistry } from '../capability-provider.registry';
import { ConnectionProviderRegistry } from '../connection-provider.registry';
import { ConnectionTokensService } from '../connection-tokens.service';
import { ConnectionsModule } from '../connections.module';
import { GoogleConnectionAdapter } from './google.adapter';
import { GoogleCapabilityProvider } from './google.provider';
import { GoogleHttp } from './google-http';

/**
 * The Google provider (E39.3, #601): installs the connection adapter (sign-in, refresh, revoke, test) and the capability provider
 * (Gmail, Calendar, Drive, Docs, Sheets) for `google`. Until the administrator saves a client id and secret the provider is
 * listed as "not configured"; installing the code does not switch it on.
 */
@Module({
  imports: [ConnectionsModule, OAuthClientModule],
  providers: [
    { provide: GoogleHttp, useFactory: (http: OutboundHttp, metrics?: AppMetricsService) => new GoogleHttp(http, metrics), inject: [OutboundHttp, { token: AppMetricsService, optional: true }] },
    { provide: GoogleConnectionAdapter, useFactory: (oauth: OAuthClientService, http: OutboundHttp) => new GoogleConnectionAdapter(oauth, http), inject: [OAuthClientService, OutboundHttp] },
    { provide: GoogleCapabilityProvider, useFactory: (http: GoogleHttp, tokens: ConnectionTokensService) => new GoogleCapabilityProvider(http, tokens), inject: [GoogleHttp, ConnectionTokensService] },
  ],
  exports: [GoogleConnectionAdapter, GoogleCapabilityProvider, GoogleHttp],
})
export class GoogleConnectionsModule implements OnModuleInit {
  constructor(
    private readonly adapters: ConnectionProviderRegistry,
    private readonly capabilities: CapabilityProviderRegistry,
    private readonly adapter: GoogleConnectionAdapter,
    private readonly provider: GoogleCapabilityProvider,
  ) {}

  onModuleInit(): void {
    this.adapters.register(this.adapter);
    this.capabilities.register(this.provider);
  }
}
