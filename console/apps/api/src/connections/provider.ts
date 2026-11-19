// The contract of a connection provider (E39.2, #599). The real adapters (Google: E39.3, Microsoft: E39.4) implement it and
// register with the ConnectionProviderRegistry; this issue ships the contract and a fake adapter for tests
// (test/support/fake-connection-provider.ts). The adapters call the provider through `OAuthClientService`
// (`src/oauth-client/`), so a refused grant surfaces as an `OAuthClientError` of kind `invalid_grant`.
//
// An adapter never stores anything: the connections module keeps the state, the verifier and the tokens. What an
// adapter receives it must not log, and what it returns must not carry a provider message.
import type { OAuthTokens } from '../oauth-client';
import type { Capability, ConnectionProviderId } from './connections.constants';

/** The deployment's registered app at the provider (bring your own app: the administrator creates it). */
export interface ProviderApp {
  clientId: string;
  clientSecret: string;
  /** Microsoft only: `common`, `organizations`, `consumers` or a tenant id. */
  tenant?: string | null;
  /** `<APP_URL>/api/connections/callback/<provider>`: what the provider must have registered. */
  redirectUri: string;
}

/**
 * The tokens of one exchange or refresh. `refreshToken` is null when the provider did not send one (a refresh may rotate it).
 * `scopes` must list what the provider GRANTED: the console assumes nothing for an empty list (an adapter whose provider omits
 * `scope` because it equals the request, RFC 6749 §5.1, fills in the requested ones).
 */
export type TokenSet = OAuthTokens;

/** Who the account is at the provider. `accountId` is its stable id (never the email, which can change). */
export interface AccountIdentity {
  accountId: string;
  email: string;
  name: string | null;
}

export interface AuthorizeInput {
  app: ProviderApp;
  state: string;
  codeChallenge: string;
  scopes: readonly string[];
  /** The account to pre-select (an incremental consent always sets it). */
  loginHint?: string | null;
  /** Ask only for these scopes and keep the ones already granted (Google `include_granted_scopes`). */
  incremental?: boolean;
}

export interface ExchangeInput {
  app: ProviderApp;
  code: string;
  verifier: string;
}

export interface RefreshInput {
  app: ProviderApp;
  refreshToken: string;
}

export interface RevokeInput {
  app: ProviderApp;
  token: string;
  hint: 'access_token' | 'refresh_token';
}

/** The answer of one cheap read call. `code` is a closed, data-free vocabulary (`UNAUTHORIZED`, `FORBIDDEN`, `UNAVAILABLE`, ...). */
export type ProbeResult = { ok: true } | { ok: false; code: string };

export interface ProbeInput {
  capability: Capability;
  accessToken: string;
}

export interface ConnectionProviderAdapter {
  readonly id: ConnectionProviderId;
  /** The least permissions the capabilities need (scopes at Google, permissions at Microsoft), from the decision record (E39.1). */
  scopesFor(capabilities: readonly Capability[]): string[];
  /** The URL the owner's browser is sent to: PKCE (S256), `state`, a login hint and incremental consent. */
  authorizeUrl(input: AuthorizeInput): string;
  /** Exchanges the code and reads the account's stable id and email. Throws `OAuthClientError`. */
  exchangeCode(input: ExchangeInput): Promise<TokenSet & AccountIdentity>;
  /** Presents the refresh token. May return a rotated one. Throws `OAuthClientError` (`invalid_grant`: revoked, expired, password changed, the 7-day test rule). */
  refresh(input: RefreshInput): Promise<TokenSet>;
  /** Best effort; a token already gone is not an error. Throws only when the provider could not be asked. */
  revoke(input: RevokeInput): Promise<void>;
  /** Which capabilities a set of granted scopes covers. */
  capabilitiesGranted(scopes: readonly string[]): Capability[];
  /** One cheap read call for a capability (`POST /api/connections/{id}/test`). Never throws for a provider answer. */
  probe(input: ProbeInput): Promise<ProbeResult>;
  /**
   * Optional (E39.4): tells apart the refusals the provider sends back on the authorization redirect (`error` and `error_description`):
   * the owner declined, or an administrator has to approve the app. `null` leaves it to the generic handling.
   */
  classifyAuthorizationError?(error: string, description: string | null): 'denied' | 'admin_consent_required' | null;
  /** Optional (E39.4): the address an administrator of the owner's organization opens to approve the app for everyone (Microsoft). */
  adminConsentUrl?(app: ProviderApp): string | null;
}
