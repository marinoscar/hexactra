// The owner's connections (E39.2, #599): list, read, rename, change what an account may do, make it the default, pause,
// resume, test and remove. Every query is the caller's own (`forUser`, and an explicit `userId` in every `where`): another
// user's id is a 404 like a missing one. Nothing here returns a token, a scope string or a provider message.
import { sanitizeInstructions } from './mcp/mcp-text';
import { Injectable, Logger } from '@nestjs/common';
import type { Connection } from '@prisma/client';

import { PrismaService } from '../prisma/prisma.service';
import {
  CAPABILITY_GROUPS,
  MAX_LABEL_LENGTH,
  addedCapabilities,
  groupsOf,
  isProviderId,
  normalizeCapabilities,
  type Capability,
  type CapabilityGroup,
} from './connections.constants';
import { ConnectionError, notFound } from './connections.errors';
import { CONNECTION_AUDIT, ConnectionEvents } from './connections.events';
import { ConnectionApps, type ProviderAvailability } from './connection-apps.service';
import { ConnectionFlowService, type StartResult } from './connection-flow.service';
import { ConnectionProviderRegistry } from './connection-provider.registry';
import { ConnectionTokenStore } from './connection-token.store';
import { ConnectionTokensService } from './connection-tokens.service';
import { ConnectionUsageRegistry, type ConnectionUsage } from './connection-usage.registry';
import { capabilitiesOf, toView, type ConnectionView } from './connection-view';
import { McpCatalogService } from './mcp/mcp-catalog.service';
import { McpConnectionsService } from './mcp/mcp-connections.service';
import { readMcpConfig } from './mcp/mcp-config';
import { DiagnosticsHistory } from '../diagnostics/diagnostics-history.service';

export interface UpdateInput {
  label?: string;
  capabilities?: readonly Capability[];
  defaultFor?: readonly CapabilityGroup[];
  returnTo?: string;
}

export interface UpdateResult {
  connection: ConnectionView;
  /** Set when a capability was added that the provider has not granted: the browser goes through the consent first. */
  consent: StartResult | null;
}

export interface TestResult {
  results: { capability: Capability; ok: boolean; code: string | null }[];
}

const STATUS_ORDER: Record<string, number> = { needs_reconnect: 0, revoked: 1, active: 2, paused: 3 };

@Injectable()
export class ConnectionsService {
  private readonly log = new Logger(ConnectionsService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly registry: ConnectionProviderRegistry,
    private readonly apps: ConnectionApps,
    private readonly flows: ConnectionFlowService,
    private readonly store: ConnectionTokenStore,
    private readonly tokens: ConnectionTokensService,
    private readonly usage: ConnectionUsageRegistry,
    private readonly events: ConnectionEvents,
    private readonly mcp: McpConnectionsService,
    private readonly mcpCatalog: McpCatalogService,
    private readonly diagnostics: DiagnosticsHistory,
  ) {}

  private db(userId: string) {
    return this.prisma.forUser({ userId });
  }

  private view(row: Connection, mcp?: Map<string, { total: number; enabled: number; needsReview: number; titles?: string[] }>): ConnectionView {
    if (row.provider === 'mcp') {
      const cfg = readMcpConfig(row.config);
      const s = mcp?.get(row.id);
      const tools = { total: s?.total ?? 0, enabled: s?.enabled ?? 0, needsReview: s?.needsReview ?? 0 };
      // What it is for (E41.5): its own instructions, else its first enabled tools.
      const purpose = sanitizeInstructions(cfg?.server?.instructions ?? '') || (s?.titles?.length ? s.titles.join(', ') : '') || null;
      return { ...toView(row, []), ...(cfg ? { mcp: { url: cfg.url, auth: cfg.auth.kind, serverName: cfg.server?.name ?? null, tools, toolsFetchedAt: cfg.toolsFetchedAt ?? null, purpose } } : {}) };
    }
    const adapter = isProviderId(row.provider) ? this.registry.get(row.provider) : undefined;
    return toView(row, adapter ? adapter.capabilitiesGranted(row.grantedScopes) : capabilitiesOf(row));
  }

  /** A view with what an MCP connection adds (its tool counts). */
  private async viewOf(row: Connection): Promise<ConnectionView> {
    return this.view(row, row.provider === 'mcp' ? await this.mcpCatalog.summaries([row.id]) : undefined);
  }

  private async mine(userId: string, id: string): Promise<Connection> {
    const row = await this.db(userId).connection.findFirst({ where: { id } });
    if (!row) throw notFound();
    return row;
  }

  // ---- reading ----

  /** The owner's connections: those that need a reconnect first, then by provider and label. */
  async list(userId: string): Promise<ConnectionView[]> {
    const rows = await this.db(userId).connection.findMany({ orderBy: [{ provider: 'asc' }, { label: 'asc' }] });
    const mcp = await this.mcpCatalog.summaries(rows.filter((r) => r.provider === 'mcp').map((r) => r.id));
    return rows.map((r) => this.view(r, mcp)).sort((a, b) => (STATUS_ORDER[a.status] ?? 9) - (STATUS_ORDER[b.status] ?? 9));
  }

  /** One connection with what uses it (tasks, deliveries: nothing registers a source until E39.6). */
  async get(userId: string, id: string): Promise<ConnectionView & { usedBy: ConnectionUsage[] }> {
    const row = await this.mine(userId, id);
    const mcp = row.provider === 'mcp' ? await this.mcpCatalog.summaries([row.id]) : undefined;
    return { ...this.view(row, mcp), usedBy: await this.usage.list(userId, id) };
  }

  providers(): Promise<ProviderAvailability[]> {
    return this.apps.availability();
  }

  /** A caller used the connection now (for "last used"). Unknown or foreign ids are ignored. */
  async markUsed(userId: string, id: string): Promise<void> {
    await this.prisma.connection.updateMany({ where: { id, userId }, data: { lastUsedAt: new Date() } });
  }

  // ---- changing ----

  async update(userId: string, id: string, input: UpdateInput): Promise<UpdateResult> {
    const row = await this.mine(userId, id);
    if (row.status === 'revoked') throw new ConnectionError('CONNECTION_NEEDS_RECONNECT', 'This connection must be connected again.', { label: row.label });
    if (row.provider === 'mcp') return this.updateMcp(userId, row, input);
    const adapter = isProviderId(row.provider) ? this.registry.get(row.provider) : undefined;
    const current = capabilitiesOf(row);
    const granted = adapter ? adapter.capabilitiesGranted(row.grantedScopes) : current;

    let label = row.label;
    if (input.label !== undefined) {
      label = input.label.trim().slice(0, MAX_LABEL_LENGTH);
      const others = await this.prisma.connection.findMany({ where: { userId, NOT: { id } }, select: { label: true } });
      if (others.some((o) => o.label.toLowerCase() === label.toLowerCase())) throw new ConnectionError('CONNECTION_LABEL_TAKEN', 'You already have a connection with this name.');
    }

    // Turning a capability off is immediate and local (the permission stays granted at the provider until disconnect). Adding one the
    // provider has not granted starts an incremental consent for just the extra permissions; the switch comes on when it returns.
    let next = current;
    let consent: StartResult | null = null;
    if (input.capabilities) {
      const wanted = normalizeCapabilities(input.capabilities);
      const needConsent = addedCapabilities(current, wanted).filter((c) => !granted.includes(c));
      next = wanted.filter((c) => current.includes(c) || granted.includes(c));
      if (needConsent.length > 0) {
        consent = await this.flows.start(userId, { provider: row.provider as 'google' | 'microsoft', capabilities: wanted, loginHint: row.accountEmail, connectionId: row.id, alreadyGranted: granted, returnTo: input.returnTo });
      }
    }

    const groups = groupsOf(next);
    let defaultFor: CapabilityGroup[] = CAPABILITY_GROUPS.filter((g) => row.defaultFor.includes(g) && groups.includes(g));
    if (input.defaultFor) {
      const wantedGroups = CAPABILITY_GROUPS.filter((g) => input.defaultFor!.includes(g));
      const missing = wantedGroups.filter((g) => !groups.includes(g));
      if (missing.length > 0) throw new ConnectionError('CONNECTION_DEFAULT_NEEDS_CAPABILITY', 'Switch a capability of this group on first.', { groups: missing });
      defaultFor = wantedGroups;
    }

    const updated = await this.prisma.$transaction(async (tx) => {
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${`connections:${userId}`}))`;
      // At most one default per provider and group: a group this account claims is taken from the others.
      for (const g of defaultFor.filter((x) => !row.defaultFor.includes(x))) {
        const holders = await tx.connection.findMany({ where: { userId, provider: row.provider, NOT: { id }, defaultFor: { has: g } } });
        for (const h of holders) await tx.connection.update({ where: { id: h.id }, data: { defaultFor: h.defaultFor.filter((x) => x !== g) } });
      }
      return tx.connection.update({ where: { id }, data: { label, capabilities: next, defaultFor } });
    });
    await this.events.audit(userId, CONNECTION_AUDIT.updated, id, { provider: row.provider, capabilities: next, defaultFor, renamed: label !== row.label, consentStarted: consent !== null });
    return { connection: this.view(updated), consent };
  }

  /** An MCP connection has a name and tools, not capabilities or defaults (the owner switches tools in its tool list). */
  private async updateMcp(userId: string, row: Connection, input: UpdateInput): Promise<UpdateResult> {
    if (input.capabilities !== undefined || input.defaultFor !== undefined) throw new ConnectionError('CONNECTION_CAPABILITY_OFF', 'An MCP server has tools, not capabilities: switch its tools in the tool list.', { label: row.label });
    let label = row.label;
    if (input.label !== undefined) {
      label = input.label.trim().slice(0, MAX_LABEL_LENGTH);
      const others = await this.prisma.connection.findMany({ where: { userId, NOT: { id: row.id } }, select: { label: true } });
      if (others.some((o) => o.label.toLowerCase() === label.toLowerCase())) throw new ConnectionError('CONNECTION_LABEL_TAKEN', 'You already have a connection with this name.');
    }
    const updated = label === row.label ? row : await this.prisma.connection.update({ where: { id: row.id }, data: { label } });
    if (label !== row.label) await this.events.audit(userId, CONNECTION_AUDIT.updated, row.id, { provider: 'mcp', renamed: true });
    const mcp = await this.mcpCatalog.summaries([row.id]);
    return { connection: this.view(updated, mcp), consent: null };
  }

  async pause(userId: string, id: string): Promise<ConnectionView> {
    const row = await this.mine(userId, id);
    if (row.status === 'paused') return this.viewOf(row);
    if (row.status !== 'active') throw new ConnectionError('CONNECTION_NEEDS_RECONNECT', 'This connection must be connected again.', { label: row.label });
    const updated = await this.prisma.connection.update({ where: { id }, data: { status: 'paused' } });
    await this.events.audit(userId, CONNECTION_AUDIT.paused, id, { provider: row.provider, capabilities: row.capabilities });
    this.events.count(row.provider, 'paused');
    return this.viewOf(updated);
  }

  async resume(userId: string, id: string): Promise<ConnectionView> {
    const row = await this.mine(userId, id);
    if (row.status === 'active') return this.viewOf(row);
    if (row.status !== 'paused') throw new ConnectionError('CONNECTION_NEEDS_RECONNECT', 'This connection must be connected again.', { label: row.label });
    const updated = await this.prisma.connection.update({ where: { id }, data: { status: 'active', statusReason: null } });
    await this.events.audit(userId, CONNECTION_AUDIT.resumed, id, { provider: row.provider, capabilities: row.capabilities });
    this.events.count(row.provider, 'resumed');
    return this.viewOf(updated);
  }

  /**
   * One cheap read call per switched-on capability, with the connection's own access token (refreshed first if due). A provider
   * answer is a per-capability pass or fail with a closed reason code; an account that cannot be used at all is a typed error.
   */
  async test(userId: string, id: string): Promise<TestResult> {
    const row = await this.mine(userId, id);
    if (row.provider === 'mcp') {
      // The server answers `initialize` and lists its tools: no capability to probe.
      await this.mcp.test(userId, row);
      return { results: [] };
    }
    const adapter = isProviderId(row.provider) ? this.registry.get(row.provider) : undefined;
    if (!adapter) throw new ConnectionError('CONNECTION_PROVIDER_UNAVAILABLE', 'This provider is not installed on this deployment.', { reason: 'not_installed' });
    const accessToken = await this.tokens.getAccessToken(id, userId);
    const results: TestResult['results'] = [];
    for (const capability of capabilitiesOf(row)) {
      let r: { ok: boolean; code?: string };
      try {
        r = await adapter.probe({ capability, accessToken });
      } catch (e) {
        this.log.warn(`connection probe failed (${e instanceof Error ? e.name : 'error'})`);
        r = { ok: false, code: 'UNAVAILABLE' };
      }
      results.push({ capability, ok: r.ok, code: r.ok ? null : /^[A-Z][A-Z_]{0,39}$/.test(r.code ?? '') ? r.code! : 'UNKNOWN' });
    }
    this.events.count(row.provider, 'tested');
    return { results };
  }

  /**
   * Removes the connection: revokes the grant at the provider (best effort: `revoked: false` when it could not be asked), clears
   * what references it (tasks and deliveries then show "connection removed"), deletes its tokens and the row.
   */
  async remove(userId: string, id: string): Promise<{ revoked: boolean; clearedReferences: number }> {
    const row = await this.mine(userId, id);
    if (row.provider === 'mcp') return this.removeMcp(userId, row);
    let revoked = false;
    const adapter = isProviderId(row.provider) ? this.registry.get(row.provider) : undefined;
    const app = adapter && isProviderId(row.provider) ? await this.apps.app(row.provider, { ignoreSwitch: true }).catch(() => null) : null;
    const [refresh, access] = await Promise.all([this.store.refreshToken(userId, id).catch(() => null), this.store.accessToken(userId, id).catch(() => null)]);
    if (!refresh && !access) revoked = true;
    else if (adapter && app) {
      try {
        if (refresh) await adapter.revoke({ app, token: refresh, hint: 'refresh_token' });
        if (access) await adapter.revoke({ app, token: access, hint: 'access_token' });
        revoked = true;
      } catch {
        revoked = false;
      }
    }
    const used = await this.usage.list(userId, id);
    await this.usage.clear(userId, id);
    await this.store.clearTokens(userId, id);
    await this.prisma.connection.deleteMany({ where: { id, userId } });
    await this.diagnostics.deleteTarget('connection', id);
    await this.events.audit(userId, CONNECTION_AUDIT.removed, id, { provider: row.provider, capabilities: row.capabilities, revoked, clearedReferences: used.length });
    this.events.count(row.provider, 'removed');
    return { revoked, clearedReferences: used.length };
  }

  /** Removes an MCP connection: the OAuth grant is revoked (best effort), every secret kept for it is deleted, what references it is cleared. Its tools go with the row. */
  private async removeMcp(userId: string, row: Connection): Promise<{ revoked: boolean; clearedReferences: number }> {
    const revoked = await this.mcp.beforeRemove(row);
    const used = await this.usage.list(userId, row.id);
    await this.usage.clear(userId, row.id);
    await this.prisma.connection.deleteMany({ where: { id: row.id, userId } });
    await this.diagnostics.deleteTarget('connection', row.id);
    await this.events.audit(userId, CONNECTION_AUDIT.removed, row.id, { provider: 'mcp', revoked, clearedReferences: used.length });
    this.events.count('mcp', 'removed');
    return { revoked, clearedReferences: used.length };
  }
}
