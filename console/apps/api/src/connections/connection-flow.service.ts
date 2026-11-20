// Connecting an account (E39.2, #599): OAuth 2.1 authorization code with PKCE against the provider's own consent screen, run by
// the console with the deployment's app (bring your own app).
//
//   start      a PKCE verifier (encrypted in the credential store) and `state` + a browser-binding value (only their SHA-256 on the
//              flow row, single use, 10 minutes), then the provider's authorize URL. The same flow serves a new account, a
//              reconnect (same account: the row is updated, never duplicated) and an incremental consent (a capability added
//              later: only the extra permissions are asked, the account is the login hint).
//   callback   public (the browser arrives from the provider without our bearer token), so the flow is bound to the browser that
//              started it: `state` must match a flow row AND the HttpOnly binding cookie set on `start` must match its hash.
//              The flow row is deleted before anything is exchanged, so a code is used once. Then: exchange, read the account,
//              upsert by (user, provider, account id), store the tokens, switch on what was both requested and granted.
//
// A token, a code, a verifier and a client secret never reach a log line, a span, an audit event or an API response.
import { Injectable, Logger } from '@nestjs/common';
import type { Connection } from '@prisma/client';

import { OAuthClientError, codeChallengeS256, newCodeVerifier, randomToken, safeEqual, sha256Hex } from '../oauth-client';
import { PrismaService } from '../prisma/prisma.service';
import { CAPABILITIES, CONNECT_TTL_MS, DEFAULT_RETURN_TO, MAX_CONNECTIONS_PER_USER, addedCapabilities, groupsOf, isProviderId, keepSupported, normalizeCapabilities, type Capability, type ConnectionProviderId } from './connections.constants';
import { ConnectionError } from './connections.errors';
import { CONNECTION_AUDIT, ConnectionEvents } from './connections.events';
import { ConnectionApps } from './connection-apps.service';
import { defaultLabel, uniqueLabel } from './connection-labels';
import { ConnectionProviderRegistry } from './connection-provider.registry';
import { ConnectionTokenStore } from './connection-token.store';
import { capabilitiesOf } from './connection-view';
import type { ConnectionProviderAdapter, ProviderApp, TokenSet } from './provider';

/** What the callback tells the browser (query values on the return page): a closed set. */
export type CallbackOutcome = 'connected' | 'state_invalid' | 'expired' | 'binding_invalid' | 'denied' | 'refused' | 'exchange_failed' | 'no_refresh_token' | 'account_mismatch' | 'nothing_granted' | 'provider_unavailable' | 'limit' | 'admin_consent_required';

export interface CallbackResult {
  outcome: CallbackOutcome;
  returnTo: string;
  connectionId?: string;
  /** Capabilities that were asked for and not granted: they are off. */
  missing?: Capability[];
}

export interface StartInput {
  provider: ConnectionProviderId;
  capabilities: readonly Capability[];
  label?: string | null;
  loginHint?: string | null;
  returnTo?: string | null;
  /** An incremental consent for this connection (its account is the login hint). */
  connectionId?: string | null;
  /** The capabilities already granted: only the others are asked for. */
  alreadyGranted?: readonly Capability[];
}

export interface StartResult {
  authorizeUrl: string;
  expiresAt: Date;
  /** The HttpOnly cookie to set on the response: named after the flow so two flows in two tabs do not clobber each other. */
  cookie: { name: string; value: string; maxAgeSeconds: number };
}

/** A path on this console, or the default: never an absolute URL (no open redirect). */
export function safeReturnTo(raw: string | null | undefined): string {
  if (!raw || raw.length > 200 || !/^\/[A-Za-z0-9/_\-.?=&%#]*$/.test(raw) || raw.startsWith('//')) return DEFAULT_RETURN_TO;
  return raw;
}

/** The binding cookie of a flow, derived from its `state` (the callback reads `state` before it can know anything else). */
export const bindingCookieName = (state: string): string => `hx_conn_${sha256Hex(state).slice(0, 16)}`;

const union = <T>(a: readonly T[], b: readonly T[]): T[] => [...new Set([...a, ...b])];

/** What is recorded about a failed connect besides its reason: closed values only (#670). */
type FailureCause = { cause?: string; oauthError?: string; status?: number; error?: string; code?: string };
const SAFE_CODE = /^[A-Za-z0-9_]{1,60}$/;

/** The closed, content-free facts of an error: never its message (a provider's text, a value, a token). */
function causeOf(e: unknown): FailureCause {
  if (e instanceof OAuthClientError) {
    return {
      cause: e.kind,
      ...(e.oauthError && /^[a-z_]{1,40}$/.test(e.oauthError) ? { oauthError: e.oauthError } : {}),
      ...(typeof e.status === 'number' ? { status: e.status } : {}),
    };
  }
  const name = e instanceof Error && SAFE_CODE.test(e.name) ? e.name : 'Error';
  const code = (e as { code?: unknown } | null)?.code;
  return { cause: 'error', error: name, ...(typeof code === 'string' && SAFE_CODE.test(code) ? { code } : {}) };
}

@Injectable()
export class ConnectionFlowService {
  private readonly log = new Logger(ConnectionFlowService.name);

  /** The wall clock; tests replace it. */
  clock: () => number = Date.now;

  constructor(
    private readonly prisma: PrismaService,
    private readonly registry: ConnectionProviderRegistry,
    private readonly apps: ConnectionApps,
    private readonly store: ConnectionTokenStore,
    private readonly events: ConnectionEvents,
  ) {}

  // ---- starting ----

  async start(userId: string, input: StartInput): Promise<StartResult> {
    const adapter = this.registry.get(input.provider);
    const readiness = await this.apps.readiness(input.provider);
    if (!adapter || readiness !== 'ready') throw new ConnectionError('CONNECTION_PROVIDER_UNAVAILABLE', 'This provider cannot be connected on this deployment.', { reason: adapter ? readiness : 'not_installed' });
    const app = await this.apps.app(input.provider);
    if (!app) throw new ConnectionError('CONNECTION_PROVIDER_UNAVAILABLE', 'This provider cannot be connected on this deployment.', { reason: 'not_configured' });

    const capabilities = normalizeCapabilities(input.capabilities);
    const asked = input.connectionId ? addedCapabilities(input.alreadyGranted ?? [], capabilities) : capabilities;
    const scopes = adapter.scopesFor(asked.length > 0 ? asked : capabilities);
    await this.assertLabelUsable(userId, input);

    const state = randomToken(32);
    const binding = randomToken(32);
    const verifier = newCodeVerifier();
    const expiresAt = new Date(this.clock() + CONNECT_TTL_MS);
    const flow = await this.prisma.connectionFlow.create({
      data: {
        userId,
        provider: input.provider,
        stateHash: sha256Hex(state),
        bindingHash: sha256Hex(binding),
        capabilities,
        label: input.label?.trim() || null,
        loginHint: input.loginHint?.trim() || null,
        connectionId: input.connectionId ?? null,
        returnTo: safeReturnTo(input.returnTo),
        expiresAt,
      },
    });
    try {
      await this.store.setVerifier(userId, flow.id, verifier);
    } catch (e) {
      await this.prisma.connectionFlow.deleteMany({ where: { id: flow.id } });
      throw e;
    }
    const authorizeUrl = adapter.authorizeUrl({ app, state, codeChallenge: codeChallengeS256(verifier), scopes, loginHint: input.loginHint?.trim() || null, incremental: Boolean(input.connectionId) });
    await this.events.audit(userId, CONNECTION_AUDIT.connectStarted, input.connectionId ?? flow.id, { provider: input.provider, capabilities, incremental: Boolean(input.connectionId) }, input.connectionId ? 'connection' : 'connection_flow');
    return { authorizeUrl, expiresAt, cookie: { name: bindingCookieName(state), value: binding, maxAgeSeconds: Math.floor(CONNECT_TTL_MS / 1000) } };
  }

  /** A label the owner typed must be free, unless this is the reconnect of the account that has it. */
  private async assertLabelUsable(userId: string, input: StartInput): Promise<void> {
    const label = input.label?.trim();
    if (!label || input.connectionId) return;
    const mine = await this.prisma.connection.findMany({ where: { userId }, select: { label: true, accountEmail: true } });
    const holder = mine.find((c) => c.label.toLowerCase() === label.toLowerCase());
    if (holder && holder.accountEmail.toLowerCase() !== (input.loginHint ?? '').trim().toLowerCase()) throw new ConnectionError('CONNECTION_LABEL_TAKEN', 'You already have a connection with this name.');
  }

  // ---- the callback ----

  /**
   * The callback of the authorization (public route). Never throws for a bad request: it answers with a closed outcome the
   * controller puts on the redirect to the return page. Never echoes the provider's parameters.
   */
  async handleCallback(provider: string, params: { code?: string; state?: string; error?: string; errorDescription?: string }, bindingFor: (cookieName: string) => string | undefined): Promise<CallbackResult> {
    const fail = (outcome: CallbackOutcome, returnTo = DEFAULT_RETURN_TO): CallbackResult => ({ outcome, returnTo });
    if (!isProviderId(provider)) return fail('state_invalid');
    if (!params.state || params.state.length > 200) return fail('state_invalid');
    const flow = await this.prisma.connectionFlow.findUnique({ where: { stateHash: sha256Hex(params.state) } });
    if (!flow || flow.provider !== provider) return fail('state_invalid');
    if (flow.expiresAt.getTime() < this.clock()) {
      await this.discard(flow.userId, flow.id);
      return fail('expired');
    }
    // The flow is bound to the browser that started it: a state alone (a copied link, another user's session) is not enough.
    const binding = bindingFor(bindingCookieName(params.state));
    if (!binding || !safeEqual(sha256Hex(binding), flow.bindingHash)) return this.failed(flow.userId, flow.id, provider, 'binding_invalid', DEFAULT_RETURN_TO);
    // Single use: claim (delete) the flow atomically before anything is exchanged.
    const claimed = await this.prisma.connectionFlow.deleteMany({ where: { id: flow.id } });
    if (claimed.count !== 1) return fail('state_invalid');
    const verifier = await this.store.verifier(flow.userId, flow.id).catch(() => null);
    await this.store.clearVerifier(flow.userId, flow.id).catch(() => undefined);
    const back = safeReturnTo(flow.returnTo);
    if (!verifier) return this.failed(flow.userId, flow.id, provider, 'state_invalid', back, undefined, { cause: 'verifier_missing' });

    if (params.error) {
      const code = /^[a-z_]{1,40}$/.test(params.error) ? params.error : 'refused';
      await this.events.audit(flow.userId, CONNECTION_AUDIT.connectFailed, flow.connectionId ?? flow.id, { provider, reason: code });
      // Told apart by the provider's adapter (Microsoft: the owner declined, or an administrator has to approve the app).
      const kind = this.registry.get(provider)?.classifyAuthorizationError?.(code, params.errorDescription?.slice(0, 1000) ?? null) ?? null;
      const outcome: CallbackOutcome = kind === 'admin_consent_required' ? 'admin_consent_required' : kind === 'denied' || code === 'access_denied' ? 'denied' : 'refused';
      this.events.count(provider, outcome === 'denied' ? 'denied' : 'failed');
      return fail(outcome, back);
    }
    if (!params.code || params.code.length > 4096) return this.failed(flow.userId, flow.id, provider, 'exchange_failed', back);

    const adapter = this.registry.get(provider);
    const app = adapter ? await this.apps.app(provider, { ignoreSwitch: true }) : null;
    if (!adapter || !app) return this.failed(flow.userId, flow.id, provider, 'provider_unavailable', back);

    let tokens: TokenSet & { accountId: string; email: string; name: string | null };
    try {
      tokens = await adapter.exchangeCode({ app, code: params.code, verifier });
    } catch (e) {
      // The consent screen was passed but the organization requires an administrator's approval: not a failure of the owner's.
      return this.failed(flow.userId, flow.id, provider, e instanceof OAuthClientError && e.oauthError === 'admin_consent_required' ? 'admin_consent_required' : 'exchange_failed', back, undefined, causeOf(e));
    }

    try {
      return await this.complete({ ...flow, provider }, adapter, app, tokens, back);
    } catch (e) {
      await this.revokeQuietly(adapter, app, tokens.refreshToken ?? tokens.accessToken, tokens.refreshToken ? 'refresh_token' : 'access_token');
      return this.failed(flow.userId, flow.id, provider, 'exchange_failed', back, undefined, { ...causeOf(e), cause: 'save_failed' });
    }
  }

  private async complete(flow: { id: string; userId: string; provider: ConnectionProviderId; capabilities: string[]; label: string | null; connectionId: string | null }, adapter: ConnectionProviderAdapter, app: ProviderApp, tokens: TokenSet & { accountId: string; email: string; name: string | null }, back: string): Promise<CallbackResult> {
    const userId = flow.userId;
    const provider = flow.provider;
    const requested = normalizeCapabilities(flow.capabilities.filter((c): c is Capability => (CAPABILITIES as readonly string[]).includes(c)));

    const existing = flow.connectionId
      ? await this.prisma.connection.findFirst({ where: { id: flow.connectionId, userId } })
      : await this.prisma.connection.findUnique({ where: { userId_provider_accountId: { userId, provider, accountId: tokens.accountId } } });
    if (flow.connectionId && !existing) {
      await this.revokeQuietly(adapter, app, tokens.refreshToken ?? tokens.accessToken, tokens.refreshToken ? 'refresh_token' : 'access_token');
      return this.failed(userId, flow.id, provider, 'state_invalid', back);
    }
    // An incremental consent must be for the same account: a different one would graft its permissions onto this connection.
    if (existing && flow.connectionId && existing.accountId !== tokens.accountId) {
      await this.revokeQuietly(adapter, app, tokens.refreshToken ?? tokens.accessToken, tokens.refreshToken ? 'refresh_token' : 'access_token');
      return this.failed(userId, flow.id, provider, 'account_mismatch', back, existing.id);
    }

    const previousRefresh = existing ? await this.store.refreshToken(userId, existing.id).catch(() => null) : null;
    const refreshToken = tokens.refreshToken ?? previousRefresh;
    if (!refreshToken) {
      await this.revokeQuietly(adapter, app, tokens.accessToken, 'access_token');
      return this.failed(userId, flow.id, provider, 'no_refresh_token', back, existing?.id);
    }

    // What the provider says it granted, nothing assumed: an empty answer grants nothing (an adapter fills in the requested scopes when its provider omits `scope`, RFC 6749 §5.1).
    const grantedScopes = union(existing?.grantedScopes ?? [], tokens.scopes);
    const granted = adapter.capabilitiesGranted(grantedScopes);
    const desired = existing ? normalizeCapabilities([...requested, ...capabilitiesOf(existing)]) : requested;
    const capabilities = keepSupported(desired, granted);
    const missing = desired.filter((c) => !capabilities.includes(c));

    if (!existing) {
      if (capabilities.length === 0) {
        await this.revokeQuietly(adapter, app, refreshToken, 'refresh_token');
        return this.failed(userId, flow.id, provider, 'nothing_granted', back);
      }
      if ((await this.prisma.connection.count({ where: { userId } })) >= MAX_CONNECTIONS_PER_USER) {
        await this.revokeQuietly(adapter, app, refreshToken, 'refresh_token');
        return this.failed(userId, flow.id, provider, 'limit', back);
      }
    }

    const now = new Date(this.clock());
    let row: Connection;
    let created = false;
    if (existing) {
      // The tokens first, then the row: a failure to store leaves the row as it was.
      await this.store.setRefreshToken(userId, existing.id, refreshToken);
      await this.store.setAccessToken(userId, existing.id, tokens.accessToken);
      row = await this.prisma.connection.update({
        where: { id: existing.id },
        data: {
          accountEmail: tokens.email,
          accountName: tokens.name,
          capabilities,
          grantedScopes,
          defaultFor: this.keepDefaults(existing.defaultFor, capabilities),
          status: 'active',
          statusReason: null,
          accessExpiresAt: tokens.expiresAt,
          lastRefreshAt: now,
          refreshLeaseUntil: null,
          reconnectNotifiedAt: null,
        },
      });
    } else {
      const taken = (await this.prisma.connection.findMany({ where: { userId }, select: { label: true } })).map((c) => c.label);
      const label = uniqueLabel((flow.label?.trim() || defaultLabel(provider, tokens.email)).slice(0, 60), taken);
      try {
        row = await this.prisma.connection.create({
          data: { userId, provider, accountId: tokens.accountId, accountEmail: tokens.email, accountName: tokens.name, label, capabilities, grantedScopes, status: 'active', accessExpiresAt: tokens.expiresAt, lastRefreshAt: now },
        });
        created = true;
      } catch (e) {
        if ((e as { code?: string }).code !== 'P2002') throw e;
        // Another flow for the same account finished first: this one updates it.
        const again = await this.prisma.connection.findUnique({ where: { userId_provider_accountId: { userId, provider, accountId: tokens.accountId } } });
        if (!again) throw e;
        row = again;
      }
      try {
        await this.store.setRefreshToken(userId, row.id, refreshToken);
        await this.store.setAccessToken(userId, row.id, tokens.accessToken);
      } catch (e) {
        if (created) await this.prisma.connection.deleteMany({ where: { id: row.id } });
        throw e;
      }
    }
    // A reconnect replaces the grant: the old refresh token is revoked at the provider (best effort).
    if (previousRefresh && previousRefresh !== refreshToken) await this.revokeQuietly(adapter, app, previousRefresh, 'refresh_token');

    await this.events.audit(userId, created ? CONNECTION_AUDIT.created : CONNECTION_AUDIT.updated, row.id, { provider, capabilities, missing, change: created ? 'connected' : flow.connectionId ? 'consent_added' : 'reconnected' });
    this.events.count(provider, created ? 'connected' : flow.connectionId ? 'consent_added' : 'reconnected');
    return { outcome: 'connected', returnTo: back, connectionId: row.id, ...(missing.length > 0 ? { missing } : {}) };
  }

  /** The groups an account stays the default for: those that still have a capability switched on. */
  private keepDefaults(defaultFor: readonly string[], capabilities: readonly Capability[]): string[] {
    const groups = groupsOf(capabilities) as string[];
    return defaultFor.filter((g) => groups.includes(g));
  }

  /**
   * A failed connect: audited with the closed reason and, when there is one, the closed cause (an `OAuthClientError`'s kind, the
   * provider's RFC 6749 code and HTTP status, or an error name): enough to tell a wrong client secret from a redirect mismatch, an
   * unreachable token endpoint or a save failure, never a message, a code, a state, a token or any text from the provider (#670).
   */
  private async failed(userId: string, flowId: string, provider: ConnectionProviderId, outcome: CallbackOutcome, returnTo: string, connectionId?: string, cause?: FailureCause): Promise<CallbackResult> {
    await this.events.audit(userId, CONNECTION_AUDIT.connectFailed, connectionId ?? flowId, { provider, reason: outcome, ...(cause ?? {}) });
    this.log.warn(`connect failed: provider=${provider} reason=${outcome}${cause ? ` ${Object.entries(cause).map(([k, v]) => `${k}=${v}`).join(' ')}` : ''}`);
    this.events.count(provider, 'failed');
    return { outcome, returnTo, ...(connectionId ? { connectionId } : {}) };
  }

  private async revokeQuietly(adapter: ConnectionProviderAdapter, app: ProviderApp, token: string, hint: 'access_token' | 'refresh_token'): Promise<void> {
    try {
      await adapter.revoke({ app, token, hint });
    } catch {
      // best effort
    }
  }

  /** Deletes a flow and its verifier (expired or abandoned). */
  async discard(userId: string, flowId: string): Promise<void> {
    await this.prisma.connectionFlow.deleteMany({ where: { id: flowId } });
    await this.store.clearVerifier(userId, flowId).catch(() => undefined);
  }

  /** Housekeeping (the health job): flows past their expiry. */
  async purgeExpired(now = new Date(this.clock()), limit = 200): Promise<number> {
    const rows = await this.prisma.connectionFlow.findMany({ where: { expiresAt: { lt: now } }, select: { id: true, userId: true }, take: limit });
    for (const r of rows) await this.discard(r.userId, r.id);
    return rows.length;
  }
}

