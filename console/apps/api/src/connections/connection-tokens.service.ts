// The console owns each connection's tokens and their refresh (E39.2, #599). The access token is given only to server code in
// `connections/` (the adapters' calls); nothing returns one through the API, to a model, a step, a log, a span or an export.
//
// Some providers ROTATE the refresh token on use, and a replayed one can revoke the grant, so:
//   * one refresh at a time per connection: an in-process single-flight map (callers in this process share one refresh) AND a
//     database lease on the row (`refresh_lease_until`, taken with a compare-and-set `updateMany`, so two API instances never
//     refresh the same grant at once; a follower waits for the leader's result instead of calling the provider);
//   * the NEW refresh token is stored (replacing the old) before the new access token is used or returned, and a failure to
//     store it marks the connection `needs_reconnect` rather than carrying on with a token the provider already retired;
//   * a refused grant (`invalid_grant`: revoked, expired, password changed, the 7-day test rule) marks the connection
//     `needs_reconnect` with a reason code, deletes the tokens and notifies the owner ONCE;
//   * a provider that cannot be reached changes nothing: the status stays, the caller gets `CONNECTION_UNAVAILABLE`.
import { Injectable, Logger } from '@nestjs/common';
import type { Connection } from '@prisma/client';

import { OAuthClientError } from '../oauth-client';
import { PrismaService } from '../prisma/prisma.service';
import { REFRESH_WITHIN_MS, isProviderId } from './connections.constants';
import { CONNECTION_AUDIT, ConnectionEvents } from './connections.events';
import { ConnectionError, notFound } from './connections.errors';
import { ConnectionApps } from './connection-apps.service';
import { ConnectionProviderRegistry } from './connection-provider.registry';
import { ConnectionTokenStore } from './connection-token.store';
import type { TokenSet } from './provider';

/** How long a refresh may hold the database lease (a refresh is one HTTP call with a 10 s deadline). */
export const REFRESH_LEASE_MS = 30_000;
/** The longest a follower waits for another instance's refresh. */
export const REFRESH_WAIT_MS = 25_000;
const POLL_MS = 150;

export interface AccessTokenOptions {
  /** Refresh even if the cached token is still good (the health job). */
  forceRefresh?: boolean;
  /** A paused connection is refused unless the caller is the health job, which keeps the grant alive without using it. */
  allowPaused?: boolean;
}

const LIVE = ['active', 'paused'] as const;

/**
 * Refreshes the grant of a provider whose app and endpoints are not a deployment-wide adapter (an MCP server signs in with a client it
 * registered itself, at the server's own authorization server). Registered once, at start up, by the feature that owns the provider.
 * Throws `OAuthClientError` exactly as an adapter's `refresh` does, so the rules below (a refused grant needs a reconnect, an
 * unreachable server changes nothing) apply unchanged.
 */
export type ExternalRefresher = (row: Connection, refreshToken: string) => Promise<TokenSet>;

@Injectable()
export class ConnectionTokensService {
  private readonly log = new Logger(ConnectionTokensService.name);
  private readonly inflight = new Map<string, Promise<string>>();
  private readonly external = new Map<string, ExternalRefresher>();

  /** The wall clock; tests replace it. */
  clock: () => number = Date.now;
  /** The wait between polls of a follower; tests replace it. */
  sleep: (ms: number) => Promise<void> = (ms) => new Promise((r) => setTimeout(r, ms));

  constructor(
    private readonly prisma: PrismaService,
    private readonly store: ConnectionTokenStore,
    private readonly registry: ConnectionProviderRegistry,
    private readonly apps: ConnectionApps,
    private readonly events: ConnectionEvents,
  ) {}

  /** E39.9: a provider that refreshes by its own means (`mcp`). */
  registerRefresher(provider: string, refresher: ExternalRefresher): void {
    this.external.set(provider, refresher);
  }

  /**
   * A valid access token for the owner's connection, refreshing (once, however many callers ask) when fewer than two minutes
   * remain. Throws {@link ConnectionError}: `CONNECTION_NOT_FOUND` (also another user's id), `CONNECTION_PAUSED`,
   * `CONNECTION_NEEDS_RECONNECT`, `CONNECTION_UNAVAILABLE`.
   */
  getAccessToken(connectionId: string, userId: string, opts: AccessTokenOptions = {}): Promise<string> {
    const key = `${connectionId}:${opts.forceRefresh ? 'force' : 'fresh'}`;
    const running = this.inflight.get(key);
    if (running) return running;
    const p = this.ensure(connectionId, userId, opts).finally(() => this.inflight.delete(key));
    this.inflight.set(key, p);
    return p;
  }

  private async ensure(connectionId: string, userId: string, opts: AccessTokenOptions): Promise<string> {
    const deadline = this.clock() + REFRESH_WAIT_MS;
    let forced = opts.forceRefresh === true;
    for (;;) {
      const row = await this.row(connectionId, userId);
      this.assertUsable(row, opts);
      if (!forced) {
        const fresh = await this.freshAccess(row);
        if (fresh) return fresh;
      }
      if (await this.acquireLease(row.id)) {
        try {
          return await this.refreshHolding(connectionId, userId, opts, forced);
        } finally {
          await this.releaseLease(row.id);
        }
      }
      // Someone else is refreshing: wait for their result (it will be fresh, so a forced refresh is not repeated).
      forced = false;
      if (this.clock() > deadline) throw new ConnectionError('CONNECTION_UNAVAILABLE', 'The provider did not answer in time.', { reason: 'refresh_wait_timeout' });
      await this.sleep(POLL_MS);
    }
  }

  private row(connectionId: string, userId: string): Promise<Connection | null> {
    return this.prisma.connection.findFirst({ where: { id: connectionId, userId } });
  }

  private assertUsable(row: Connection | null, opts: AccessTokenOptions): asserts row is Connection {
    if (!row) throw notFound();
    if (row.status === 'paused' && !opts.allowPaused) throw new ConnectionError('CONNECTION_PAUSED', 'This connection is paused.', { label: row.label });
    if (row.status === 'needs_reconnect' || row.status === 'revoked') throw new ConnectionError('CONNECTION_NEEDS_RECONNECT', 'This connection must be connected again.', { label: row.label, reason: row.statusReason ?? 'NEEDS_RECONNECT' });
  }

  private async freshAccess(row: Connection): Promise<string | null> {
    if (!row.accessExpiresAt || row.accessExpiresAt.getTime() - this.clock() <= REFRESH_WITHIN_MS) return null;
    return this.store.accessToken(row.userId, row.id);
  }

  private async acquireLease(rowId: string): Promise<boolean> {
    const now = new Date(this.clock());
    const res = await this.prisma.connection.updateMany({
      where: { id: rowId, status: { in: [...LIVE] }, OR: [{ refreshLeaseUntil: null }, { refreshLeaseUntil: { lt: now } }] },
      data: { refreshLeaseUntil: new Date(now.getTime() + REFRESH_LEASE_MS) },
    });
    return res.count === 1;
  }

  private async releaseLease(rowId: string): Promise<void> {
    await this.prisma.connection.updateMany({ where: { id: rowId }, data: { refreshLeaseUntil: null } });
  }

  /** Runs with the lease held: the only place a refresh token is presented to a provider. */
  private async refreshHolding(connectionId: string, userId: string, opts: AccessTokenOptions, forced: boolean): Promise<string> {
    // Another instance may have refreshed between our read and our lease.
    const row = await this.row(connectionId, userId);
    this.assertUsable(row, opts);
    if (!forced) {
      const again = await this.freshAccess(row);
      if (again) return again;
    }
    const external = this.external.get(row.provider);
    if (!external && !isProviderId(row.provider)) throw new ConnectionError('CONNECTION_UNAVAILABLE', 'This provider is not available.', { reason: 'not_installed' });
    const adapter = !external && isProviderId(row.provider) ? this.registry.get(row.provider) : undefined;
    const app = adapter && isProviderId(row.provider) ? await this.apps.app(row.provider, { ignoreSwitch: true }) : null;
    if (!external && (!adapter || !app)) {
      await this.recordError(row.id, adapter ? 'APP_NOT_CONFIGURED' : 'NOT_INSTALLED');
      throw new ConnectionError('CONNECTION_UNAVAILABLE', 'This provider is not available.', { reason: adapter ? 'not_configured' : 'not_installed' });
    }
    const refreshToken = await this.store.refreshToken(userId, row.id);
    if (!refreshToken) {
      await this.markNeedsReconnect(userId, row.id, 'NO_REFRESH_TOKEN');
      throw new ConnectionError('CONNECTION_NEEDS_RECONNECT', 'This connection must be connected again.', { label: row.label, reason: 'NO_REFRESH_TOKEN' });
    }

    let tokens;
    try {
      tokens = external ? await external(row, refreshToken) : await adapter!.refresh({ app: app!, refreshToken });
    } catch (e) {
      throw await this.refreshFailed(userId, row, e);
    }

    // The NEW refresh token first: from here the old one may be retired at the provider.
    if (tokens.refreshToken && tokens.refreshToken !== refreshToken) {
      try {
        await this.store.setRefreshToken(userId, row.id, tokens.refreshToken);
      } catch {
        await this.markNeedsReconnect(userId, row.id, 'TOKEN_STORE_FAILED');
        throw new ConnectionError('CONNECTION_NEEDS_RECONNECT', 'This connection must be connected again.', { label: row.label, reason: 'TOKEN_STORE_FAILED' });
      }
    }
    try {
      await this.store.setAccessToken(userId, row.id, tokens.accessToken);
    } catch {
      await this.recordError(row.id, 'TOKEN_STORE_FAILED');
      throw new ConnectionError('CONNECTION_UNAVAILABLE', 'The new token could not be stored.', { reason: 'token_store_failed' });
    }
    await this.prisma.connection.update({ where: { id: row.id }, data: { accessExpiresAt: tokens.expiresAt, lastRefreshAt: new Date(this.clock()), ...(row.status === 'active' ? { statusReason: null } : {}) } });
    this.events.count(row.provider, 'refreshed');
    return tokens.accessToken;
  }

  private async refreshFailed(userId: string, row: Connection, e: unknown): Promise<ConnectionError> {
    if (e instanceof OAuthClientError && e.kind === 'invalid_grant') {
      await this.markNeedsReconnect(userId, row.id, 'GRANT_REVOKED');
      return new ConnectionError('CONNECTION_NEEDS_RECONNECT', 'This connection must be connected again.', { label: row.label, reason: 'GRANT_REVOKED' });
    }
    if (!(e instanceof OAuthClientError)) this.log.warn(`connection refresh failed (${e instanceof Error ? e.name : 'error'})`);
    const code = e instanceof OAuthClientError ? (e.kind === 'unavailable' ? 'UNAVAILABLE' : e.kind === 'invalid_client' ? 'APP_REFUSED' : e.oauthError ? e.oauthError.toUpperCase() : 'REFUSED') : 'UNAVAILABLE';
    await this.recordError(row.id, code);
    this.events.count(row.provider, 'unavailable');
    return new ConnectionError('CONNECTION_UNAVAILABLE', 'The provider could not be reached or refused the request.', { reason: code.toLowerCase() });
  }

  private async recordError(rowId: string, code: string): Promise<void> {
    await this.prisma.connection.updateMany({ where: { id: rowId, status: 'active' }, data: { statusReason: code.slice(0, 60) } });
  }

  /**
   * The provider no longer accepts the grant: marks the connection `needs_reconnect` with a reason code, deletes its tokens and
   * notifies the owner exactly once per episode (cleared by a new consent). Idempotent: the second caller changes and notifies nothing.
   */
  async markNeedsReconnect(userId: string, connectionId: string, code: string): Promise<boolean> {
    const moved = await this.prisma.connection.updateMany({
      where: { id: connectionId, userId, status: { in: [...LIVE] } },
      data: { status: 'needs_reconnect', statusReason: code.slice(0, 60), accessExpiresAt: null, refreshLeaseUntil: null },
    });
    if (moved.count === 0) return false;
    await this.store.clearTokens(userId, connectionId).catch(() => undefined);
    const row = await this.row(connectionId, userId);
    if (!row) return true;
    await this.events.audit(userId, CONNECTION_AUDIT.needsReconnect, row.id, { provider: row.provider, capabilities: row.capabilities, reason: code.slice(0, 60) });
    this.events.count(row.provider, 'needs_reconnect');
    const claimed = await this.prisma.connection.updateMany({ where: { id: row.id, reconnectNotifiedAt: null }, data: { reconnectNotifiedAt: new Date(this.clock()) } });
    if (claimed.count === 1) await this.events.needsReconnect(userId, { connectionId: row.id, provider: row.provider, label: row.label });
    return true;
  }
}
