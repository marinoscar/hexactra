import { Injectable } from '@nestjs/common';

import type { ConnectionProviderId } from './connections.constants';
import type { ConnectionProviderAdapter } from './provider';

/**
 * The adapters the deployment has. The real ones register themselves from their own module (`onModuleInit`) in E39.3 and
 * E39.4; a test registers a fake. With no adapter for a provider, it is listed as unavailable and cannot be connected.
 */
@Injectable()
export class ConnectionProviderRegistry {
  private readonly adapters = new Map<ConnectionProviderId, ConnectionProviderAdapter>();

  register(adapter: ConnectionProviderAdapter): void {
    this.adapters.set(adapter.id, adapter);
  }

  /** Test helper: removes an adapter. */
  unregister(id: ConnectionProviderId): void {
    this.adapters.delete(id);
  }

  get(id: ConnectionProviderId): ConnectionProviderAdapter | undefined {
    return this.adapters.get(id);
  }

  has(id: ConnectionProviderId): boolean {
    return this.adapters.has(id);
  }

  list(): ConnectionProviderAdapter[] {
    return [...this.adapters.values()];
  }
}
