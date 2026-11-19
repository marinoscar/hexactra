// Connections without a database, for unit tests of code that calls the capability hub (E39.3, #601). A test that needs the real
// rows (resolver, tokens, the controller) uses the db tier and `ConnectionCapabilities`; one that only needs "a connection with
// these switches" uses this.
import { randomUUID } from 'node:crypto';

import { CapabilityHub, type CapabilityConnection } from '../capability-hub';
import { CapabilityProviderRegistry } from '../capability-provider.registry';
import type { CapabilityLimits, ConnectionContext } from '../capabilities';
import { normalizeCapabilities, type Capability, type ConnectionProviderId } from '../connections.constants';
import { FakeCapabilityProvider } from './fake-capability-provider';

export interface InMemoryConnectionInput {
  id?: string;
  userId?: string;
  provider?: ConnectionProviderId;
  label?: string;
  accountEmail?: string;
  /** The switches that are on (a write brings its read). */
  capabilities: Capability[];
  /** What the provider granted (default: the switches). Give fewer to test PERMISSION_MISSING. */
  granted?: Capability[];
  status?: CapabilityConnection['status'];
}

export class InMemoryConnections {
  private readonly rows = new Map<string, CapabilityConnection>();
  readonly used: string[] = [];

  add(input: InMemoryConnectionInput): CapabilityConnection {
    const caps = normalizeCapabilities(input.capabilities);
    const row: CapabilityConnection = {
      id: input.id ?? randomUUID(),
      userId: input.userId ?? 'user-a',
      provider: input.provider ?? 'google',
      label: input.label ?? 'Work',
      accountEmail: input.accountEmail ?? 'person-a@example.test',
      capabilities: caps,
      granted: input.granted ? normalizeCapabilities(input.granted) : caps,
      status: input.status ?? 'active',
      statusReason: null,
    };
    this.rows.set(row.id, row);
    return row;
  }

  get(id: string): CapabilityConnection | undefined {
    return this.rows.get(id);
  }

  lookup = async (ctx: ConnectionContext): Promise<CapabilityConnection | null> => {
    const row = this.rows.get(ctx.connectionId);
    return row && row.userId === ctx.userId ? row : null;
  };
}

export interface TestCapabilities {
  hub: CapabilityHub;
  fake: FakeCapabilityProvider;
  connections: InMemoryConnections;
  registry: CapabilityProviderRegistry;
  /** The context for a connection row. */
  ctx(row: CapabilityConnection, signal?: AbortSignal): ConnectionContext;
}

/** A hub over in-memory connections and a fake provider (registered for `provider`). Add connections, then `hub.mail(ctx(row))`. */
export function createTestCapabilities(opts: { provider?: ConnectionProviderId; limits?: Partial<CapabilityLimits> } = {}): TestCapabilities {
  const fake = new FakeCapabilityProvider(opts.provider ?? 'google');
  const registry = new CapabilityProviderRegistry();
  registry.register(fake);
  const connections = new InMemoryConnections();
  const hub = new CapabilityHub({ lookup: connections.lookup, providers: registry, markUsed: async (_u, id) => void connections.used.push(id), limits: opts.limits });
  return { hub, fake, connections, registry, ctx: (row, signal) => ({ connectionId: row.id, userId: row.userId, signal }) };
}
