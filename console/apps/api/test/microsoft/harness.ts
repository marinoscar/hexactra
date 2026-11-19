// The harness of the Microsoft provider's tests (E39.4, #602): a fake Graph, a hub over in-memory connections and the real adapters.
import { CapabilityHub } from '../../src/connections/capability-hub';
import { CapabilityProviderRegistry } from '../../src/connections/capability-provider.registry';
import type { CapabilityContext, ConnectionContext } from '../../src/connections/capabilities';
import { normalizeCapabilities, type Capability } from '../../src/connections/connections.constants';
import { InMemoryConnections } from '../../src/connections/testing/in-memory-connections';
import { GraphClient, type GraphCallRecord, type GraphTelemetry } from '../../src/connections/microsoft/graph-client';
import { MicrosoftConnectionAdapter } from '../../src/connections/microsoft/microsoft.adapter';
import { MicrosoftCapabilityProvider } from '../../src/connections/microsoft/microsoft.provider';
import { microsoftAccountId } from '../../src/connections/microsoft/microsoft.constants';
import { FakeGraph, type FakeAccount, type FakeAccountInit } from '../../src/connections/microsoft/testing/fake-graph';

export const ALL_CAPS: Capability[] = ['mail_read', 'mail_send', 'mail_modify', 'calendar_read', 'calendar_write', 'docs_read', 'docs_write'];

export interface Harness {
  fake: FakeGraph;
  hub: CapabilityHub;
  provider: MicrosoftCapabilityProvider;
  adapter: MicrosoftConnectionAdapter;
  connections: InMemoryConnections;
  telemetry: GraphCallRecord[];
  sleeps: number[];
  /** A connection for a fake account, with its own token. */
  connect(account: FakeAccount, caps?: Capability[], label?: string): { ctx: (signal?: AbortSignal) => ConnectionContext; id: string; account: FakeAccount };
  addAccount(init: FakeAccountInit): FakeAccount;
}

export function createHarness(opts: { now?: () => number } = {}): Harness {
  const fake = new FakeGraph();
  const telemetry: GraphCallRecord[] = [];
  const sleeps: number[] = [];
  const tokenOf = new Map<string, FakeAccount>();
  const sink: GraphTelemetry = { record: (c) => void telemetry.push(c) };
  const graph = new GraphClient({
    fetch: (...a) => fake.fetch(...a),
    telemetry: sink,
    sleep: async (ms) => void sleeps.push(ms),
    random: () => 0.5,
    tokens: async (ctx: ConnectionContext, o) => {
      const account = tokenOf.get(ctx.connectionId);
      if (!account) throw new Error('no account for connection');
      // A refresh always gives a token that works; a plain call reuses the current one when it still does.
      return o?.forceRefresh ? set(ctx.connectionId, fake.issue(account)) : (current.get(ctx.connectionId) ?? set(ctx.connectionId, fake.issue(account)));
    },
  });
  const current = new Map<string, string>();
  const set = (id: string, t: string): string => (current.set(id, t), t);
  const provider = new MicrosoftCapabilityProvider(graph, opts.now);
  const registry = new CapabilityProviderRegistry();
  registry.register(provider);
  const connections = new InMemoryConnections();
  const hub = new CapabilityHub({ lookup: connections.lookup, providers: registry, markUsed: async () => undefined });
  return {
    fake,
    hub,
    provider,
    adapter: new MicrosoftConnectionAdapter({ fetch: (...a) => fake.fetch(...a) }),
    connections,
    telemetry,
    sleeps,
    addAccount: (init) => fake.addAccount(init),
    connect(account, caps = ALL_CAPS, label = account.email) {
      const row = connections.add({ provider: 'microsoft', label, accountEmail: account.email, accountId: microsoftAccountId(account.tenantId, account.objectId), capabilities: normalizeCapabilities(caps) });
      tokenOf.set(row.id, account);
      return { id: row.id, account, ctx: (signal) => ({ connectionId: row.id, userId: row.userId, signal }) };
    },
  };
}

export type { CapabilityContext };
