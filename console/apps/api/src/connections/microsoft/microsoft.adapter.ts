// The Microsoft side of signing in (E39.4, #602): the authorization-code flow with PKCE against the Microsoft identity platform v2,
// the account's stable id, refresh with rotation, and the probes of `POST /api/connections/{id}/test`. Plain `fetch`, no library.
//
// Decisions (docs/decisions/connections-auth.md wins where the issue differs):
//   * Authority: the tenant setting of the deployment's app (`common` by default: work, school and personal accounts).
//   * `offline_access` and `User.Read` are always asked; the rest only for the capabilities that are on (least privilege, incremental
//     consent when one is switched on later: Microsoft asks only for the permissions the owner has not given yet).
//   * `prompt=select_account` when no account is named, so a person signed in to their work account at the browser is not silently
//     connected as that account when they meant the personal one: the same person's accounts are two connections.
//   * The stable account id is `<tenant id>:<object id>` (lower case) from the id token: the same person's work and personal
//     accounts have different tenants and object ids, so they are different connections and their tokens never cross.
//   * Microsoft has no per-token revoke for delegated tokens: `revoke` throws `no_revocation` so Disconnect says `revoked: false`, and
//     the docs tell the owner where to remove the app's access.
import { OAuthClientError, errorFrom, type OAuthTokens } from '../../oauth-client';
import type { Capability } from '../connections.constants';
import { CAPABILITIES, normalizeCapabilities } from '../connections.constants';
import type { AccountIdentity, AuthorizeInput, ConnectionProviderAdapter, ExchangeInput, ProbeInput, ProbeResult, ProviderApp, RefreshInput, RevokeInput, TokenSet } from '../provider';
import { BASE_SCOPES, GRAPH_BASE, GRAPH_SCOPE_PREFIX, IMPLIED_BY, LOGIN_BASE, SCOPE_OF, authorityOf, microsoftAccountId } from './microsoft.constants';

const GUID = /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/;
const TOKEN_TIMEOUT_MS = 15_000;

/** The numeric AADSTS codes that mean "an administrator has to approve this app" (not "the user said no"). */
const ADMIN_CONSENT_CODES = [90094, 65001, 90095, 650057];
const USER_DECLINED_CODES = [65004];

export interface MicrosoftAdapterOptions {
  fetch?: typeof fetch;
  clock?: () => number;
}

interface TokenResponse {
  access_token?: unknown;
  refresh_token?: unknown;
  id_token?: unknown;
  expires_in?: unknown;
  scope?: unknown;
  error?: unknown;
  error_codes?: unknown;
}

/** The claims of an id token that came straight from the token endpoint over TLS (no signature check is needed or possible without the keys). */
function claimsOf(idToken: string): Record<string, unknown> | null {
  const part = idToken.split('.')[1];
  if (!part) return null;
  try {
    const v = JSON.parse(Buffer.from(part, 'base64url').toString('utf8')) as unknown;
    return v && typeof v === 'object' ? (v as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

const normalizeScope = (s: string): string => (s.toLowerCase().startsWith(GRAPH_SCOPE_PREFIX) ? s.slice(GRAPH_SCOPE_PREFIX.length) : s);

export class MicrosoftConnectionAdapter implements ConnectionProviderAdapter {
  readonly id = 'microsoft' as const;
  private readonly doFetch: typeof fetch;
  private readonly clock: () => number;

  constructor(opts: MicrosoftAdapterOptions = {}) {
    this.doFetch = opts.fetch ?? fetch;
    this.clock = opts.clock ?? Date.now;
  }

  scopesFor(capabilities: readonly Capability[]): string[] {
    return [...new Set<string>([...BASE_SCOPES, ...normalizeCapabilities(capabilities).map((c) => SCOPE_OF[c])])];
  }

  private endpoint(app: ProviderApp, path: 'authorize' | 'token'): string {
    return `${LOGIN_BASE}/${authorityOf(app.tenant)}/oauth2/v2.0/${path}`;
  }

  authorizeUrl(input: AuthorizeInput): string {
    const u = new URL(this.endpoint(input.app, 'authorize'));
    u.searchParams.set('client_id', input.app.clientId);
    u.searchParams.set('response_type', 'code');
    u.searchParams.set('redirect_uri', input.app.redirectUri);
    u.searchParams.set('response_mode', 'query');
    u.searchParams.set('scope', [...new Set<string>([...BASE_SCOPES, ...input.scopes])].join(' '));
    u.searchParams.set('state', input.state);
    u.searchParams.set('code_challenge', input.codeChallenge);
    u.searchParams.set('code_challenge_method', 'S256');
    if (input.loginHint) u.searchParams.set('login_hint', input.loginHint);
    else u.searchParams.set('prompt', 'select_account');
    return u.toString();
  }

  async exchangeCode(input: ExchangeInput): Promise<TokenSet & AccountIdentity> {
    const body = await this.tokenCall(input.app, { grant_type: 'authorization_code', code: input.code, redirect_uri: input.app.redirectUri, code_verifier: input.verifier });
    const tokens = this.tokensOf(body);
    const claims = typeof body.id_token === 'string' ? claimsOf(body.id_token) : null;
    const tid = typeof claims?.tid === 'string' ? claims.tid : '';
    const oid = typeof claims?.oid === 'string' ? claims.oid : '';
    if (!claims || !GUID.test(tid) || !GUID.test(oid) || (claims.aud !== undefined && claims.aud !== input.app.clientId)) throw new OAuthClientError('refused', 'The sign-in did not identify the account.');
    let email = [claims.email, claims.preferred_username].find((v): v is string => typeof v === 'string' && /^[^@\s]+@[^@\s]+$/.test(v)) ?? '';
    let name = typeof claims.name === 'string' && claims.name ? claims.name.slice(0, 200) : null;
    if (!email) {
      const me = await this.me(tokens.accessToken);
      email = me.email;
      name = name ?? me.name;
    }
    if (!email) throw new OAuthClientError('refused', 'The sign-in did not return an address for the account.');
    return { ...tokens, accountId: microsoftAccountId(tid, oid), email, name };
  }

  async refresh(input: RefreshInput): Promise<TokenSet> {
    return this.tokensOf(await this.tokenCall(input.app, { grant_type: 'refresh_token', refresh_token: input.refreshToken }));
  }

  /** Microsoft has no revoke for a delegated token: the owner removes the app's access in their account (docs/connections.md, "Microsoft"). */
  revoke(_input: RevokeInput): Promise<void> {
    return Promise.reject(new OAuthClientError('refused', 'Microsoft has no way to revoke this sign-in from here.', 'no_revocation'));
  }

  capabilitiesGranted(scopes: readonly string[]): Capability[] {
    const have = new Set(scopes.map((s) => normalizeScope(s).toLowerCase()));
    const holds = (permission: string): boolean => have.has(permission.toLowerCase()) || (IMPLIED_BY[permission] ?? []).some((p) => have.has(p.toLowerCase()));
    return CAPABILITIES.filter((c) => holds(SCOPE_OF[c]));
  }

  classifyAuthorizationError(error: string, description: string | null): 'denied' | 'admin_consent_required' | null {
    const codes = [...(description ?? '').matchAll(/AADSTS(\d{3,7})/g)].map((m) => Number(m[1]));
    if (codes.some((c) => ADMIN_CONSENT_CODES.includes(c))) return 'admin_consent_required';
    if (codes.some((c) => USER_DECLINED_CODES.includes(c))) return 'denied';
    if (error === 'consent_required') return 'admin_consent_required';
    return null;
  }

  adminConsentUrl(app: ProviderApp): string | null {
    const authority = authorityOf(app.tenant);
    if (authority === 'consumers') return null;
    const u = new URL(`${LOGIN_BASE}/${authority === 'common' ? 'organizations' : authority}/v2.0/adminconsent`);
    u.searchParams.set('client_id', app.clientId);
    u.searchParams.set('scope', `${GRAPH_SCOPE_PREFIX}.default`);
    u.searchParams.set('redirect_uri', app.redirectUri);
    return u.toString();
  }

  async probe(input: ProbeInput): Promise<ProbeResult> {
    const path =
      input.capability === 'calendar_read' || input.capability === 'calendar_write'
        ? '/me/calendars?$top=1&$select=id'
        : input.capability === 'docs_read' || input.capability === 'docs_write'
          ? '/me/drive?$select=id'
          : '/me/mailFolders/inbox?$select=id';
    let res: Response;
    try {
      res = await this.doFetch(`${GRAPH_BASE}${path}`, { headers: { authorization: `Bearer ${input.accessToken}`, accept: 'application/json' }, signal: AbortSignal.timeout(TOKEN_TIMEOUT_MS), redirect: 'manual' });
    } catch {
      return { ok: false, code: 'UNAVAILABLE' };
    }
    if (res.status >= 200 && res.status < 300) return { ok: true };
    const code = await res
      .json()
      .then((j: { error?: { code?: unknown } }) => (typeof j?.error?.code === 'string' ? j.error.code : ''))
      .catch(() => '');
    if (/^MailboxNotEnabled|^MailboxNotSupported|^ResourceNotFound|^MailboxNotFound/.test(code) || (res.status === 404 && /Mailbox/i.test(code))) return { ok: false, code: 'NO_MAILBOX' };
    if (res.status === 401) return { ok: false, code: 'UNAUTHORIZED' };
    if (res.status === 403) return { ok: false, code: 'FORBIDDEN' };
    if (res.status === 429) return { ok: false, code: 'RATE_LIMITED' };
    if (res.status === 404) return { ok: false, code: 'NOT_FOUND' };
    return { ok: false, code: 'UNAVAILABLE' };
  }

  // ---- internals ----

  private async me(accessToken: string): Promise<{ email: string; name: string | null }> {
    try {
      const res = await this.doFetch(`${GRAPH_BASE}/me?$select=mail,userPrincipalName,displayName`, { headers: { authorization: `Bearer ${accessToken}`, accept: 'application/json' }, signal: AbortSignal.timeout(TOKEN_TIMEOUT_MS), redirect: 'manual' });
      if (!res.ok) return { email: '', name: null };
      const j = (await res.json()) as { mail?: unknown; userPrincipalName?: unknown; displayName?: unknown };
      const email = [j.mail, j.userPrincipalName].find((v): v is string => typeof v === 'string' && /^[^@\s]+@[^@\s]+$/.test(v)) ?? '';
      return { email, name: typeof j.displayName === 'string' && j.displayName ? j.displayName.slice(0, 200) : null };
    } catch {
      return { email: '', name: null };
    }
  }

  private async tokenCall(app: ProviderApp, fields: Record<string, string>): Promise<TokenResponse> {
    let res: Response;
    try {
      res = await this.doFetch(this.endpoint(app, 'token'), {
        method: 'POST',
        headers: { 'content-type': 'application/x-www-form-urlencoded', accept: 'application/json' },
        body: new URLSearchParams({ client_id: app.clientId, client_secret: app.clientSecret, ...fields }).toString(),
        signal: AbortSignal.timeout(TOKEN_TIMEOUT_MS),
        redirect: 'manual',
      });
    } catch {
      throw new OAuthClientError('unavailable', 'The server could not be reached.', 'network');
    }
    const text = await res.text().catch(() => '');
    if (res.status === 200) {
      try {
        return JSON.parse(text) as TokenResponse;
      } catch {
        throw new OAuthClientError('refused', 'The server answered with something that is not OAuth.', undefined, 200);
      }
    }
    let doc: TokenResponse | null = null;
    try {
      doc = JSON.parse(text) as TokenResponse;
    } catch {
      doc = null;
    }
    const codes = Array.isArray(doc?.error_codes) ? (doc.error_codes as unknown[]).filter((c): c is number => typeof c === 'number') : [];
    // The owner (or an administrator) has not approved the app: told apart from every other refusal, with no text from Microsoft.
    if (codes.some((c) => ADMIN_CONSENT_CODES.includes(c)) || doc?.error === 'consent_required') throw new OAuthClientError('refused', 'An administrator has to approve this app.', 'admin_consent_required', res.status);
    // A Conditional Access rule or a sign-in the user must repeat: the saved grant cannot be used silently any more.
    if (doc?.error === 'interaction_required') throw new OAuthClientError('invalid_grant', 'The grant is no longer valid.', 'interaction_required', res.status);
    throw errorFrom(res.status, text, res.headers.get('retry-after') ?? undefined);
  }

  private tokensOf(body: TokenResponse): OAuthTokens {
    const accessToken = typeof body.access_token === 'string' ? body.access_token : '';
    if (!accessToken) throw new OAuthClientError('refused', 'The server answered without an access token.', undefined, 200);
    const ttl = typeof body.expires_in === 'number' && Number.isFinite(body.expires_in) && body.expires_in > 0 ? body.expires_in : Number(body.expires_in) > 0 ? Number(body.expires_in) : 3600;
    return {
      accessToken,
      refreshToken: typeof body.refresh_token === 'string' && body.refresh_token ? body.refresh_token : null,
      expiresAt: new Date(this.clock() + ttl * 1000),
      scopes: typeof body.scope === 'string' ? body.scope.split(/\s+/).filter(Boolean).map(normalizeScope) : [],
    };
  }
}
