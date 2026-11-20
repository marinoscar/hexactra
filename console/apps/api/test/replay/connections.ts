// The owner's accounts and MCP servers in a scenario (E41.1, #698). A scenario that declares `connections` runs the REAL connection tools,
// the real MCP tools and the real connection gate against doubles: the capability hub over in-memory connections and the fake provider
// (`src/connections/testing`), and an in-memory MCP run service. What the doubles received (mail sent, rows appended, events and files
// created, MCP calls) is kept for `expect`. Invented data only (`Person A`, `*.example.test`).
import { CapabilityHub } from '../../src/connections/capability-hub';
import { CapabilityProviderRegistry } from '../../src/connections/capability-provider.registry';
import type { Capability, ConnectionProviderId } from '../../src/connections/connections.constants';
import type { McpRunTool } from '../../src/connections/mcp/mcp-run.service';
import { FakeCapabilityProvider, InMemoryConnections } from '../../src/connections/testing';
import type { FakeAccount } from '../../src/connections/testing/fake-capability-provider';
import type { SnapshotConnection } from '../../src/policies/policy-snapshot';
import type { HostDeps } from '../../src/runner/host/deps';
import type { ScenarioConnection } from './scenario.schema';

/** One message the fake mailbox sent. */
export interface SentMail {
  /** The connection's `ref` and label. */
  ref: string;
  label: string;
  to: string[];
  subject: string;
  body: string;
  attachments: string[];
}

export interface McpCall {
  ref: string;
  tool: string;
  args: Record<string, unknown>;
}

export interface ScenarioAccounts {
  /** The run's connections, as the policy snapshot lists them. */
  list: SnapshotConnection[];
  /** The deps the connection tools read: the hub, the MCP service, the connection rows. */
  deps: Pick<HostDeps, 'connections' | 'mcp'> & { prisma: unknown };
  /** What the doubles received. */
  sent(): SentMail[];
  /** Every write the providers recorded (`documents.appendRows`, `calendar.createEvent`, ...), with the connection's ref. */
  writes(): { ref: string; method: string }[];
  mcpCalls: McpCall[];
}

const USER = 'user-1';
const idOf = (ref: string): string => `conn-${ref}`;

/** Fills a fake account from the scenario's seeded data. */
function seed(account: FakeAccount, c: ScenarioConnection): void {
  for (const m of c.mail) {
    account.addMessage({
      id: m.id,
      from: m.from,
      to: m.to,
      subject: m.subject,
      text: m.body,
      date: m.date,
      attachments: m.attachments.map((name, i) => ({ id: `${m.id}-att-${i + 1}`, filename: name, contentType: name.endsWith('.pdf') ? 'application/pdf' : 'application/octet-stream', bytes: Buffer.from(`invented content of ${name}`) })),
    });
  }
  for (const e of c.events) account.addEvent({ id: e.id, title: e.title, start: e.start, end: e.end, location: e.location ?? null });
  for (const f of c.files) {
    const kind = f.kind === 'pdf' ? 'other' : f.kind;
    const mimeType = f.kind === 'spreadsheet' ? 'application/vnd.google-apps.spreadsheet' : f.kind === 'document' ? 'application/vnd.google-apps.document' : f.kind === 'pdf' ? 'application/pdf' : 'application/octet-stream';
    account.addFile({ id: f.id, name: f.name, kind, mimeType, size: f.text?.length ?? null, modifiedAt: f.modifiedAt ?? '2026-11-01T09:00:00Z' });
    if (f.kind === 'document' && f.text !== undefined) account.docs.set(f.id, f.text);
    if (f.kind === 'spreadsheet') account.sheets.set(f.id, new Map([[f.sheet ?? 'Sheet1', (f.rows ?? []).map((r) => [...r])]]));
  }
}

/** A stable stand-in for the hash of a stored MCP tool: the run registers it, the call checks it. */
const hashOf = (ref: string, tool: string): string => `fake-${ref}-${tool}`;

/** The doubles of a scenario's connections. Null when it declares none. */
export function scenarioAccounts(connections: readonly ScenarioConnection[]): ScenarioAccounts | null {
  if (connections.length === 0) return null;
  const registry = new CapabilityProviderRegistry();
  const fakes = new Map<ConnectionProviderId, FakeCapabilityProvider>();
  for (const p of ['google', 'microsoft'] as const) {
    const f = new FakeCapabilityProvider(p);
    fakes.set(p, f);
    registry.register(f);
  }
  const rows = new InMemoryConnections();
  const hub = new CapabilityHub({ lookup: rows.lookup, providers: registry, markUsed: async () => undefined });
  const byId = new Map(connections.map((c) => [idOf(c.ref), c]));
  for (const c of connections) {
    if (c.provider === 'mcp') continue;
    rows.add({ id: idOf(c.ref), userId: USER, provider: c.provider, label: c.label, accountEmail: c.email ?? `${c.ref}@example.test`, capabilities: c.capabilities as Capability[] });
    seed(fakes.get(c.provider)!.account(idOf(c.ref)), c);
  }

  // The rows `liveConnections` reads (support.ts): only `connection.findMany`, scoped to the run's owner.
  const prisma = {
    connection: {
      findMany: async (q: { where: { userId: string; id: { in: string[] } } }) =>
        q.where.id.in
          .map((id) => byId.get(id))
          .filter((c): c is ScenarioConnection => Boolean(c) && q.where.userId === USER)
          .map((c) => ({ id: idOf(c.ref), label: c.label, provider: c.provider, accountEmail: c.email ?? `${c.ref}@example.test`, capabilities: c.provider === 'mcp' ? [] : c.capabilities, defaultFor: c.defaultFor, status: 'active' })),
    },
    // No artifact of an earlier step is stored in a scenario (E41.4 adds the previous job's).
    runStep: { findFirst: async () => null },
  };

  const mcpCalls: McpCall[] = [];
  const toolOf = (connectionId: string, name: string) => byId.get(connectionId)?.tools.find((t) => t.name === name);
  const mcp: NonNullable<HostDeps['mcp']> = {
    toolsFor: async (_userId, selections) =>
      selections.flatMap((s) => {
        const c = byId.get(s.connectionId);
        if (!c || c.provider !== 'mcp') return [];
        return [...c.tools]
          .sort((a, b) => a.name.localeCompare(b.name))
          .filter((t) => s.access === 'read_write' || t.effect === 'read')
          .map((t): McpRunTool => ({ connectionId: idOf(c.ref), connectionLabel: c.label, name: t.name, title: null, description: t.description, inputSchema: t.inputSchema, hash: hashOf(c.ref, t.name), mode: t.effect, serverInstructions: c.instructions ?? null }));
      }),
    check: async (_userId, connectionId, name, expect) => {
      const t = toolOf(connectionId, name);
      if (!t || hashOf(byId.get(connectionId)!.ref, name) !== expect.hash) return { ok: false, text: 'This tool was switched off or changed since the run started. It was not called.' };
      return { ok: true, row: {} as never, tool: {} as never };
    },
    exactSecrets: async () => [],
    call: async (_userId, connectionId, name, args) => {
      const t = toolOf(connectionId, name);
      if (!t) return { kind: 'refused', text: 'This tool was switched off or changed since the run started. It was not called.' };
      mcpCalls.push({ ref: byId.get(connectionId)!.ref, tool: name, args });
      return { kind: 'ok', text: t.result, isError: false, truncated: false, dropped: '', redacted: false };
    },
  };

  const accounts = (): [ScenarioConnection, FakeAccount][] => connections.filter((c) => c.provider !== 'mcp').map((c) => [c, fakes.get(c.provider as ConnectionProviderId)!.account(idOf(c.ref))]);
  return {
    list: connections.map((c) => ({ connectionId: idOf(c.ref), access: c.access, label: c.label, provider: c.provider, capabilities: c.provider === 'mcp' ? [] : [...c.capabilities] })),
    deps: { connections: hub, mcp, prisma },
    sent: () =>
      accounts().flatMap(([c, a]) =>
        a.sent.map((m) => ({
          ref: c.ref,
          label: c.label,
          to: [...(m.to ?? []), ...(m.cc ?? []), ...(m.bcc ?? [])].map((x) => x.address.toLowerCase()),
          subject: m.subject ?? '',
          body: m.text ?? '',
          attachments: (m.attachments ?? []).map((x) => x.filename),
        })),
      ),
    writes: () => accounts().flatMap(([c, a]) => a.writes.map((w) => ({ ref: c.ref, method: w.method }))),
    mcpCalls,
  };
}
