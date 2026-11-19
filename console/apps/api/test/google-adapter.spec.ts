// The Google sign-in adapter against the fake endpoints (E39.3, #601): the authorization URL, the code exchange with PKCE and the
// account identity, the refresh, the revoke, and the closed reason codes of the Test probe.
import { OAuthClientError, OAuthClientService, codeChallengeS256, newCodeVerifier } from '../src/oauth-client';
import { GoogleConnectionAdapter } from '../src/connections/google/google.adapter';
import { SCOPE } from '../src/connections/google/google.scopes';
import { FakeGoogle } from '../src/connections/google/testing';
import type { ProviderApp } from '../src/connections/provider';

const setup = () => {
  const fake = new FakeGoogle();
  const adapter = new GoogleConnectionAdapter(new OAuthClientService(fake), fake);
  const app: ProviderApp = { clientId: fake.client.id, clientSecret: fake.client.secret, redirectUri: 'https://console.example.test/api/connections/callback/google' };
  return { fake, adapter, app };
};

const kind = async (p: Promise<unknown>): Promise<string> => {
  try {
    await p;
    return 'ok';
  } catch (e) {
    return e instanceof OAuthClientError ? e.kind : `other:${(e as Error).name}`;
  }
};

describe('authorizeUrl', () => {
  it('asks for a refresh token on a new connection and not on an incremental consent', () => {
    const { adapter, app } = setup();
    const base = { app, state: 's', codeChallenge: 'c', scopes: adapter.scopesFor(['mail_read']) };
    const fresh = new URL(adapter.authorizeUrl({ ...base, loginHint: 'person-a@example.test' }));
    expect(fresh.searchParams.get('prompt')).toBe('consent');
    expect(fresh.searchParams.get('access_type')).toBe('offline');
    expect(fresh.searchParams.get('include_granted_scopes')).toBe('true');
    expect(fresh.searchParams.get('login_hint')).toBe('person-a@example.test');
    const inc = new URL(adapter.authorizeUrl({ ...base, incremental: true }));
    expect(inc.searchParams.get('prompt')).toBeNull();
    expect(inc.searchParams.get('login_hint')).toBeNull();
    expect(inc.searchParams.get('include_granted_scopes')).toBe('true');
    expect(inc.searchParams.get('client_secret')).toBeNull();
    expect(inc.searchParams.get('code_challenge_method')).toBe('S256');
  });
});

describe('exchangeCode', () => {
  it('exchanges the code with the PKCE verifier and reads the stable id and email from Google', async () => {
    const { fake, adapter, app } = setup();
    const a = fake.addAccount({ email: 'person-a@example.test', name: 'Person A', scopes: [] });
    const verifier = newCodeVerifier();
    const url = adapter.authorizeUrl({ app, state: 'st', codeChallenge: codeChallengeS256(verifier), scopes: adapter.scopesFor(['mail_read', 'calendar_read']) });
    const { code } = fake.consent(url, a);
    const r = await adapter.exchangeCode({ app, code, verifier });
    expect(r).toMatchObject({ accountId: a.sub, email: 'person-a@example.test', name: 'Person A', refreshToken: a.refreshToken });
    expect(r.scopes).toEqual(expect.arrayContaining([SCOPE.gmailRead, SCOPE.calendarRead]));
    expect(adapter.capabilitiesGranted(r.scopes)).toEqual(['mail_read', 'calendar_read']);
    expect(fake.requestsTo('userinfo')[0]!.bearer).toBe(r.accessToken);
    // a code is single use
    expect(await kind(adapter.exchangeCode({ app, code, verifier }))).toBe('invalid_grant');
  });

  it('refuses a wrong verifier, a wrong secret and a userinfo that fails', async () => {
    const { fake, adapter, app } = setup();
    const a = fake.addAccount({ scopes: [] });
    const verifier = newCodeVerifier();
    const url = adapter.authorizeUrl({ app, state: 'st', codeChallenge: codeChallengeS256(verifier), scopes: adapter.scopesFor(['mail_read']) });
    expect(await kind(adapter.exchangeCode({ app, code: fake.consent(url, a).code, verifier: newCodeVerifier() }))).toBe('invalid_grant');
    expect(await kind(adapter.exchangeCode({ app: { ...app, clientSecret: 'wrong' }, code: fake.consent(url, a).code, verifier }))).toBe('invalid_client');
    fake.failNext('userinfo', { status: 503 });
    expect(await kind(adapter.exchangeCode({ app, code: fake.consent(url, a).code, verifier }))).toBe('unavailable');
    fake.failNext('userinfo', { status: 200, body: { email: 'person-a@example.test' } });
    expect(await kind(adapter.exchangeCode({ app, code: fake.consent(url, a).code, verifier }))).toBe('refused');
  });
});

describe('refresh and revoke', () => {
  it('refreshes with the refresh token; a revoked grant is invalid_grant', async () => {
    const { fake, adapter, app } = setup();
    const a = fake.addAccount({ scopes: [SCOPE.gmailRead] });
    const t = await adapter.refresh({ app, refreshToken: a.refreshToken });
    expect(t.accessToken).toBe(a.accessToken);
    expect(t.scopes).toEqual([SCOPE.gmailRead]);
    expect(t.refreshToken).toBeNull(); // Google does not rotate it
    await adapter.revoke({ app, token: a.refreshToken, hint: 'refresh_token' });
    expect(a.revoked).toBe(true);
    expect(await kind(adapter.refresh({ app, refreshToken: a.refreshToken }))).toBe('invalid_grant');
    // a token already gone is not an error
    await expect(adapter.revoke({ app, token: 'unknown', hint: 'refresh_token' })).resolves.toBeUndefined();
  });
});

describe('probe', () => {
  it('maps every answer to a closed reason code and never throws', async () => {
    const { fake, adapter } = setup();
    const a = fake.addAccount({ scopes: [SCOPE.gmailRead, SCOPE.calendarRead, SCOPE.driveFile] });
    for (const c of ['mail_read', 'mail_send', 'mail_modify', 'calendar_read', 'calendar_write', 'docs_read', 'docs_write'] as const) expect(await adapter.probe({ capability: c, accessToken: a.accessToken })).toEqual({ ok: true });
    expect(await adapter.probe({ capability: 'mail_read', accessToken: 'nope' })).toEqual({ ok: false, code: 'UNAUTHORIZED' });
    const cases: [object | 'network', string][] = [
      [{ status: 403, body: { error: { details: [{ reason: 'ACCESS_TOKEN_SCOPE_INSUFFICIENT' }] } } }, 'FORBIDDEN'],
      [{ status: 403, body: { error: { errors: [{ reason: 'accessNotConfigured' }] } } }, 'API_DISABLED'],
      [{ status: 429 }, 'RATE_LIMITED'],
      [{ status: 503 }, 'UNAVAILABLE'],
      [{ status: 400 }, 'FAILED'],
      ['network', 'UNAVAILABLE'],
    ];
    for (const [stub, code] of cases) {
      fake.failNext('labels$', stub as never);
      expect(await adapter.probe({ capability: 'mail_read', accessToken: a.accessToken })).toEqual({ ok: false, code });
    }
    const noMail = fake.addAccount({ scopes: [SCOPE.calendarRead] });
    expect(await adapter.probe({ capability: 'mail_read', accessToken: noMail.accessToken })).toEqual({ ok: false, code: 'FORBIDDEN' });
  });
});
