// Connecting the owner's Vault (E37.2, #591): OAuth 2.1 authorization code with PKCE against Vault's own
// consent screen, run by the console as a confidential client.
//
//   connect      discovery, then a PKCE verifier and `state` kept SERVER-SIDE (the verifier encrypted in the
//                credential store, `state` and a browser-binding value only as SHA-256 hashes on the connection
//                row), a redirect URL with the `resource` indicator and the scopes `vault:items_read
//                vault:items_fill offline_access` (`vault:items_write` only on request).
//   callback     public (the browser arrives from Vault without our bearer token), so the flow is bound to the
//                browser that started it: `state` must match a pending row AND the HttpOnly binding cookie set on
//                `connect` must match its hash. The row's pending fields are claimed atomically, so a code is used
//                once. Then: exchange (with `resource`), `whoami`, store the refresh token, write the row.
//   disconnect   revoke at Vault, delete the tokens, mark the row disconnected.
//
// What is stored: the refresh token and access token encrypted in the credential store; the row holds only what the
// owner may read. A token, a client secret, a verifier and a code never reach a log line, a span, an audit event or
// an API response.
import { HttpException, HttpStatus, Inject, Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { SecretsConnection } from '@prisma/client';

import { OAuthClientError, OAuthClientService, OutboundHttp, OutboundHttpError, codeChallengeS256, newCodeVerifier, normalizeBaseUrl, randomToken, safeEqual, sha256Hex, type OAuthServerEndpoints } from '../oauth-client';
import { PrismaService } from '../prisma/prisma.service';
import { FABRIC_SECRETS_REGISTRY, type FabricSecretsRegistry } from './fabric-secrets-registry';
import { SecretsPolicyService, type AgentUseState } from './secrets-policy.service';
import { SECRETS_AUDIT, SecretsEvents, hostOf } from './secrets.events';
import { VaultApiClient } from './vault-api.client';
import { VaultClientConfigs, type VaultClientSummary } from './vault-client.config';
import { VAULT_OAUTH_PATHS, vaultConnectScopes, vaultResource } from './vault-contract';
import { VaultGrantStore, type PendingVaultFlow } from './vault-grant.store';
import { VaultTokenService } from './vault-token.service';
import { VAULT_CALLBACK_PATH } from './secrets.paths';
import './secrets.errors';

/** How long a Connect may take between the redirect and the callback. */
export const CONNECT_TTL_MS = 10 * 60_000;
/** The page the browser returns to when `connect` names none (the Secrets page, E37.4). */
export const DEFAULT_RETURN_TO = '/settings/secrets';
/** The binding cookie. */
export const BINDING_COOKIE = 'hx_secrets_vault';
export const CALLBACK_PATH = VAULT_CALLBACK_PATH;

export type ConnectionStatus = 'not_configured' | 'disconnected' | 'connected' | 'needs_reconnect';
/** What the callback tells the browser (a query value on the return page): a closed set. */
export type CallbackOutcome = 'connected' | 'state_invalid' | 'expired' | 'binding_invalid' | 'denied' | 'refused' | 'issuer_mismatch' | 'exchange_failed' | 'no_refresh_token' | 'whoami_failed';

export interface VaultStatusView extends VaultClientSummary {
  provider: 'vault';
  status: ConnectionStatus;
  /** The address Vault must have registered as this client's redirect URI. */
  redirectUri: string;
  scopes: string[];
  vaultUserId: string | null;
  /** Whether Vault's own agent access switch is on: from `whoami` or the last 403. */
  agentAccess: 'on' | 'off' | 'unknown';
  connectedAt: string | null;
  lastUsedAt: string | null;
  lastSuccessAt: string | null;
  /** A stable code (`GRANT_REVOKED`, `ORIGIN_MISMATCH`, ...), never a message. */
  lastErrorCode: string | null;
  /** A Connect was started and its callback has not arrived. */
  connecting: boolean;
}

export interface SecretsStatusView {
  agentUse: AgentUseState;
  providers: { vault: VaultStatusView };
}

/** The outcome of one fabric or provider call, as the runner reports it (E37.3). Codes are the provider contract's. */
export type ProviderOutcome = { ok: true } | { ok: false; code: string };

function problem(status: HttpStatus, code: string, message: string, details?: Record<string, unknown>): HttpException {
  return new HttpException({ code, message, ...(details ? { details } : {}) }, status);
}

/** A path on this console, or the default: never an absolute URL (no open redirect). */
export function safeReturnTo(raw: string | null | undefined): string {
  if (!raw || raw.length > 200 || !/^\/[A-Za-z0-9/_\-.?=&%#]*$/.test(raw) || raw.startsWith('//')) return DEFAULT_RETURN_TO;
  return raw;
}

@Injectable()
export class VaultConnectionService {
  private readonly log = new Logger(VaultConnectionService.name);

  /** The wall clock; tests replace it. */
  clock: () => number = Date.now;

  constructor(
    private readonly prisma: PrismaService,
    private readonly config: ConfigService,
    private readonly http: OutboundHttp,
    private readonly oauth: OAuthClientService,
    private readonly api: VaultApiClient,
    private readonly store: VaultGrantStore,
    private readonly configs: VaultClientConfigs,
    private readonly tokens: VaultTokenService,
    private readonly policy: SecretsPolicyService,
    private readonly events: SecretsEvents,
    @Inject(FABRIC_SECRETS_REGISTRY) private readonly fabric: FabricSecretsRegistry,
  ) {}

  // ---- reading ----

  private row(userId: string): Promise<SecretsConnection | null> {
    return this.prisma.secretsConnection.findUnique({ where: { userId_provider: { userId, provider: 'vault' } } });
  }

  /** The scopes the owner's live grant holds (empty when not connected): what the runner reads to offer identity details. */
  async grantedScopes(userId: string): Promise<string[]> {
    const row = await this.row(userId);
    return row?.status === 'connected' ? [...(row.scopes ?? [])] : [];
  }

  /** The address Vault must list as the client's redirect URI. */
  redirectUri(): string {
    return `${(this.config.get<string>('appUrl') ?? process.env.APP_URL ?? 'http://localhost:3535').replace(/\/+$/, '')}${CALLBACK_PATH}`;
  }

  /** `GET /api/secrets/status`: what the owner may read; never a token, a secret or a message from Vault. */
  async status(userId: string): Promise<SecretsStatusView> {
    const row = await this.row(userId);
    const [agentUse, client] = await Promise.all([this.policy.agentUse(userId), this.configs.summary(userId, row)]);
    const status: ConnectionStatus = row && row.status !== 'disconnected' ? row.status : client.configured ? 'disconnected' : 'not_configured';
    const iso = (d: Date | null | undefined) => (d ? d.toISOString() : null);
    const agentAccess = row?.agentAccess === 'on' || row?.agentAccess === 'off' ? row.agentAccess : 'unknown';
    return {
      agentUse,
      providers: {
        vault: {
          provider: 'vault',
          ...client,
          status,
          redirectUri: this.redirectUri(),
          scopes: row?.status === 'connected' || row?.status === 'needs_reconnect' ? (row.scopes ?? []) : [],
          vaultUserId: row?.status === 'connected' ? row.providerUserId : null,
          agentAccess: row?.status === 'connected' ? agentAccess : 'unknown',
          connectedAt: iso(row?.connectedAt),
          lastUsedAt: iso(row?.lastUsedAt),
          lastSuccessAt: iso(row?.lastSuccessAt),
          lastErrorCode: row?.lastErrorCode ?? null,
          connecting: Boolean(row?.pendingStateHash && row.pendingExpiresAt && row.pendingExpiresAt.getTime() > this.clock()),
        },
      },
    };
  }

  // ---- configuring ----

  /** Refuses an address the console would not call. */
  private async assertAddress(baseUrl: string, allowedHosts: readonly string[]): Promise<void> {
    try {
      await this.http.check(baseUrl, allowedHosts);
    } catch (e) {
      throw problem(HttpStatus.UNPROCESSABLE_ENTITY, 'SECRETS_VAULT_URL_REFUSED', 'This Vault address is not allowed.', { reason: e instanceof OutboundHttpError ? e.code : 'invalid_url' });
    }
  }

  /**
   * The owner's own Vault address, client id and (write-only) client secret. A blank secret keeps the stored one.
   * The address is validated now and again on every call. It cannot change while connected.
   */
  async saveClient(userId: string, input: { baseUrl: string; clientId: string; clientSecret?: string | null }): Promise<SecretsStatusView> {
    let baseUrl: string;
    try {
      baseUrl = normalizeBaseUrl(input.baseUrl);
    } catch {
      throw problem(HttpStatus.UNPROCESSABLE_ENTITY, 'SECRETS_VAULT_URL_REFUSED', 'This Vault address is not allowed.', { reason: 'invalid_url' });
    }
    const system = await this.policy.system();
    await this.assertAddress(baseUrl, system.vault.allowedHosts);
    const existing = await this.row(userId);
    if (existing?.status === 'connected' && (this.sameAddress(existing.baseUrl ?? system.vault.baseUrl, baseUrl) === false || (existing.clientId ?? system.vault.clientId) !== input.clientId)) {
      throw problem(HttpStatus.CONFLICT, 'SECRETS_VAULT_DISCONNECT_FIRST', 'Disconnect the Vault before changing its address or client.');
    }
    if (input.clientSecret) await this.store.setClientSecret(userId, input.clientSecret);
    const row = await this.prisma.secretsConnection.upsert({
      where: { userId_provider: { userId, provider: 'vault' } },
      create: { userId, provider: 'vault', baseUrl, clientId: input.clientId },
      update: { baseUrl, clientId: input.clientId },
    });
    if (existing?.baseUrl) this.oauth.forget(existing.baseUrl);
    this.oauth.forget(baseUrl);
    await this.events.audit(userId, SECRETS_AUDIT.clientSaved, row.id, { provider: 'vault', host: hostOf(baseUrl), secretSet: Boolean(input.clientSecret) });
    return this.status(userId);
  }

  private sameAddress(a: string | null, b: string): boolean {
    try {
      return a !== null && normalizeBaseUrl(a) === normalizeBaseUrl(b);
    } catch {
      return false;
    }
  }

  // ---- connecting ----

  /**
   * Starts the flow: returns the URL to send the owner's browser to and the value of the binding cookie the
   * controller must set. `allowWrite` adds `vault:items_write` (a new consent), only for E37.4's switch.
   */
  async connect(userId: string, opts: { allowWrite?: boolean; allowIdentity?: boolean; allowCards?: boolean; allowServiceKeys?: boolean; returnTo?: string | null } = {}): Promise<{ authorizeUrl: string; expiresAt: Date; binding: string }> {
    const row = await this.row(userId);
    const config = await this.configs.effective(userId, row);
    if (!config?.clientSecret) throw problem(HttpStatus.CONFLICT, 'SECRETS_VAULT_NOT_CONFIGURED', 'Set the Vault address, client id and client secret first.');
    await this.assertAddress(config.baseUrl, config.allowedHosts);

    let endpoints: OAuthServerEndpoints;
    try {
      endpoints = await this.oauth.discover(config.baseUrl, { metadataPath: VAULT_OAUTH_PATHS.metadata, fallback: VAULT_OAUTH_PATHS, allowedHosts: config.allowedHosts });
    } catch (e) {
      throw problem(HttpStatus.BAD_GATEWAY, 'SECRETS_VAULT_CONNECT_FAILED', 'The Vault did not answer as an OAuth server.', { reason: e instanceof OAuthClientError ? e.kind : 'unavailable' });
    }

    const state = randomToken(32);
    const binding = randomToken(32);
    const verifier = newCodeVerifier();
    const scopes = vaultConnectScopes(opts.allowWrite === true, opts.allowIdentity === true, opts.allowCards === true, opts.allowServiceKeys === true);
    const expiresAt = new Date(this.clock() + CONNECT_TTL_MS);
    const flow: PendingVaultFlow = {
      verifier,
      redirectUri: this.redirectUri(),
      baseUrl: config.baseUrl,
      clientId: config.clientId,
      scopes,
      returnTo: safeReturnTo(opts.returnTo),
      issuer: endpoints.issuer,
      issuerInResponse: endpoints.issuerInResponse,
      tokenEndpoint: endpoints.tokenEndpoint,
      authorizationEndpoint: endpoints.authorizationEndpoint,
      revocationEndpoint: endpoints.revocationEndpoint,
    };
    await this.store.setPending(userId, flow);
    const saved = await this.prisma.secretsConnection.upsert({
      where: { userId_provider: { userId, provider: 'vault' } },
      create: { userId, provider: 'vault', pendingStateHash: sha256Hex(state), pendingBindingHash: sha256Hex(binding), pendingExpiresAt: expiresAt, pendingScopes: scopes },
      update: { pendingStateHash: sha256Hex(state), pendingBindingHash: sha256Hex(binding), pendingExpiresAt: expiresAt, pendingScopes: scopes },
    });
    const authorizeUrl = this.oauth.authorizeUrl(endpoints, { clientId: config.clientId, redirectUri: flow.redirectUri, scopes, state, codeChallenge: codeChallengeS256(verifier), resource: vaultResource(config.baseUrl) });
    await this.events.audit(userId, SECRETS_AUDIT.connectStarted, saved.id, { provider: 'vault', host: hostOf(config.baseUrl), scopes });
    return { authorizeUrl, expiresAt, binding };
  }

  /**
   * The callback of the authorization (public route). Never throws for a bad request: it answers with a closed
   * outcome the controller puts on the redirect to the return page. Never echoes the provider's parameters.
   */
  async handleCallback(params: { code?: string; state?: string; error?: string; iss?: string }, binding: string | undefined): Promise<{ outcome: CallbackOutcome; returnTo: string }> {
    const fail = (outcome: CallbackOutcome, returnTo = DEFAULT_RETURN_TO) => ({ outcome, returnTo });
    if (!params.state || params.state.length > 200) return fail('state_invalid');
    const stateHash = sha256Hex(params.state);
    const row = await this.prisma.secretsConnection.findUnique({ where: { pendingStateHash: stateHash } });
    if (!row) return fail('state_invalid');
    const userId = row.userId;
    if (!row.pendingExpiresAt || row.pendingExpiresAt.getTime() < this.clock()) {
      await this.abandonPending(row);
      return fail('expired');
    }
    // The flow is bound to the browser that started it: a state alone (a copied link) is not enough.
    if (!binding || !row.pendingBindingHash || !safeEqual(sha256Hex(binding), row.pendingBindingHash)) return fail('binding_invalid');
    // Single use: claim the pending fields atomically before anything is exchanged.
    const claimed = await this.prisma.secretsConnection.updateMany({ where: { id: row.id, pendingStateHash: stateHash }, data: { pendingStateHash: null, pendingBindingHash: null, pendingExpiresAt: null, pendingScopes: [] } });
    if (claimed.count !== 1) return fail('state_invalid');
    const flow = await this.store.pending(userId);
    await this.store.clearPending(userId);
    if (!flow) return fail('state_invalid');
    const back = safeReturnTo(flow.returnTo);

    if (params.error) {
      const code = /^[a-z_]{1,40}$/.test(params.error) ? params.error : 'refused';
      await this.events.audit(userId, SECRETS_AUDIT.connectFailed, row.id, { provider: 'vault', host: hostOf(flow.baseUrl), reason: code });
      return fail(code === 'access_denied' ? 'denied' : 'refused', back);
    }
    if ((params.iss !== undefined || flow.issuerInResponse) && (!params.iss || !this.sameAddress(params.iss, flow.issuer))) return this.failed(userId, row.id, flow, 'issuer_mismatch', back);
    if (!params.code || params.code.length > 4096) return this.failed(userId, row.id, flow, 'exchange_failed', back);

    const config = await this.configs.effective(userId, { baseUrl: flow.baseUrl, clientId: flow.clientId });
    if (!config?.clientSecret) return this.failed(userId, row.id, flow, 'exchange_failed', back);
    const endpoints: OAuthServerEndpoints = { issuer: flow.issuer, authorizationEndpoint: flow.authorizationEndpoint, tokenEndpoint: flow.tokenEndpoint, revocationEndpoint: flow.revocationEndpoint, issuerInResponse: flow.issuerInResponse };
    const creds = { clientId: flow.clientId, clientSecret: config.clientSecret };
    const resource = vaultResource(flow.baseUrl);

    let tokens;
    try {
      tokens = await this.oauth.exchangeCode(endpoints, creds, { code: params.code, verifier: flow.verifier, redirectUri: flow.redirectUri, resource, allowedHosts: config.allowedHosts });
    } catch {
      return this.failed(userId, row.id, flow, 'exchange_failed', back);
    }
    if (!tokens.refreshToken) {
      await this.revokeQuietly(endpoints, creds, tokens.accessToken, 'access_token', config.allowedHosts);
      return this.failed(userId, row.id, flow, 'no_refresh_token', back);
    }

    const who = await this.api.whoami(flow.baseUrl, tokens.accessToken, config.allowedHosts);
    if (who.status !== 'ok' && who.status !== 'agent_access_disabled') {
      await this.revokeQuietly(endpoints, creds, tokens.refreshToken, 'refresh_token', config.allowedHosts);
      return this.failed(userId, row.id, flow, 'whoami_failed', back);
    }

    const previous = await this.store.refreshToken(userId);
    await this.store.setRefreshToken(userId, tokens.refreshToken);
    await this.store.setAccessToken(userId, tokens.accessToken);
    const scopes = tokens.scopes.length > 0 ? tokens.scopes : who.status === 'ok' ? who.whoami.scopes : [];
    const now = new Date(this.clock());
    await this.prisma.secretsConnection.update({
      where: { id: row.id },
      data: {
        status: 'connected',
        scopes,
        providerUserId: who.status === 'ok' ? who.whoami.userId : null,
        agentAccess: who.status === 'ok' ? 'on' : 'off',
        accessExpiresAt: tokens.expiresAt,
        refreshLeaseUntil: null,
        connectedAt: now,
        lastSuccessAt: now,
        lastErrorCode: who.status === 'ok' ? null : 'AGENT_ACCESS_DISABLED',
        lastErrorAt: who.status === 'ok' ? null : now,
        reconnectNotifiedAt: null,
      },
    });
    // A reconnect (for example to add the write scope) replaces the grant: the old one is revoked at Vault.
    if (previous && previous !== tokens.refreshToken) await this.revokeQuietly(endpoints, creds, previous, 'refresh_token', config.allowedHosts);
    await this.events.audit(userId, SECRETS_AUDIT.connected, row.id, { provider: 'vault', host: hostOf(flow.baseUrl), scopes, agentAccess: who.status === 'ok' ? 'on' : 'off' });
    return { outcome: 'connected', returnTo: back };
  }

  private async failed(userId: string, rowId: string, flow: PendingVaultFlow, outcome: CallbackOutcome, returnTo: string) {
    await this.prisma.secretsConnection.update({ where: { id: rowId }, data: { lastErrorCode: `CONNECT_${outcome.toUpperCase()}`.slice(0, 60), lastErrorAt: new Date(this.clock()) } });
    await this.events.audit(userId, SECRETS_AUDIT.connectFailed, rowId, { provider: 'vault', host: hostOf(flow.baseUrl), reason: outcome });
    return { outcome, returnTo };
  }

  private async abandonPending(row: SecretsConnection): Promise<void> {
    await this.prisma.secretsConnection.updateMany({ where: { id: row.id }, data: { pendingStateHash: null, pendingBindingHash: null, pendingExpiresAt: null, pendingScopes: [] } });
    await this.store.clearPending(row.userId);
  }

  private async revokeQuietly(endpoints: OAuthServerEndpoints, creds: { clientId: string; clientSecret: string }, token: string, hint: 'access_token' | 'refresh_token', allowedHosts: readonly string[]): Promise<boolean> {
    try {
      return (await this.oauth.revoke(endpoints, creds, { token, hint, allowedHosts })).revoked;
    } catch {
      return false;
    }
  }

  // ---- disconnecting ----

  /**
   * Revokes the grant at Vault (best effort: an unreachable Vault is reported as `revoked: false` so the owner can
   * remove the app in Vault's Connected apps), deletes the stored tokens, tells the fabric to forget the provider and
   * marks the row disconnected. `forgetClient` also forgets the owner's own address, client id and client secret.
   */
  async disconnect(userId: string, opts: { forgetClient?: boolean } = {}): Promise<{ revoked: boolean; status: SecretsStatusView }> {
    const row = await this.row(userId);
    let revoked = false;
    if (row) {
      const [refresh, access] = await Promise.all([this.store.refreshToken(userId), this.store.accessToken(userId)]);
      if (refresh || access) {
        const config = await this.configs.effective(userId, row);
        if (config?.clientSecret) {
          try {
            const endpoints = await this.oauth.discover(config.baseUrl, { metadataPath: VAULT_OAUTH_PATHS.metadata, fallback: VAULT_OAUTH_PATHS, allowedHosts: config.allowedHosts });
            const creds = { clientId: config.clientId, clientSecret: config.clientSecret };
            const r1 = refresh ? await this.revokeQuietly(endpoints, creds, refresh, 'refresh_token', config.allowedHosts) : true;
            const r2 = access ? await this.revokeQuietly(endpoints, creds, access, 'access_token', config.allowedHosts) : true;
            revoked = r1 && r2;
          } catch {
            revoked = false;
          }
        }
      } else {
        revoked = true;
      }
      await this.store.clearGrant(userId);
      await this.store.clearPending(userId);
      await this.prisma.secretsConnection.update({
        where: { id: row.id },
        data: {
          status: 'disconnected',
          scopes: [],
          providerUserId: null,
          agentAccess: 'unknown',
          accessExpiresAt: null,
          refreshLeaseUntil: null,
          connectedAt: null,
          lastErrorCode: null,
          lastErrorAt: null,
          reconnectNotifiedAt: null,
          pendingStateHash: null,
          pendingBindingHash: null,
          pendingExpiresAt: null,
          pendingScopes: [],
          ...(opts.forgetClient ? { baseUrl: null, clientId: null } : {}),
        },
      });
      if (opts.forgetClient) {
        await this.store.deleteClientSecret(userId);
        if (row.baseUrl) this.oauth.forget(row.baseUrl);
      }
      await this.events.audit(userId, SECRETS_AUDIT.disconnected, row.id, { provider: 'vault', host: hostOf(row.baseUrl), revoked, forgotClient: opts.forgetClient === true });
    }
    await this.fabric.unregisterSecretsProvider(userId, 'vault').catch((e: unknown) => this.log.warn(`the fabric could not be told to forget the provider (${e instanceof Error ? e.name : 'error'})`));
    return { revoked, status: await this.status(userId) };
  }

  // ---- reported by the fabric path (E37.3) ----

  /**
   * Records the outcome of a call the fabric made with the owner's access token. A `401` means the grant is gone:
   * the connection becomes `needs_reconnect` and the owner is notified once. Codes are the provider contract's
   * (`UNAUTHORIZED`, `DISABLED`, `ORIGIN_MISMATCH`, ...); anything else that is not a plain code is dropped.
   */
  async recordOutcome(userId: string, outcome: ProviderOutcome): Promise<void> {
    const now = new Date(this.clock());
    if (outcome.ok) {
      await this.prisma.secretsConnection.updateMany({ where: { userId, provider: 'vault', status: 'connected' }, data: { lastUsedAt: now, lastSuccessAt: now, lastErrorCode: null, lastErrorAt: null, agentAccess: 'on' } });
      return;
    }
    const code = /^[A-Z][A-Z_]{0,59}$/.test(outcome.code) ? outcome.code : 'UNKNOWN';
    if (code === 'UNAUTHORIZED') {
      await this.tokens.markNeedsReconnect(userId, 'UNAUTHORIZED');
      return;
    }
    await this.prisma.secretsConnection.updateMany({
      where: { userId, provider: 'vault', status: 'connected' },
      data: { lastUsedAt: now, lastErrorCode: code, lastErrorAt: now, ...(code === 'DISABLED' ? { agentAccess: 'off' } : {}) },
    });
  }
}
