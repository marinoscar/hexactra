// The owner's connections (E39.2, #599): list, read, rename, change what an account may do, make it the default, pause,
// resume, test and remove. Every query is the caller's own (`forUser`, and an explicit `userId` in every `where`): another
// user's id is a 404 like a missing one. Nothing here returns a token, a scope string or a provider message.
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
  ) {}

  private db(userId: string) {
    return this.prisma.forUser({ userId });
  }

  private view(row: Connection): ConnectionView {
    const adapter = isProviderId(row.provider) ? this.registry.get(row.provider) : undefined;
    return toView(row, adapter ? adapter.capabilitiesGranted(row.grantedScopes) : capabilitiesOf(row));
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
    return rows.map((r) => this.view(r)).sort((a, b) => (STATUS_ORDER[a.status] ?? 9) - (STATUS_ORDER[b.status] ?? 9));
  }

  /** One connection with what uses it (tasks, deliveries: nothing registers a source until E39.6). */
  async get(userId: string, id: string): Promise<ConnectionView & { usedBy: ConnectionUsage[] }> {
    const row = await this.mine(userId, id);
    return { ...this.view(row), usedBy: await this.usage.list(userId, id) };
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

  async pause(userId: string, id: string): Promise<ConnectionView> {
    const row = await this.mine(userId, id);
    if (row.status === 'paused') return this.view(row);
    if (row.status !== 'active') throw new ConnectionError('CONNECTION_NEEDS_RECONNECT', 'This connection must be connected again.', { label: row.label });
    const updated = await this.prisma.connection.update({ where: { id }, data: { status: 'paused' } });
    await this.events.audit(userId, CONNECTION_AUDIT.paused, id, { provider: row.provider, capabilities: row.capabilities });
    this.events.count(row.provider, 'paused');
    return this.view(updated);
  }

  async resume(userId: string, id: string): Promise<ConnectionView> {
    const row = await this.mine(userId, id);
    if (row.status === 'active') return this.view(row);
    if (row.status !== 'paused') throw new ConnectionError('CONNECTION_NEEDS_RECONNECT', 'This connection must be connected again.', { label: row.label });
    const updated = await this.prisma.connection.update({ where: { id }, data: { status: 'active', statusReason: null } });
    await this.events.audit(userId, CONNECTION_AUDIT.resumed, id, { provider: row.provider, capabilities: row.capabilities });
    this.events.count(row.provider, 'resumed');
    return this.view(updated);
  }

  /**
   * One cheap read call per switched-on capability, with the connection's own access token (refreshed first if due). A provider
   * answer is a per-capability pass or fail with a closed reason code; an account that cannot be used at all is a typed error.
   */
  async test(userId: string, id: string): Promise<TestResult> {
    const row = await this.mine(userId, id);
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
    await this.events.audit(userId, CONNECTION_AUDIT.removed, id, { provider: row.provider, capabilities: row.capabilities, revoked, clearedReferences: used.length });
    this.events.count(row.provider, 'removed');
    return { revoked, clearedReferences: used.length };
  }
}
