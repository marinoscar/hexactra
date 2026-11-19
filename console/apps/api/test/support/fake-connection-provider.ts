// A FAKE connection provider for tests (E39.2, #599). Implements `ConnectionProviderAdapter` in memory, with no network: the real
// Google and Microsoft adapters are E39.3 and E39.4. It checks what a real provider checks that matters to the console: the PKCE
// verifier against the challenge of the authorize URL, a code used once, refresh tokens that ROTATE (a retired one is
// `invalid_grant`), scopes the owner may un-tick, an incremental consent that returns only the added scopes, and a revoked grant.
//
// Every token carries a MARKER so a test can scan responses, audit rows, notifications, rows and logs for a leak.
import { randomUUID } from 'node:crypto';

import { OAuthClientError } from '../../src/oauth-client';
import { codeChallengeS256 } from '../../src/oauth-client/pkce';
import { CAPABILITIES, type Capability, type ConnectionProviderId } from '../../src/connections/connections.constants';
import type { AccountIdentity, AuthorizeInput, ConnectionProviderAdapter, ExchangeInput, ProbeInput, ProbeResult, RefreshInput, RevokeInput, TokenSet } from '../../src/connections/provider';

export interface FakeAccount {
  accountId: string;
  email: string;
  name?: string | null;
}

export interface ConsentOptions {
  /** Scopes the owner leaves unticked. */
  deny?: readonly string[];
  /** The provider sends no refresh token (a second consent at Google does not). */
  noRefreshToken?: boolean;
}

interface Pending {
  challenge: string;
  scopes: string[];
  loginHint: string | null;
  incremental: boolean;
}

interface CodeInfo {
  state: string;
  account: FakeAccount;
  scopes: string[];
  noRefreshToken: boolean;
}

interface Grant {
  account: FakeAccount;
  scopes: string[];
  live: boolean;
}

const SCOPE_OF: Record<Capability, string> = {
  mail_read: 'fake:mail.read',
  mail_send: 'fake:mail.send',
  mail_modify: 'fake:mail.modify',
  calendar_read: 'fake:calendar.read',
  calendar_write: 'fake:calendar.write',
  docs_read: 'fake:docs.read',
  docs_write: 'fake:docs.write',
};

export const fakeScopeOf = (c: Capability): string => SCOPE_OF[c];

export class FakeConnectionProvider implements ConnectionProviderAdapter {
  readonly authorizeCalls: (AuthorizeInput & { url: string })[] = [];
  readonly exchangeCalls: { code: string }[] = [];
  readonly refreshCalls: { refreshToken: string }[] = [];
  readonly revoked: { token: string; hint: string }[] = [];
  readonly probes: Capability[] = [];
  /** Every token and code this provider ever issued (for the leak scan). */
  readonly issued: string[] = [];
  /** Milliseconds each refresh takes (to make callers overlap). */
  refreshDelayMs = 0;
  /** The next refreshes fail with this error kind instead of answering. */
  failRefresh: { kind: 'invalid_grant' | 'unavailable' | 'invalid_client'; times: number } | null = null;
  /** Whether a refresh rotates the refresh token (Microsoft does; Google does not). */
  rotate = true;
  /** A capability whose probe fails, with its reason code. */
  probeFails: Partial<Record<Capability, string>> = {};
  /** Lifetime of an access token. */
  accessTtlSeconds = 3600;

  private readonly pending = new Map<string, Pending>();
  private readonly codes = new Map<string, CodeInfo>();
  private readonly refreshTokens = new Map<string, Grant>();
  private n = 0;

  constructor(readonly id: ConnectionProviderId = 'google') {}

  private token(kind: string): string {
    const t = `MARKER-${this.id}-${kind}-${++this.n}-${randomUUID()}`;
    this.issued.push(t);
    return t;
  }

  scopesFor(capabilities: readonly Capability[]): string[] {
    return [...new Set(capabilities.map((c) => SCOPE_OF[c]))];
  }

  capabilitiesGranted(scopes: readonly string[]): Capability[] {
    return CAPABILITIES.filter((c) => scopes.includes(SCOPE_OF[c]));
  }

  authorizeUrl(input: AuthorizeInput): string {
    this.pending.set(input.state, { challenge: input.codeChallenge, scopes: [...input.scopes], loginHint: input.loginHint ?? null, incremental: input.incremental === true });
    const url = new URL(`https://fake-${this.id}.example.test/authorize`);
    url.searchParams.set('client_id', input.app.clientId);
    url.searchParams.set('redirect_uri', input.app.redirectUri);
    url.searchParams.set('state', input.state);
    url.searchParams.set('scope', input.scopes.join(' '));
    url.searchParams.set('code_challenge', input.codeChallenge);
    url.searchParams.set('code_challenge_method', 'S256');
    if (input.loginHint) url.searchParams.set('login_hint', input.loginHint);
    this.authorizeCalls.push({ ...input, url: url.toString() });
    return url.toString();
  }

  /** What the browser does at the provider: the owner signs in as `account`, ticks or unticks, and is sent back with `code` and `state`. */
  consent(authorizeUrl: string, account: FakeAccount, opts: ConsentOptions = {}): { code: string; state: string } {
    const state = new URL(authorizeUrl).searchParams.get('state')!;
    const p = this.pending.get(state);
    if (!p) throw new Error('unknown authorization request');
    const code = this.token('code');
    const scopes = p.scopes.filter((s) => !(opts.deny ?? []).includes(s));
    this.codes.set(code, { state, account, scopes, noRefreshToken: opts.noRefreshToken === true });
    return { code, state };
  }

  async exchangeCode(input: ExchangeInput): Promise<TokenSet & AccountIdentity> {
    this.exchangeCalls.push({ code: input.code });
    const info = this.codes.get(input.code);
    this.codes.delete(input.code); // single use
    if (!info) throw new OAuthClientError('invalid_grant', 'The grant is no longer valid.', 'invalid_grant', 400);
    const p = this.pending.get(info.state)!;
    if (codeChallengeS256(input.verifier) !== p.challenge) throw new OAuthClientError('invalid_grant', 'The grant is no longer valid.', 'invalid_grant', 400);
    const refreshToken = info.noRefreshToken ? null : this.token('refresh');
    if (refreshToken) this.refreshTokens.set(refreshToken, { account: info.account, scopes: info.scopes, live: true });
    return {
      accessToken: this.token('access'),
      refreshToken,
      expiresAt: new Date(Date.now() + this.accessTtlSeconds * 1000),
      scopes: info.scopes,
      accountId: info.account.accountId,
      email: info.account.email,
      name: info.account.name ?? null,
    };
  }

  async refresh(input: RefreshInput): Promise<TokenSet> {
    this.refreshCalls.push({ refreshToken: input.refreshToken });
    if (this.refreshDelayMs > 0) await new Promise((r) => setTimeout(r, this.refreshDelayMs));
    if (this.failRefresh && this.failRefresh.times > 0) {
      this.failRefresh.times--;
      throw new OAuthClientError(this.failRefresh.kind, 'The provider refused.', this.failRefresh.kind === 'unavailable' ? undefined : this.failRefresh.kind, this.failRefresh.kind === 'unavailable' ? 503 : 400);
    }
    const grant = this.refreshTokens.get(input.refreshToken);
    if (!grant || !grant.live) throw new OAuthClientError('invalid_grant', 'The grant is no longer valid.', 'invalid_grant', 400);
    let refreshToken: string | null = null;
    if (this.rotate) {
      grant.live = false; // the used token is retired
      refreshToken = this.token('refresh');
      this.refreshTokens.set(refreshToken, { account: grant.account, scopes: grant.scopes, live: true });
    }
    return { accessToken: this.token('access'), refreshToken, expiresAt: new Date(Date.now() + this.accessTtlSeconds * 1000), scopes: grant.scopes };
  }

  async revoke(input: RevokeInput): Promise<void> {
    this.revoked.push({ token: input.token, hint: input.hint });
    const g = this.refreshTokens.get(input.token);
    if (g) g.live = false;
  }

  async probe(input: ProbeInput): Promise<ProbeResult> {
    this.probes.push(input.capability);
    const code = this.probeFails[input.capability];
    return code ? { ok: false, code } : { ok: true };
  }

  /** The administrator removed the app at the provider (or the owner revoked it): every refresh token is dead. */
  revokeAllGrants(): void {
    for (const g of this.refreshTokens.values()) g.live = false;
  }

  /** The live refresh tokens (a rotation leaves exactly one per grant). */
  liveRefreshTokens(): string[] {
    return [...this.refreshTokens.entries()].filter(([, g]) => g.live).map(([t]) => t);
  }
}
