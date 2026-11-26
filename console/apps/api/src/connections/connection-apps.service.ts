// The deployment's apps at Google and Microsoft (E39.2, #599; BRING YOUR OWN APP, provisional until the decision record of
// E39.1 is final): the client id and switch in the `connections` system settings, the client secret in the system credential
// store. The administrator sets them; users never see them. Nothing here reads a user's connections.
import { Injectable, Logger, Optional } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { CredentialsService } from '@marinoscar/platform-api/credentials';
import { SystemSettingsService } from '@marinoscar/platform-api/settings';

import { CONNECTION_APP_SECRET_NAME, connectionAppPurpose } from './connections.credentials';
import { CONNECTION_PROVIDER_IDS, type ConnectionProviderId } from './connections.constants';
import { CONNECTION_AUDIT, ConnectionEvents } from './connections.events';
import { resolveConnectionsSystemSettings, type ResolvedConnectionsSystemSettings, type ResolvedMcpSettings } from './connections.settings';
import { ConnectionProviderRegistry } from './connection-provider.registry';
import { COLUMNS_OF_PROVIDER, matrixRows, type MatrixColumn, type MatrixRow } from './capability-matrix';
import { PROVIDER_INFO, type ProviderInfo } from './provider-info';
import type { ProviderApp } from './provider';

/** How stale the cached settings may be: a switch takes effect within a few seconds. */
export const CONNECTIONS_SETTINGS_CACHE_MS = 5_000;

export type ProviderReadiness = 'ready' | 'not_installed' | 'disabled' | 'not_configured';

/** What the Connect dialog needs, per provider: no secret, no client id. */
export interface ProviderAvailability {
  provider: ConnectionProviderId;
  displayName: string;
  ready: boolean;
  /** Why it cannot be connected: the adapter is not installed, the administrator switched it off or did not finish the setup. */
  reason: Exclude<ProviderReadiness, 'ready'> | null;
  accountTypes: ProviderInfo['accountTypes'];
  /** The kinds of account the capability matrix has a column for at this provider (Google: one; Microsoft: work or school, and personal). */
  matrixColumns: readonly MatrixColumn[];
  /** For every method of the mail, calendar and documents interfaces: supported, limited (and how) or not supported, per column. The Connect dialog and the task UI never offer an unsupported choice. */
  capabilityMatrix: MatrixRow[];
  /** Microsoft: the address an administrator of the owner's organization opens to approve the app for everyone (an owner who sees "needs admin approval" sends it on). Null elsewhere or until configured. */
  adminConsentUrl: string | null;
}

/** What the administrator sees per provider: the client id (not secret) and whether a secret is stored, never the secret. */
export interface AdminProviderView {
  provider: ConnectionProviderId;
  displayName: string;
  enabled: boolean;
  clientId: string | null;
  hasClientSecret: boolean;
  tenant: string | null;
  /** Whether the code for this provider is installed (the adapters ship with E39.3 and E39.4). */
  installed: boolean;
  redirectUri: string;
  setupSteps: readonly string[];
  accountTypes: ProviderInfo['accountTypes'];
}

@Injectable()
export class ConnectionApps {
  private readonly log = new Logger(ConnectionApps.name);
  private cached: { at: number; value: ResolvedConnectionsSystemSettings } | null = null;

  /** The wall clock; tests replace it. */
  clock: () => number = Date.now;

  constructor(
    private readonly credentials: CredentialsService,
    private readonly registry: ConnectionProviderRegistry,
    private readonly events: ConnectionEvents,
    private readonly config: ConfigService,
    @Optional() private readonly settings?: SystemSettingsService,
  ) {}

  /** `<APP_URL>/api/connections/callback/<provider>`: what the provider must have registered. */
  redirectUri(provider: ConnectionProviderId): string {
    return `${(this.config.get<string>('appUrl') ?? process.env.APP_URL ?? 'http://localhost:3535').replace(/\/+$/, '')}/api/connections/callback/${provider}`;
  }

  async system(): Promise<ResolvedConnectionsSystemSettings> {
    const now = this.clock();
    if (this.cached && now - this.cached.at < CONNECTIONS_SETTINGS_CACHE_MS) return this.cached.value;
    try {
      const v = await this.settings?.getNamespace('connections');
      const value = resolveConnectionsSystemSettings(v ?? null);
      this.cached = { at: now, value };
      return value;
    } catch (e) {
      this.log.warn(`connections settings could not be read (${e instanceof Error ? e.name : 'error'}); using the last known values`);
      const value = this.cached?.value ?? resolveConnectionsSystemSettings(null);
      this.cached = { at: now, value };
      return value;
    }
  }

  invalidate(): void {
    this.cached = null;
  }

  /** Whether a client secret is stored (never the secret). */
  async hasSecret(provider: ConnectionProviderId): Promise<boolean> {
    return (await this.credentials.describe(connectionAppPurpose(provider), CONNECTION_APP_SECRET_NAME)) !== null;
  }

  /** Whether the provider can be connected, and if not why. */
  async readiness(provider: ConnectionProviderId): Promise<ProviderReadiness> {
    if (!this.registry.has(provider)) return 'not_installed';
    const s = (await this.system())[provider];
    if (!s.enabled) return 'disabled';
    if (!s.clientId || !(await this.hasSecret(provider))) return 'not_configured';
    return 'ready';
  }

  /** The app to connect or refresh with, or null when the provider cannot be used. Plaintext secret: server-side only. */
  async app(provider: ConnectionProviderId, opts: { ignoreSwitch?: boolean } = {}): Promise<ProviderApp | null> {
    const s = (await this.system())[provider];
    if (!s.clientId || (!s.enabled && !opts.ignoreSwitch)) return null;
    const secret = await this.credentials.getSecret(connectionAppPurpose(provider), CONNECTION_APP_SECRET_NAME);
    if (!secret) return null;
    return { clientId: s.clientId, clientSecret: secret, tenant: provider === 'microsoft' ? (this.tenantOf(s)) : null, redirectUri: this.redirectUri(provider) };
  }

  private tenantOf(s: ResolvedConnectionsSystemSettings['google'] | ResolvedConnectionsSystemSettings['microsoft']): string | null {
    return 'tenant' in s ? s.tenant : null;
  }

  /** `GET /api/connections/providers`. */
  async availability(): Promise<ProviderAvailability[]> {
    const out: ProviderAvailability[] = [];
    for (const provider of CONNECTION_PROVIDER_IDS) {
      const readiness = await this.readiness(provider);
      const columns = COLUMNS_OF_PROVIDER[provider];
      out.push({
        provider,
        displayName: PROVIDER_INFO[provider].displayName,
        ready: readiness === 'ready',
        reason: readiness === 'ready' ? null : readiness,
        accountTypes: PROVIDER_INFO[provider].accountTypes,
        matrixColumns: columns,
        capabilityMatrix: matrixRows(columns),
        adminConsentUrl: readiness === 'ready' ? await this.adminConsentUrl(provider) : null,
      });
    }
    return out;
  }

  // ---- MCP servers (E39.9) ----

  /** The deployment switch and host lists for MCP servers, as the settings are now (a few seconds stale at most). */
  async mcp(): Promise<ResolvedMcpSettings> {
    return (await this.system()).mcp;
  }

  async mcpAdminView(): Promise<ResolvedMcpSettings> {
    this.invalidate();
    return this.mcp();
  }

  /** Sets the switch and the host lists. Lists replace the stored ones; a field left out is kept. */
  async saveMcp(adminId: string, input: { enabled?: boolean; allowedHosts?: string[]; blockedHosts?: string[] }): Promise<ResolvedMcpSettings> {
    const patch: Record<string, unknown> = {};
    if (input.enabled !== undefined) patch.enabled = input.enabled;
    if (input.allowedHosts !== undefined) patch.allowedHosts = input.allowedHosts;
    if (input.blockedHosts !== undefined) patch.blockedHosts = input.blockedHosts;
    if (Object.keys(patch).length > 0) await this.settings?.patchSettings({ connections: { mcp: patch } } as never, adminId);
    this.invalidate();
    await this.events.audit(adminId, CONNECTION_AUDIT.appSaved, adminId, { provider: 'mcp', enabled: input.enabled ?? null, allowedHosts: input.allowedHosts?.length ?? null, blockedHosts: input.blockedHosts?.length ?? null }, 'connection_app');
    return this.mcpAdminView();
  }

  /** The client id is not a secret, so the link is built from the settings without reading the secret. */
  private async adminConsentUrl(provider: ConnectionProviderId): Promise<string | null> {
    const s = (await this.system())[provider];
    const adapter = this.registry.get(provider);
    if (!s.clientId || !adapter?.adminConsentUrl) return null;
    return adapter.adminConsentUrl({ clientId: s.clientId, clientSecret: '', tenant: this.tenantOf(s), redirectUri: this.redirectUri(provider) });
  }

  // ---- the administrator ----

  async adminView(): Promise<AdminProviderView[]> {
    this.invalidate();
    const system = await this.system();
    const out: AdminProviderView[] = [];
    for (const provider of CONNECTION_PROVIDER_IDS) {
      const s = system[provider];
      out.push({
        provider,
        displayName: PROVIDER_INFO[provider].displayName,
        enabled: s.enabled,
        clientId: s.clientId,
        hasClientSecret: await this.hasSecret(provider),
        tenant: this.tenantOf(s),
        installed: this.registry.has(provider),
        redirectUri: this.redirectUri(provider),
        setupSteps: PROVIDER_INFO[provider].setupSteps,
        accountTypes: PROVIDER_INFO[provider].accountTypes,
      });
    }
    return out;
  }

  async saveApp(adminId: string, provider: ConnectionProviderId, input: { enabled?: boolean; clientId?: string | null; clientSecret?: string; tenant?: string }): Promise<AdminProviderView[]> {
    const patch: Record<string, unknown> = {};
    if (input.enabled !== undefined) patch.enabled = input.enabled;
    if (input.clientId !== undefined) patch.clientId = input.clientId;
    if (input.tenant !== undefined && provider === 'microsoft') patch.tenant = input.tenant;
    if (Object.keys(patch).length > 0) await this.settings?.patchSettings({ connections: { providers: { [provider]: patch } } } as never, adminId);
    if (input.clientSecret) await this.credentials.setSecret(connectionAppPurpose(provider), CONNECTION_APP_SECRET_NAME, input.clientSecret);
    this.invalidate();
    await this.events.audit(adminId, CONNECTION_AUDIT.appSaved, adminId, { provider, enabled: input.enabled ?? null, secretSet: Boolean(input.clientSecret) }, 'connection_app');
    return this.adminView();
  }

  /** Removes the client id, the secret and the switch. Existing connections stay and keep their tokens, but cannot refresh until the app is set again. */
  async removeApp(adminId: string, provider: ConnectionProviderId): Promise<AdminProviderView[]> {
    await this.settings?.patchSettings({ connections: { providers: { [provider]: { enabled: false, clientId: null } } } } as never, adminId);
    await this.credentials.deleteSecret(connectionAppPurpose(provider), CONNECTION_APP_SECRET_NAME);
    this.invalidate();
    await this.events.audit(adminId, CONNECTION_AUDIT.appRemoved, adminId, { provider }, 'connection_app');
    return this.adminView();
  }
}
