// A small OAuth 2.1 CLIENT (authorization code with PKCE, refresh, revoke) for a provider the owner connects to
// (E37.2, #591: the owner's Vault; E39 reuses it for Google and Microsoft). Stateless: the caller keeps the
// state, the verifier and the tokens. It never logs a token, a code, a secret or a response body, and its
// errors carry only a closed code plus the provider's RFC 6749 `error` code.
//
// Every request goes through `OutboundHttp` (pinned to an SSRF-checked address, no redirects, bounded).
import { Injectable } from '@nestjs/common';

import { OutboundHttp, OutboundHttpError } from './outbound-http';

/** The endpoints of an authorization server, from its metadata (RFC 8414) or the provider's conventional paths. */
export interface OAuthServerEndpoints {
  issuer: string;
  authorizationEndpoint: string;
  tokenEndpoint: string;
  revocationEndpoint: string | null;
  /** The server sends `iss` on the authorization response (RFC 9207): a callback without it is refused. */
  issuerInResponse: boolean;
}

export interface OAuthClientCredentials {
  clientId: string;
  /** Confidential clients only. */
  clientSecret?: string | null;
}

export interface OAuthTokens {
  accessToken: string;
  refreshToken: string | null;
  /** When the access token stops working. */
  expiresAt: Date;
  scopes: string[];
}

export type OAuthErrorKind =
  /** The server or the network could not be reached, or answered 5xx / 429: try again later; nothing was consumed. */
  | 'unavailable'
  /** The grant or the code is no longer good (`invalid_grant`, a revoked or replayed refresh token, 401 from a bearer call): connect again. */
  | 'invalid_grant'
  /** The client id or secret was refused (`invalid_client`). */
  | 'invalid_client'
  /** Anything else the server refused (`invalid_request`, `invalid_scope`, ...), or an answer that is not OAuth. */
  | 'refused';

/** A failed OAuth call. `message` is static; `oauthError` is the provider's RFC 6749 code (a closed vocabulary), never its description. */
export class OAuthClientError extends Error {
  constructor(
    readonly kind: OAuthErrorKind,
    message: string,
    readonly oauthError?: string,
    readonly status?: number,
    readonly retryAfterSeconds?: number,
  ) {
    super(message);
    this.name = 'OAuthClientError';
  }
}

const OAUTH_ERROR_CODE = /^[a-z_]{1,40}$/;
const DISCOVERY_TTL_MS = 10 * 60_000;

/** `https://host` or `https://host/prefix`, no trailing slash, no query, no fragment. */
export function normalizeBaseUrl(raw: string): string {
  const u = new URL(raw.trim());
  u.search = '';
  u.hash = '';
  return u.toString().replace(/\/+$/, '');
}

@Injectable()
export class OAuthClientService {
  private readonly discovered = new Map<string, { at: number; endpoints: OAuthServerEndpoints }>();
  /** Which client authentication worked last for a client at a server: the next call tries it first. */
  private readonly authMethod = new Map<string, 'post' | 'basic'>();

  /** The wall clock; tests replace it. */
  clock: () => number = Date.now;

  constructor(private readonly http: OutboundHttp) {}

  /**
   * Reads the server's metadata at `metadataUrl`, or falls back to `fallbackPaths` under `baseUrl` when the
   * server publishes none (a 404). Every endpoint must be on the base URL's own origin: a metadata document
   * can never point the console at another host.
   */
  async discover(baseUrl: string, opts: { metadataPath: string; fallback: { authorize: string; token: string; revoke: string | null }; allowedHosts?: readonly string[] }): Promise<OAuthServerEndpoints> {
    const base = normalizeBaseUrl(baseUrl);
    const cached = this.discovered.get(base);
    if (cached && this.clock() - cached.at < DISCOVERY_TTL_MS) return cached.endpoints;
    const origin = new URL(base).origin;
    let endpoints: OAuthServerEndpoints | null = null;
    let res;
    try {
      res = await this.http.send({ method: 'GET', url: `${base}${opts.metadataPath}`, allowedHosts: opts.allowedHosts, maxBytes: 32 * 1024 });
    } catch (e) {
      throw this.unavailable(e);
    }
    if (res.status === 200) {
      const doc = parseJson(res.body);
      const authorize = str(doc, 'authorization_endpoint');
      const token = str(doc, 'token_endpoint');
      const revoke = str(doc, 'revocation_endpoint');
      const methods = (doc as { code_challenge_methods_supported?: unknown } | null)?.code_challenge_methods_supported;
      if (!authorize || !token) throw new OAuthClientError('refused', 'The server publishes no authorization or token endpoint.');
      if (Array.isArray(methods) && !methods.includes('S256')) throw new OAuthClientError('refused', 'The server does not support PKCE S256.');
      for (const u of [authorize, token, revoke]) if (u && sameOrigin(u, origin) === false) throw new OAuthClientError('refused', 'The server metadata points to another host.');
      endpoints = {
        issuer: str(doc, 'issuer') ?? base,
        authorizationEndpoint: authorize,
        tokenEndpoint: token,
        revocationEndpoint: revoke,
        issuerInResponse: (doc as { authorization_response_iss_parameter_supported?: unknown } | null)?.authorization_response_iss_parameter_supported === true,
      };
    } else if (res.status === 404) {
      endpoints = { issuer: base, authorizationEndpoint: `${base}${opts.fallback.authorize}`, tokenEndpoint: `${base}${opts.fallback.token}`, revocationEndpoint: opts.fallback.revoke ? `${base}${opts.fallback.revoke}` : null, issuerInResponse: false };
    } else if (res.status >= 500 || res.status === 429) {
      throw new OAuthClientError('unavailable', 'The server is not available.', undefined, res.status);
    } else {
      throw new OAuthClientError('refused', 'The server answered the metadata request with an error.', undefined, res.status);
    }
    this.discovered.set(base, { at: this.clock(), endpoints });
    return endpoints;
  }

  /** Drops what discovery cached for a server (after the owner changes the address). */
  forget(baseUrl: string): void {
    try {
      this.discovered.delete(normalizeBaseUrl(baseUrl));
    } catch {
      // not a URL: nothing cached
    }
  }

  /** The URL the owner's browser is sent to (RFC 6749 §4.1.1 with PKCE and a resource indicator). */
  authorizeUrl(e: OAuthServerEndpoints, p: { clientId: string; redirectUri: string; scopes: readonly string[]; state: string; codeChallenge: string; resource?: string }): string {
    const url = new URL(e.authorizationEndpoint);
    url.searchParams.set('response_type', 'code');
    url.searchParams.set('client_id', p.clientId);
    url.searchParams.set('redirect_uri', p.redirectUri);
    url.searchParams.set('scope', p.scopes.join(' '));
    url.searchParams.set('state', p.state);
    url.searchParams.set('code_challenge', p.codeChallenge);
    url.searchParams.set('code_challenge_method', 'S256');
    if (p.resource) url.searchParams.set('resource', p.resource);
    return url.toString();
  }

  exchangeCode(e: OAuthServerEndpoints, c: OAuthClientCredentials, p: { code: string; verifier: string; redirectUri: string; resource?: string; allowedHosts?: readonly string[] }): Promise<OAuthTokens> {
    const form: Record<string, string> = { grant_type: 'authorization_code', code: p.code, redirect_uri: p.redirectUri, code_verifier: p.verifier };
    if (p.resource) form.resource = p.resource;
    return this.tokenRequest(e, c, form, p.allowedHosts);
  }

  /** Rotates a refresh token. The response carries the NEW refresh token, which the caller must store before using the new access token. */
  refresh(e: OAuthServerEndpoints, c: OAuthClientCredentials, p: { refreshToken: string; resource?: string; allowedHosts?: readonly string[] }): Promise<OAuthTokens> {
    const form: Record<string, string> = { grant_type: 'refresh_token', refresh_token: p.refreshToken };
    if (p.resource) form.resource = p.resource;
    return this.tokenRequest(e, c, form, p.allowedHosts);
  }

  /** RFC 7009. Resolves on any answer the server gives (a token already gone is not an error); throws only when it could not be asked. */
  async revoke(e: OAuthServerEndpoints, c: OAuthClientCredentials, p: { token: string; hint: 'access_token' | 'refresh_token'; allowedHosts?: readonly string[] }): Promise<{ revoked: boolean }> {
    if (!e.revocationEndpoint) return { revoked: false };
    const res = await this.formPost(e.revocationEndpoint, e, c, { token: p.token, token_type_hint: p.hint }, p.allowedHosts);
    return { revoked: res.status >= 200 && res.status < 300 };
  }

  // ---- internals ----

  private async tokenRequest(e: OAuthServerEndpoints, c: OAuthClientCredentials, form: Record<string, string>, allowedHosts?: readonly string[]): Promise<OAuthTokens> {
    const res = await this.formPost(e.tokenEndpoint, e, c, form, allowedHosts);
    if (res.status === 200) {
      const doc = parseJson(res.body) as Record<string, unknown> | null;
      const accessToken = typeof doc?.access_token === 'string' ? doc.access_token : '';
      if (!accessToken) throw new OAuthClientError('refused', 'The server answered without an access token.', undefined, 200);
      const ttl = typeof doc?.expires_in === 'number' && Number.isFinite(doc.expires_in) && doc.expires_in > 0 ? doc.expires_in : 300;
      return {
        accessToken,
        refreshToken: typeof doc?.refresh_token === 'string' && doc.refresh_token ? doc.refresh_token : null,
        expiresAt: new Date(this.clock() + ttl * 1000),
        scopes: typeof doc?.scope === 'string' ? doc.scope.split(/\s+/).filter(Boolean) : [],
      };
    }
    throw errorFrom(res.status, res.body, res.headers['retry-after']);
  }

  /**
   * POSTs a form with the client's credentials. A confidential client is sent as `client_secret_post` first; a
   * `401 invalid_client` (it fails before any code or refresh token is consumed) is retried once as
   * `client_secret_basic`, and the method that worked is remembered for the next call.
   */
  private async formPost(url: string, e: OAuthServerEndpoints, c: OAuthClientCredentials, fields: Record<string, string>, allowedHosts?: readonly string[]) {
    const key = `${e.tokenEndpoint}|${c.clientId}`;
    const secret = c.clientSecret ?? '';
    const order: ('post' | 'basic')[] = !secret ? ['post'] : this.authMethod.get(key) === 'basic' ? ['basic', 'post'] : ['post', 'basic'];
    let last: Awaited<ReturnType<OutboundHttp['send']>> | undefined;
    for (const method of order) {
      const body = new URLSearchParams({ ...fields, ...(method === 'post' || !secret ? { client_id: c.clientId } : {}), ...(method === 'post' && secret ? { client_secret: secret } : {}) }).toString();
      const headers: Record<string, string> = { 'content-type': 'application/x-www-form-urlencoded' };
      if (method === 'basic' && secret) headers.authorization = `Basic ${Buffer.from(`${encodeURIComponent(c.clientId)}:${encodeURIComponent(secret)}`).toString('base64')}`;
      try {
        last = await this.http.send({ method: 'POST', url, headers, body, allowedHosts, maxBytes: 32 * 1024 });
      } catch (err) {
        throw this.unavailable(err);
      }
      if (last.status === 401 && secret && method === order[0] && order.length > 1) continue;
      if (last.status !== 401) this.authMethod.set(key, method);
      return last;
    }
    return last!;
  }

  private unavailable(e: unknown): OAuthClientError {
    const code = e instanceof OutboundHttpError ? e.code : 'network';
    // A refusal of the address itself (private target, scheme) is not "try later": the owner must change it.
    if (code === 'private_target' || code === 'scheme_not_allowed' || code === 'invalid_url' || code === 'userinfo_not_allowed' || code === 'port_not_allowed') return new OAuthClientError('refused', 'The address is not allowed.', code);
    return new OAuthClientError('unavailable', code === 'timeout' ? 'The server did not answer in time.' : 'The server could not be reached.', code);
  }
}

function parseJson(body: string): unknown {
  try {
    return JSON.parse(body);
  } catch {
    return null;
  }
}

function str(doc: unknown, key: string): string | null {
  const v = (doc as Record<string, unknown> | null)?.[key];
  return typeof v === 'string' && v.length > 0 ? v : null;
}

function sameOrigin(url: string, origin: string): boolean {
  try {
    return new URL(url).origin === origin;
  } catch {
    return false;
  }
}

/** Maps a non-200 token or revoke answer to a typed error (RFC 6749 §5.2). Never copies the description. */
export function errorFrom(status: number, body: string, retryAfter?: string): OAuthClientError {
  const doc = parseJson(body) as { error?: unknown } | null;
  const code = typeof doc?.error === 'string' && OAUTH_ERROR_CODE.test(doc.error) ? doc.error : undefined;
  const retry = retryAfter && /^\d{1,5}$/.test(retryAfter) ? Number(retryAfter) : undefined;
  if (status === 429 || status >= 500) return new OAuthClientError('unavailable', 'The server is not available.', code, status, retry);
  if (code === 'invalid_grant') return new OAuthClientError('invalid_grant', 'The grant is no longer valid.', code, status);
  if (code === 'invalid_client' || status === 401) return new OAuthClientError('invalid_client', 'The server refused the client.', code ?? 'invalid_client', status);
  return new OAuthClientError('refused', 'The server refused the request.', code, status);
}
