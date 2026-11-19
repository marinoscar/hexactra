// The console owns the Vault grant's refresh token and its rotation (E37.2, #591).
//
// Vault's refresh tokens ROTATE ON USE, and replaying a used one revokes the whole grant. So:
//   * one refresh at a time per connection: an in-process single-flight map (callers in this process share one
//     refresh) AND a database lease on the connection row (`refresh_lease_until`, taken with a compare-and-set
//     `updateMany`, so two API instances never refresh the same grant at once; a follower waits for the leader's
//     result instead of calling Vault);
//   * the NEW refresh token is stored (replacing the old) before the new access token is used or returned, and a
//     failure to store it marks the connection `needs_reconnect` rather than carrying on with a token Vault
//     already retired;
//   * a refused grant (`invalid_grant`: revoked, expired or replayed) marks the connection `needs_reconnect`,
//     deletes the tokens, tells the fabric to forget the provider and notifies the owner ONCE;
//   * a Vault that cannot be reached changes nothing: the status stays, the caller is told "unavailable".
//
// The access token this returns is what the fabric is handed (`SecretsProviderRegistrar`). The refresh token never
// leaves this class's store.
import { Inject, Injectable, Logger } from '@nestjs/common';
import type { SecretsConnection } from '@prisma/client';

import { OAuthClientError, OAuthClientService } from '../oauth-client';
import { PrismaService } from '../prisma/prisma.service';
import { FABRIC_SECRETS_REGISTRY, type FabricSecretsRegistry } from './fabric-secrets-registry';
import { SECRETS_AUDIT, SecretsEvents, hostOf } from './secrets.events';
import { VaultClientConfigs } from './vault-client.config';
import { VAULT_OAUTH_PATHS, vaultResource } from './vault-contract';
import { VaultGrantStore } from './vault-grant.store';

export type VaultAccessErrorKind = 'not_connected' | 'needs_reconnect' | 'unavailable' | 'not_configured';

/** The access token could not be had. `code` is a closed, data-free vocabulary. */
export class VaultAccessError extends Error {
  constructor(
    readonly kind: VaultAccessErrorKind,
    readonly code: string,
  ) {
    super(`Vault access is not available (${kind}).`);
    this.name = 'VaultAccessError';
  }
}

export interface VaultAccess {
  accessToken: string;
  expiresAt: Date;
  baseUrl: string;
}

/** How long a refresh may hold the database lease (a refresh is one HTTP call with a 10 s deadline). */
export const REFRESH_LEASE_MS = 30_000;
/** The longest a follower waits for another instance's refresh. */
export const REFRESH_WAIT_MS = 25_000;
const POLL_MS = 150;

@Injectable()
export class VaultTokenService {
  private readonly log = new Logger(VaultTokenService.name);
  private readonly inflight = new Map<string, Promise<VaultAccess>>();

  /** The wall clock; tests replace it. */
  clock: () => number = Date.now;
  /** The wait between polls of a follower; tests replace it. */
  sleep: (ms: number) => Promise<void> = (ms) => new Promise((r) => setTimeout(r, ms));

  constructor(
    private readonly prisma: PrismaService,
    private readonly store: VaultGrantStore,
    private readonly configs: VaultClientConfigs,
    private readonly oauth: OAuthClientService,
    private readonly events: SecretsEvents,
    @Inject(FABRIC_SECRETS_REGISTRY) private readonly fabric: FabricSecretsRegistry,
  ) {}

  /**
   * A valid access token for the owner's Vault, refreshing (once, however many callers ask) when fewer than
   * `minRemainingMs` remain. Throws {@link VaultAccessError}.
   */
  getAccess(userId: string, opts: { minRemainingMs?: number } = {}): Promise<VaultAccess> {
    const min = opts.minRemainingMs ?? 60_000;
    const running = this.inflight.get(userId);
    if (running) return running;
    const p = this.ensure(userId, min).finally(() => this.inflight.delete(userId));
    this.inflight.set(userId, p);
    return p;
  }

  private async ensure(userId: string, min: number): Promise<VaultAccess> {
    const deadline = this.clock() + REFRESH_WAIT_MS;
    for (;;) {
      const row = await this.row(userId);
      this.assertUsable(row);
      const fresh = await this.freshAccess(userId, row, min);
      if (fresh) return fresh;
      if (await this.acquireLease(row.id)) {
        try {
          return await this.refreshHolding(userId, min);
        } finally {
          await this.releaseLease(row.id);
        }
      }
      if (this.clock() > deadline) throw new VaultAccessError('unavailable', 'REFRESH_WAIT_TIMEOUT');
      await this.sleep(POLL_MS);
    }
  }

  private async row(userId: string): Promise<SecretsConnection | null> {
    return this.prisma.secretsConnection.findUnique({ where: { userId_provider: { userId, provider: 'vault' } } });
  }

  private assertUsable(row: SecretsConnection | null): asserts row is SecretsConnection {
    if (!row || row.status === 'disconnected') throw new VaultAccessError('not_connected', 'NOT_CONNECTED');
    if (row.status === 'needs_reconnect') throw new VaultAccessError('needs_reconnect', row.lastErrorCode ?? 'NEEDS_RECONNECT');
  }

  private async freshAccess(userId: string, row: SecretsConnection, min: number): Promise<VaultAccess | null> {
    if (!row.accessExpiresAt || row.accessExpiresAt.getTime() - this.clock() <= min) return null;
    const token = await this.store.accessToken(userId);
    if (!token) return null;
    const config = await this.configs.effective(userId, row);
    if (!config) return null;
    return { accessToken: token, expiresAt: row.accessExpiresAt, baseUrl: config.baseUrl };
  }

  private async acquireLease(rowId: string): Promise<boolean> {
    const now = new Date(this.clock());
    const res = await this.prisma.secretsConnection.updateMany({
      where: { id: rowId, status: 'connected', OR: [{ refreshLeaseUntil: null }, { refreshLeaseUntil: { lt: now } }] },
      data: { refreshLeaseUntil: new Date(now.getTime() + REFRESH_LEASE_MS) },
    });
    return res.count === 1;
  }

  private async releaseLease(rowId: string): Promise<void> {
    await this.prisma.secretsConnection.updateMany({ where: { id: rowId }, data: { refreshLeaseUntil: null } });
  }

  /** Runs with the lease held: the only place a refresh token is presented to Vault. */
  private async refreshHolding(userId: string, min: number): Promise<VaultAccess> {
    // Another instance may have refreshed between our read and our lease.
    const row = await this.row(userId);
    this.assertUsable(row);
    const again = await this.freshAccess(userId, row, min);
    if (again) return again;

    const config = await this.configs.effective(userId, row);
    if (!config?.clientSecret) throw new VaultAccessError('not_configured', 'NOT_CONFIGURED');
    const refreshToken = await this.store.refreshToken(userId);
    if (!refreshToken) {
      await this.markNeedsReconnect(userId, 'NO_REFRESH_TOKEN');
      throw new VaultAccessError('needs_reconnect', 'NO_REFRESH_TOKEN');
    }

    let tokens;
    try {
      const endpoints = await this.oauth.discover(config.baseUrl, { metadataPath: VAULT_OAUTH_PATHS.metadata, fallback: VAULT_OAUTH_PATHS, allowedHosts: config.allowedHosts });
      tokens = await this.oauth.refresh(endpoints, { clientId: config.clientId, clientSecret: config.clientSecret }, { refreshToken, resource: vaultResource(config.baseUrl), allowedHosts: config.allowedHosts });
    } catch (e) {
      throw await this.refreshFailed(userId, e);
    }

    // The NEW refresh token first: from here the old one is retired at Vault.
    if (tokens.refreshToken) {
      try {
        await this.store.setRefreshToken(userId, tokens.refreshToken);
      } catch {
        await this.markNeedsReconnect(userId, 'TOKEN_STORE_FAILED');
        throw new VaultAccessError('needs_reconnect', 'TOKEN_STORE_FAILED');
      }
    }
    await this.store.setAccessToken(userId, tokens.accessToken);
    await this.prisma.secretsConnection.update({ where: { id: row.id }, data: { accessExpiresAt: tokens.expiresAt, lastErrorCode: null, lastErrorAt: null } });
    return { accessToken: tokens.accessToken, expiresAt: tokens.expiresAt, baseUrl: config.baseUrl };
  }

  private async refreshFailed(userId: string, e: unknown): Promise<VaultAccessError> {
    if (!(e instanceof OAuthClientError)) {
      this.log.warn(`vault refresh failed (${e instanceof Error ? e.name : 'error'})`);
      await this.recordError(userId, 'UNAVAILABLE');
      return new VaultAccessError('unavailable', 'UNAVAILABLE');
    }
    if (e.kind === 'invalid_grant') {
      await this.markNeedsReconnect(userId, 'GRANT_REVOKED');
      return new VaultAccessError('needs_reconnect', 'GRANT_REVOKED');
    }
    if (e.kind === 'invalid_client') {
      await this.markNeedsReconnect(userId, 'CLIENT_REFUSED');
      return new VaultAccessError('needs_reconnect', 'CLIENT_REFUSED');
    }
    const code = e.kind === 'unavailable' ? 'UNAVAILABLE' : e.oauthError ? e.oauthError.toUpperCase() : 'REFUSED';
    await this.recordError(userId, code);
    return new VaultAccessError('unavailable', code);
  }

  private async recordError(userId: string, code: string): Promise<void> {
    await this.prisma.secretsConnection.updateMany({ where: { userId, provider: 'vault' }, data: { lastErrorCode: code.slice(0, 60), lastErrorAt: new Date(this.clock()) } });
  }

  /**
   * Vault no longer accepts the grant (`invalid_grant` on refresh, or a 401 the fabric reported): marks the
   * connection `needs_reconnect`, deletes the tokens, drops the fabric's provider and notifies the owner exactly
   * once per episode (cleared by a new connection). Idempotent: the second caller changes and notifies nothing.
   */
  async markNeedsReconnect(userId: string, code: string): Promise<boolean> {
    const now = new Date(this.clock());
    const moved = await this.prisma.secretsConnection.updateMany({
      where: { userId, provider: 'vault', status: 'connected' },
      data: { status: 'needs_reconnect', lastErrorCode: code.slice(0, 60), lastErrorAt: now, accessExpiresAt: null, refreshLeaseUntil: null },
    });
    if (moved.count === 0) return false;
    await this.store.clearGrant(userId);
    await this.fabric.unregisterSecretsProvider(userId, 'vault').catch(() => undefined);
    const row = await this.row(userId);
    await this.events.audit(userId, SECRETS_AUDIT.needsReconnect, row?.id ?? userId, { provider: 'vault', host: hostOf(row?.baseUrl), code });
    const claimed = await this.prisma.secretsConnection.updateMany({ where: { userId, provider: 'vault', reconnectNotifiedAt: null }, data: { reconnectNotifiedAt: now } });
    if (claimed.count === 1) await this.events.needsReconnect(userId);
    return true;
  }
}
