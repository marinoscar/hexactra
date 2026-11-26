// Google's side of connecting an account (E39.3, #601): the authorization-code flow with PKCE over the console's OAuth client, the
// account's stable id and email from the userinfo endpoint, the token refresh, the revoke, and the cheap read that `Test` runs per
// switched-on capability. Scopes are exactly those of the decision record (google.scopes.ts).
//
// The adapter keeps nothing: state, verifier and tokens belong to the connections module. It never logs what it is given or
// returns, and a failure carries only an `OAuthClientError` kind and Google's RFC 6749 error code, never a description.
import { OAuthClientError, OAuthClientService, OutboundHttp, OutboundHttpError, type OAuthServerEndpoints } from '../../oauth-client';
import type { Capability } from '../connections.constants';
import { groupOf } from '../connections.constants';
import type { DiagnosticStage } from '../../diagnostics/diagnostic-report';
import type { AccountIdentity, AuthorizeInput, ConnectionDiagnoseInput, ConnectionProviderAdapter, ExchangeInput, ProbeInput, ProbeResult, ProviderApp, ProviderAppDiagnoseInput, RefreshInput, RevokeInput, TokenSet } from '../provider';
import { GOOGLE_APP_DIAGNOSTIC_CODES, GOOGLE_DIAGNOSTIC_CODES, diagnoseGoogleApp, diagnoseGoogleConnection, disabledApiOf } from './google-diagnostics';
import { GOOGLE } from './google.constants';
import { readGoogleError } from './google-http';
import { capabilitiesFromScopes, scopesForCapabilities } from './google.scopes';

const ENDPOINTS: OAuthServerEndpoints = {
  issuer: 'https://accounts.google.com',
  authorizationEndpoint: GOOGLE.authorize,
  tokenEndpoint: GOOGLE.token,
  revocationEndpoint: GOOGLE.revoke,
  issuerInResponse: false,
};

const creds = (app: ProviderApp) => ({ clientId: app.clientId, clientSecret: app.clientSecret });

export class GoogleConnectionAdapter implements ConnectionProviderAdapter {
  readonly id = 'google' as const;
  readonly diagnosticCodes = GOOGLE_DIAGNOSTIC_CODES;
  readonly appDiagnosticCodes = GOOGLE_APP_DIAGNOSTIC_CODES;

  constructor(
    private readonly oauth: OAuthClientService,
    private readonly http: OutboundHttp,
  ) {}

  scopesFor(capabilities: readonly Capability[]): string[] {
    return scopesForCapabilities(capabilities);
  }

  capabilitiesGranted(scopes: readonly string[]): Capability[] {
    return capabilitiesFromScopes(scopes);
  }

  /**
   * `access_type=offline` (a refresh token), `include_granted_scopes=true` (incremental consent: what the account already
   * granted stays granted, and the consent screen asks only for the new scopes), `prompt=consent` only when a refresh token is
   * needed (a new connection or a reconnect; an incremental consent keeps the one the account already has), `login_hint` for a
   * known account.
   */
  authorizeUrl(input: AuthorizeInput): string {
    const url = new URL(GOOGLE.authorize);
    const p = url.searchParams;
    p.set('response_type', 'code');
    p.set('client_id', input.app.clientId);
    p.set('redirect_uri', input.app.redirectUri);
    p.set('scope', input.scopes.join(' '));
    p.set('state', input.state);
    p.set('code_challenge', input.codeChallenge);
    p.set('code_challenge_method', 'S256');
    p.set('access_type', 'offline');
    p.set('include_granted_scopes', 'true');
    if (!input.incremental) p.set('prompt', 'consent');
    if (input.loginHint) p.set('login_hint', input.loginHint);
    return url.toString();
  }

  async exchangeCode(input: ExchangeInput): Promise<TokenSet & AccountIdentity> {
    const tokens = await this.oauth.exchangeCode(ENDPOINTS, creds(input.app), { code: input.code, verifier: input.verifier, redirectUri: input.app.redirectUri });
    return { ...tokens, ...(await this.identity(tokens.accessToken)) };
  }

  refresh(input: RefreshInput): Promise<TokenSet> {
    return this.oauth.refresh(ENDPOINTS, creds(input.app), { refreshToken: input.refreshToken });
  }

  async revoke(input: RevokeInput): Promise<void> {
    await this.oauth.revoke(ENDPOINTS, creds(input.app), { token: input.token, hint: input.hint });
  }

  /** The account's stable id (`sub`) and email from Google's userinfo endpoint. */
  private async identity(accessToken: string): Promise<AccountIdentity> {
    let res;
    try {
      res = await this.http.send({ method: 'GET', url: GOOGLE.userinfo, headers: { authorization: `Bearer ${accessToken}` }, maxBytes: 16 * 1024 });
    } catch (e) {
      throw new OAuthClientError('unavailable', 'The provider could not be reached.', e instanceof OutboundHttpError ? e.code : 'network');
    }
    if (res.status === 429 || res.status >= 500) throw new OAuthClientError('unavailable', 'The provider is not available.', undefined, res.status);
    if (res.status !== 200) throw new OAuthClientError('refused', 'The provider did not say who the account is.', undefined, res.status);
    let doc: { sub?: unknown; email?: unknown; name?: unknown } | null = null;
    try {
      doc = JSON.parse(res.body);
    } catch {
      doc = null;
    }
    if (typeof doc?.sub !== 'string' || !doc.sub || typeof doc.email !== 'string' || !doc.email) throw new OAuthClientError('refused', 'The provider did not say who the account is.', undefined, 200);
    return { accountId: doc.sub, email: doc.email, name: typeof doc.name === 'string' && doc.name ? doc.name.slice(0, 200) : null };
  }

  /** One cheap read per capability's group: the label list, the calendar list, a Drive `about` call. Never throws for an answer. */
  async probe(input: ProbeInput): Promise<ProbeResult> {
    const group = groupOf(input.capability);
    const url = group === 'mail' ? `${GOOGLE.gmail}/labels?fields=labels(id)` : group === 'calendar' ? `${GOOGLE.calendar}/users/me/calendarList?maxResults=1&fields=items(id)` : `${GOOGLE.drive}/about?fields=user(kind)`;
    try {
      const res = await this.http.send({ method: 'GET', url, headers: { authorization: `Bearer ${input.accessToken}` }, maxBytes: 64 * 1024, timeoutMs: 15_000 });
      if (res.status >= 200 && res.status < 300) return { ok: true };
      if (res.status === 401) return { ok: false, code: 'UNAUTHORIZED' };
      if (res.status === 429) return { ok: false, code: 'RATE_LIMITED' };
      if (res.status >= 500) return { ok: false, code: 'UNAVAILABLE' };
      if (res.status === 403) {
        let body: unknown = null;
        try {
          body = JSON.parse(res.body);
        } catch {
          body = null;
        }
        const { reasons } = readGoogleError(body);
        if (!(reasons.has('accessnotconfigured') || reasons.has('service_disabled'))) return { ok: false, code: 'FORBIDDEN' };
        // E50.11 (#981, #681): name the API to enable, from the closed list, or the one this call used.
        const api = disabledApiOf(body).api ?? (group === 'mail' ? 'gmail.googleapis.com' : group === 'calendar' ? 'calendar-json.googleapis.com' : 'drive.googleapis.com');
        return { ok: false, code: 'API_DISABLED', api };
      }
      return { ok: false, code: 'FAILED' };
    } catch {
      return { ok: false, code: 'UNAVAILABLE' };
    }
  }

  /** E50.11 (#981): app_config, sign_in, token_lifetime, permissions, one read per capability (Docs and Sheets too), clock. */
  diagnose(input: ConnectionDiagnoseInput): Promise<DiagnosticStage[]> {
    return diagnoseGoogleConnection(this.http, input, (scopes) => this.capabilitiesGranted(scopes));
  }

  /** E50.11 (#981): the deployment's app with no user: redirect_uri, discovery, client_check, picker_key. */
  diagnoseApp(input: ProviderAppDiagnoseInput): Promise<DiagnosticStage[]> {
    return diagnoseGoogleApp(this.http, input);
  }
}
