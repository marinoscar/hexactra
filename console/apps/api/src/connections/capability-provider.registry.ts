import { Injectable } from '@nestjs/common';

import type { CapabilityProvider } from './capabilities';
import type { ConnectionProviderId } from './connections.constants';

/**
 * The capability implementations the deployment has, one per provider (E39.3, #601). The Google one registers itself from its
 * module (`onModuleInit`), the Microsoft one from E39.4; a test registers a fake (`connections/testing/`). The services that
 * use a connection never read this directly: they ask `ConnectionCapabilities`, which resolves the provider from the connection.
 */
@Injectable()
export class CapabilityProviderRegistry {
  private readonly providers = new Map<ConnectionProviderId, CapabilityProvider>();

  register(provider: CapabilityProvider): void {
    this.providers.set(provider.provider, provider);
  }

  unregister(id: ConnectionProviderId): void {
    this.providers.delete(id);
  }

  get(id: ConnectionProviderId): CapabilityProvider | undefined {
    return this.providers.get(id);
  }

  has(id: ConnectionProviderId): boolean {
    return this.providers.has(id);
  }
}
