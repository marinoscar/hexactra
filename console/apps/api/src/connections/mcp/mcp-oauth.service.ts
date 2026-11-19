// Signing in to an MCP server with OAuth, as the MCP authorization specification defines it (E39.9, #606): discovery from the server's
// protected-resource metadata (RFC 9728), the authorization server's metadata (RFC 8414), a client that is either dynamically registered
// (RFC 7591) or the one the owner supplied, authorization code with PKCE (S256) and the `resource` parameter (RFC 8707). The exchange and
// the refresh are the console's outbound OAuth client (`OAuthClientService`) over the SSRF-guarded transport, as for Google and Microsoft.
//
// The browser comes back to `/api/connections/callback/mcp` and is bound to the flow exactly as for any connection: single-use `state`, an
// HttpOnly binding cookie, ten minutes. What the callback needs (the server's endpoints, the client) is kept in the credential store under
// `connection_mcp_secret`, never in the flow row. A token, a code, a verifier and a client secret never reach a log, a span or a response.
import { Injectable, Logger, type OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { Connection } from '@prisma/client';

import { OAuthClientError, OAuthClientService, OutboundHttp, OutboundHttpError, codeChallengeS256, newCodeVerifier, randomToken, safeEqual, sha256Hex, type OAuthServerEndpoints } from '../../oauth-client';
import { PrismaService } from '../../prisma/prisma.service';
import { CONNECT_TTL_MS, DEFAULT_RETURN_TO, MAX_CONNECTIONS_PER_USER } from '../connections.constants';
import { ConnectionError } from '../connections.errors';
import { CONNECTION_AUDIT, ConnectionEvents } from '../connections.events';
import { bindingCookieName, safeReturnTo, type CallbackResult, type StartResult } from '../connection-flow.service';
import { uniqueLabel } from '../connection-labels';
import { ConnectionTokenStore } from '../connection-token.store';
import { ConnectionTokensService } from '../connection-tokens.service';
import type { TokenSet } from '../provider';
import { McpCatalogService } from './mcp-catalog.service';
import { readMcpConfig, type McpConfig, type McpOAuthMeta } from './mcp-config';
import { McpConnector, toConnectionError } from './mcp-connector.service';
import { McpSecretStore, type McpOAuthClient } from './mcp-secrets';
import { checkHostLists, hostMatches, urlError } from './mcp-url';
import { accountIdOf, canonicalResource, hostLabel } from './mcp-account';

const MAX_DOC_BYTES = 64 * 1024;

const isRecord = (v: unknown): v is Record<string, unknown> => v !== null && typeof v === 'object' && !Array.isArray(v);
const str = (v: unknown): string | null => (typeof v === 'string' && v.length > 0 ? v : null);

function parseJson(body: string): unknown {
  try {
    return JSON.parse(body);
  } catch {
    return null;
  }
}

/** The `resource_metadata` URL a server's `WWW-Authenticate` challenge names, if any. */
export function resourceMetadataFrom(header: string | undefined): string | null {
  const m = /resource_metadata="([^"]+)"/i.exec(header ?? '');
  return m ? m[1]! : null;
}

export const toEndpoints = (m: McpOAuthMeta): OAuthServerEndpoints => ({ issuer: m.issuer, authorizationEndpoint: m.authorizationEndpoint, tokenEndpoint: m.tokenEndpoint, revocationEndpoint: m.revocationEndpoint, issuerInResponse: m.issuerInResponse });

export interface Discovered {
  meta: McpOAuthMeta;
  registrationEndpoint: string | null;
  scopes: string[];
}

export interface StartInput {
  url: string;
  label?: string | null;
  clientId?: string | null;
  clientSecret?: string | null;
  returnTo?: string | null;
  /** Reconnect this connection (its server's sign-in again). */
  connectionId?: string | null;
}

@Injectable()
export class McpOAuthService implements OnModuleInit {
  private readonly log = new Logger(McpOAuthService.name);

  /** The wall clock; tests replace it. */
  clock: () => number = Date.now;

  constructor(
    private readonly prisma: PrismaService,
    private readonly http: OutboundHttp,
    private readonly oauth: OAuthClientService,
    private readonly connector: McpConnector,
    private readonly secrets: McpSecretStore,
    private readonly store: ConnectionTokenStore,
    private readonly tokens: ConnectionTokensService,
    private readonly catalog: McpCatalogService,
    private readonly events: ConnectionEvents,
    private readonly config: ConfigService,
  ) {}

  onModuleInit(): void {
    this.tokens.registerRefresher('mcp', (row, refreshToken) => this.refresh(row, refreshToken));
  }

  redirectUri(): string {
    return `${(this.config.get<string>('appUrl') ?? process.env.APP_URL ?? 'http://localhost:3535').replace(/\/+$/, '')}/api/connections/callback/mcp`;
  }

  // ---- discovery ----

  private async getJson(url: string): Promise<{ status: number; doc: unknown }> {
    try {
      const res = await this.http.send({ method: 'GET', url, maxBytes: MAX_DOC_BYTES, timeoutMs: 10_000 });
      return { status: res.status, doc: res.status === 200 ? parseJson(res.body) : null };
    } catch (e) {
      if (e instanceof OutboundHttpError && e.code !== 'network' && e.code !== 'timeout' && e.code !== 'too_large' && e.code !== 'aborted') throw new ConnectionError('CONNECTION_MCP_URL_REFUSED', urlError(e.code).message, { reason: e.code });
      throw new ConnectionError('CONNECTION_UNAVAILABLE', 'The server could not be reached.', { reason: 'discovery' });
    }
  }

  /** The authorization server's endpoints for an MCP server, and the scopes it publishes. `challenge` is the server's `WWW-Authenticate`. */
  async discover(serverUrl: string, challenge?: string): Promise<Discovered> {
    const target = new URL(serverUrl);
    const path = target.pathname === '/' ? '' : target.pathname.replace(/\/+$/, '');
    const fromHeader = resourceMetadataFrom(challenge);
    const resourceDocs = [...(fromHeader ? [fromHeader] : []), `${target.origin}/.well-known/oauth-protected-resource${path}`, `${target.origin}/.well-known/oauth-protected-resource`];
    let issuer = target.origin;
    let scopes: string[] = [];
    for (const u of resourceDocs) {
      const { status, doc } = await this.getJson(u);
      if (status !== 200 || !isRecord(doc)) continue;
      const servers = Array.isArray(doc.authorization_servers) ? doc.authorization_servers.filter((s): s is string => typeof s === 'string') : [];
      if (servers[0]) issuer = servers[0];
      scopes = Array.isArray(doc.scopes_supported) ? doc.scopes_supported.filter((s): s is string => typeof s === 'string' && /^[\x21\x23-\x5b\x5d-\x7e]{1,100}$/.test(s)).slice(0, 20) : [];
      break;
    }
    let issuerUrl: URL;
    try {
      issuerUrl = new URL(issuer);
    } catch {
      throw new ConnectionError('CONNECTION_MCP_PROTOCOL', 'The server named an authorization server that is not an address.');
    }
    // The authorization server is a different host from the MCP server: the SSRF guard applies, and so does the block-list.
    const lists = await this.connector.guard(serverUrl);
    try {
      checkHostLists(issuerUrl.hostname, { allowedHosts: [], blockedHosts: lists.blockedHosts });
    } catch {
      throw new ConnectionError('CONNECTION_MCP_URL_REFUSED', urlError('host_blocked').message, { reason: 'host_blocked' });
    }
    const ipath = issuerUrl.pathname === '/' ? '' : issuerUrl.pathname.replace(/\/+$/, '');
    const base = issuerUrl.origin;
    const normalizedIssuer = `${base}${ipath}`;
    let doc: Record<string, unknown> | null = null;
    for (const u of [`${base}/.well-known/oauth-authorization-server${ipath}`, `${base}/.well-known/openid-configuration${ipath}`]) {
      const r = await this.getJson(u);
      if (r.status === 200 && isRecord(r.doc)) {
        doc = r.doc;
        break;
      }
    }
    const origin = base;
    const same = (u: string | null): boolean => {
      if (!u) return true;
      try {
        return new URL(u).origin === origin;
      } catch {
        return false;
      }
    };
    let authorize: string;
    let token: string;
    let revoke: string | null = null;
    let registration: string | null = null;
    let issuerInResponse = false;
    if (doc) {
      authorize = str(doc.authorization_endpoint) ?? '';
      token = str(doc.token_endpoint) ?? '';
      revoke = str(doc.revocation_endpoint);
      registration = str(doc.registration_endpoint);
      const methods = doc.code_challenge_methods_supported;
      if (!authorize || !token) throw new ConnectionError('CONNECTION_MCP_PROTOCOL', 'The authorization server publishes no authorization or token endpoint.');
      if (Array.isArray(methods) && !methods.includes('S256')) throw new ConnectionError('CONNECTION_MCP_PROTOCOL', 'The authorization server does not support PKCE (S256).');
      if (str(doc.issuer) && str(doc.issuer)!.replace(/\/+$/, '') !== normalizedIssuer) throw new ConnectionError('CONNECTION_MCP_PROTOCOL', 'The authorization server names a different issuer than the one it was found at.');
      if (![authorize, token, revoke, registration].every(same)) throw new ConnectionError('CONNECTION_MCP_PROTOCOL', 'The authorization server metadata points to another host.');
      issuerInResponse = doc.authorization_response_iss_parameter_supported === true;
    } else {
      // The 2025-03-26 revision's defaults when a server publishes no metadata.
      authorize = `${base}/authorize`;
      token = `${base}/token`;
      registration = `${base}/register`;
    }
    return { meta: { issuer: normalizedIssuer, authorizationEndpoint: authorize, tokenEndpoint: token, revocationEndpoint: revoke, issuerInResponse, resource: canonicalResource(serverUrl) }, registrationEndpoint: registration, scopes };
  }

  /** Dynamic client registration (RFC 7591) as a public client: no secret to keep for the common case. */
  private async register(endpoint: string): Promise<McpOAuthClient> {
    let res;
    try {
      res = await this.http.send({
        method: 'POST',
        url: endpoint,
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ client_name: 'Hexactra', redirect_uris: [this.redirectUri()], grant_types: ['authorization_code', 'refresh_token'], response_types: ['code'], token_endpoint_auth_method: 'none' }),
        maxBytes: 32 * 1024,
        timeoutMs: 10_000,
      });
    } catch (e) {
      if (e instanceof OutboundHttpError && (e.code === 'private_target' || e.code === 'scheme_not_allowed')) throw new ConnectionError('CONNECTION_MCP_URL_REFUSED', urlError(e.code).message, { reason: e.code });
      throw new ConnectionError('CONNECTION_UNAVAILABLE', 'The authorization server could not be reached.', { reason: 'registration' });
    }
    const doc = parseJson(res.body);
    const clientId = (res.status === 200 || res.status === 201) && isRecord(doc) ? str(doc.client_id) : null;
    if (!clientId) throw new ConnectionError('CONNECTION_MCP_AUTH_REQUIRED', 'The server did not register a client for Hexactra: give the client id of an app you registered with it.', { oauth: true, needsClient: true });
    return { clientId, clientSecret: isRecord(doc) ? str(doc.client_secret) : null };
  }

  // ---- connecting ----

  async start(userId: string, input: StartInput, challenge?: string): Promise<StartResult> {
    await this.connector.checkAddress(input.url);
    const d = await this.discover(input.url, challenge);
    const client: McpOAuthClient = input.clientId ? { clientId: input.clientId.trim(), clientSecret: input.clientSecret?.trim() || null } : await this.registerFor(d);
    const state = randomToken(32);
    const binding = randomToken(32);
    const verifier = newCodeVerifier();
    const expiresAt = new Date(this.clock() + CONNECT_TTL_MS);
    const flow = await this.prisma.connectionFlow.create({
      data: { userId, provider: 'mcp', stateHash: sha256Hex(state), bindingHash: sha256Hex(binding), capabilities: [], label: input.label?.trim() || null, loginHint: null, connectionId: input.connectionId ?? null, returnTo: safeReturnTo(input.returnTo), expiresAt },
    });
    try {
      await this.store.setVerifier(userId, flow.id, verifier);
      await this.secrets.setFlow(userId, flow.id, { url: input.url, oauth: d.meta, client, redirectUri: this.redirectUri(), connectionId: input.connectionId ?? null });
    } catch (e) {
      await this.discard(userId, flow.id);
      throw e;
    }
    const url = new URL(this.oauth.authorizeUrl(toEndpoints(d.meta), { clientId: client.clientId, redirectUri: this.redirectUri(), scopes: d.scopes, state, codeChallenge: codeChallengeS256(verifier), resource: d.meta.resource }));
    if (d.scopes.length === 0) url.searchParams.delete('scope');
    await this.events.audit(userId, CONNECTION_AUDIT.connectStarted, input.connectionId ?? flow.id, { provider: 'mcp', reconnect: Boolean(input.connectionId) }, input.connectionId ? 'connection' : 'connection_flow');
    return { authorizeUrl: url.toString(), expiresAt, cookie: { name: bindingCookieName(state), value: binding, maxAgeSeconds: Math.floor(CONNECT_TTL_MS / 1000) } };
  }

  private async registerFor(d: Discovered): Promise<McpOAuthClient> {
    if (!d.registrationEndpoint) throw new ConnectionError('CONNECTION_MCP_AUTH_REQUIRED', 'The server does not register clients itself: give the client id of an app you registered with it.', { oauth: true, needsClient: true });
    return this.register(d.registrationEndpoint);
  }

  async discard(userId: string, flowId: string): Promise<void> {
    await this.prisma.connectionFlow.deleteMany({ where: { id: flowId } });
    await this.store.clearVerifier(userId, flowId).catch(() => undefined);
    await this.secrets.clearFlow(userId, flowId).catch(() => undefined);
  }

  /** The callback of the authorization (public route). Never throws for a bad request: a closed outcome the controller puts on the redirect. */
  async handleCallback(params: { code?: string; state?: string; error?: string; iss?: string }, bindingFor: (cookieName: string) => string | undefined): Promise<CallbackResult> {
    const fail = (outcome: CallbackResult['outcome'], returnTo = DEFAULT_RETURN_TO): CallbackResult => ({ outcome, returnTo });
    if (!params.state || params.state.length > 200) return fail('state_invalid');
    const flow = await this.prisma.connectionFlow.findUnique({ where: { stateHash: sha256Hex(params.state) } });
    if (!flow || flow.provider !== 'mcp') return fail('state_invalid');
    if (flow.expiresAt.getTime() < this.clock()) {
      await this.discard(flow.userId, flow.id);
      return fail('expired');
    }
    const binding = bindingFor(bindingCookieName(params.state));
    if (!binding || !safeEqual(sha256Hex(binding), flow.bindingHash)) return fail('binding_invalid');
    const claimed = await this.prisma.connectionFlow.deleteMany({ where: { id: flow.id } });
    if (claimed.count !== 1) return fail('state_invalid');
    const verifier = await this.store.verifier(flow.userId, flow.id).catch(() => null);
    const ctx = await this.secrets.flow(flow.userId, flow.id).catch(() => null);
    await this.store.clearVerifier(flow.userId, flow.id).catch(() => undefined);
    await this.secrets.clearFlow(flow.userId, flow.id).catch(() => undefined);
    const back = safeReturnTo(flow.returnTo);
    if (!verifier || !ctx) return fail('state_invalid', back);

    const failed = async (outcome: CallbackResult['outcome']): Promise<CallbackResult> => {
      await this.events.audit(flow.userId, CONNECTION_AUDIT.connectFailed, flow.connectionId ?? flow.id, { provider: 'mcp', reason: outcome });
      this.events.count('mcp', 'failed');
      return { outcome, returnTo: back, ...(flow.connectionId ? { connectionId: flow.connectionId } : {}) };
    };
    if (params.error) {
      const code = /^[a-z_]{1,40}$/.test(params.error) ? params.error : 'refused';
      await this.events.audit(flow.userId, CONNECTION_AUDIT.connectFailed, flow.connectionId ?? flow.id, { provider: 'mcp', reason: code });
      this.events.count('mcp', code === 'access_denied' ? 'denied' : 'failed');
      return fail(code === 'access_denied' ? 'denied' : 'refused', back);
    }
    if (!params.code || params.code.length > 4096) return failed('exchange_failed');
    // RFC 9207: a server that says it sends `iss` must send the issuer it published; a mismatch is a mix-up attempt.
    if (ctx.oauth.issuerInResponse && params.iss?.replace(/\/+$/, '') !== ctx.oauth.issuer) return failed('refused');
    if (!(await this.connector.enabled())) return failed('provider_unavailable');

    let tokens: TokenSet;
    try {
      tokens = await this.oauth.exchangeCode(toEndpoints(ctx.oauth), ctx.client, { code: params.code, verifier, redirectUri: ctx.redirectUri, resource: ctx.oauth.resource });
    } catch (e) {
      if (!(e instanceof OAuthClientError)) this.log.warn(`MCP code exchange failed (${e instanceof Error ? e.name : 'error'})`);
      return failed('exchange_failed');
    }
    try {
      const row = await this.complete({ id: flow.id, userId: flow.userId, label: flow.label, connectionId: flow.connectionId }, ctx.url, ctx.oauth, ctx.client, tokens);
      if (!row) return failed(flow.connectionId ? 'state_invalid' : 'limit');
      this.events.count('mcp', flow.connectionId ? 'reconnected' : 'connected');
      return { outcome: 'connected', returnTo: back, connectionId: row.id };
    } catch (e) {
      this.log.warn(`MCP connection could not be saved (${e instanceof Error ? e.name : 'error'})`);
      return failed('exchange_failed');
    }
  }

  private async complete(flow: { id: string; userId: string; label: string | null; connectionId: string | null }, url: string, meta: McpOAuthMeta, client: McpOAuthClient, tokens: TokenSet): Promise<Connection | null> {
    const userId = flow.userId;
    const accountId = accountIdOf(url);
    const existing = flow.connectionId
      ? await this.prisma.connection.findFirst({ where: { id: flow.connectionId, userId, provider: 'mcp' } })
      : await this.prisma.connection.findUnique({ where: { userId_provider_accountId: { userId, provider: 'mcp', accountId } } });
    if (flow.connectionId && !existing) return null;
    if (!existing && (await this.prisma.connection.count({ where: { userId } })) >= MAX_CONNECTIONS_PER_USER) return null;
    const config: McpConfig = { ...(readMcpConfig(existing?.config) ?? {}), url, auth: { kind: 'oauth' }, oauth: meta };
    const now = new Date(this.clock());
    let row: Connection;
    if (existing) {
      await this.persistTokens(userId, existing.id, client, tokens);
      row = await this.prisma.connection.update({ where: { id: existing.id }, data: { config, status: 'active', statusReason: null, accessExpiresAt: tokens.expiresAt, lastRefreshAt: now, refreshLeaseUntil: null, reconnectNotifiedAt: null } });
    } else {
      const taken = (await this.prisma.connection.findMany({ where: { userId }, select: { label: true } })).map((c) => c.label);
      const label = uniqueLabel((flow.label?.trim() || hostLabel(url)).slice(0, 60), taken);
      row = await this.prisma.connection.create({ data: { userId, provider: 'mcp', accountId, accountEmail: new URL(url).hostname.slice(0, 300), label, capabilities: [], grantedScopes: [], status: 'active', accessExpiresAt: tokens.expiresAt, lastRefreshAt: now, config } });
      try {
        await this.persistTokens(userId, row.id, client, tokens);
      } catch (e) {
        await this.prisma.connection.deleteMany({ where: { id: row.id } });
        throw e;
      }
    }
    await this.events.audit(userId, existing ? CONNECTION_AUDIT.updated : CONNECTION_AUDIT.mcpAdded, row.id, { provider: 'mcp', auth: 'oauth', change: existing ? 'reconnected' : 'connected' });
    // The first listing: a failure leaves a connection with no tools; "Refresh tools" tries again.
    await this.catalog.refresh(userId, row.id).catch(async (e: unknown) => {
      this.log.warn(`MCP first tool listing failed (${e instanceof ConnectionError ? e.code : 'error'})`);
      await this.prisma.connection.updateMany({ where: { id: row.id, status: 'active' }, data: { statusReason: 'UNAVAILABLE' } });
    });
    return row;
  }

  private async persistTokens(userId: string, connectionId: string, client: McpOAuthClient, tokens: TokenSet): Promise<void> {
    await this.secrets.setClient(userId, connectionId, client);
    if (tokens.refreshToken) await this.store.setRefreshToken(userId, connectionId, tokens.refreshToken);
    await this.store.setAccessToken(userId, connectionId, tokens.accessToken);
  }

  // ---- afterwards ----

  /** The refresh the token service calls (`registerRefresher`): throws `OAuthClientError` as an adapter's `refresh` does. */
  async refresh(row: Connection, refreshToken: string): Promise<TokenSet> {
    const cfg = readMcpConfig(row.config);
    const client = cfg?.oauth ? await this.secrets.client(row.userId, row.id) : null;
    if (!cfg?.oauth || !client) throw new OAuthClientError('invalid_client', 'The client is not known.');
    return this.oauth.refresh(toEndpoints(cfg.oauth), client, { refreshToken, resource: cfg.oauth.resource });
  }

  /** Best effort: the grant is revoked at the authorization server. True when it confirmed or there was nothing to revoke. */
  async revoke(row: Connection): Promise<boolean> {
    const cfg = readMcpConfig(row.config);
    if (cfg?.auth.kind !== 'oauth' || !cfg.oauth) return true;
    const [client, refresh, access] = await Promise.all([this.secrets.client(row.userId, row.id).catch(() => null), this.store.refreshToken(row.userId, row.id).catch(() => null), this.store.accessToken(row.userId, row.id).catch(() => null)]);
    if (!refresh && !access) return true;
    if (!client || !cfg.oauth.revocationEndpoint) return false;
    try {
      let ok = true;
      if (refresh) ok = (await this.oauth.revoke(toEndpoints(cfg.oauth), client, { token: refresh, hint: 'refresh_token' })).revoked && ok;
      if (access) ok = (await this.oauth.revoke(toEndpoints(cfg.oauth), client, { token: access, hint: 'access_token' })).revoked && ok;
      return ok;
    } catch {
      return false;
    }
  }
}

export { hostMatches, toConnectionError };
