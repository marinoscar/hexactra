// The Microsoft sign-in adapter against the fake identity platform (E39.4, #602): scopes per capability from the decision record,
// the authorize URL (PKCE, offline_access, account selection), the stable account id, refresh with rotation, the consent failures
// told apart, the best-effort revoke and the probes of the Test route.
import { OAuthClientError } from '../../src/oauth-client';
import { codeChallengeS256, newCodeVerifier } from '../../src/oauth-client/pkce';
import { CONSUMER_TENANT_ID, microsoftAccountId, microsoftAccountKind } from '../../src/connections/microsoft/microsoft.constants';
import { MicrosoftConnectionAdapter } from '../../src/connections/microsoft/microsoft.adapter';
import { FakeGraph } from '../../src/connections/microsoft/testing/fake-graph';
import type { ProviderApp } from '../../src/connections/provider';

const app = (over: Partial<ProviderApp> = {}): ProviderApp => ({ clientId: 'fake-client-id', clientSecret: 'fake-client-secret', tenant: 'common', redirectUri: 'https://console.example.test/api/connections/callback/microsoft', ...over });

function setup() {
  const fake = new FakeGraph();
  const adapter = new MicrosoftConnectionAdapter({ fetch: fake.fetch });
  const work = fake.addAccount({ email: 'person-a@org-alpha.example.test', kind: 'work', name: 'Person A' });
  const personal = fake.addAccount({ email: 'person-a@example.test', kind: 'personal', name: 'Person A' });
  const consent = async (a: typeof work, caps: Parameters<typeof adapter.scopesFor>[0], over: { app?: ProviderApp } = {}) => {
    const verifier = newCodeVerifier();
    const scopes = adapter.scopesFor(caps);
    const code = fake.authorizeCode(a, { scopes, codeChallenge: codeChallengeS256(verifier) });
    return adapter.exchangeCode({ app: over.app ?? app(), code, verifier });
  };
  return { fake, adapter, work, personal, consent };
}

describe('scopes per capability (decision record)', () => {
  const { adapter } = setup();
  const BASE = ['openid', 'email', 'profile', 'offline_access', 'User.Read'];

  it('always asks for the identity, offline access and the profile, and for nothing more when nothing is on', () => {
    expect(adapter.scopesFor([])).toEqual(BASE);
  });

  it('asks exactly the permission each capability needs; a write brings its read', () => {
    expect(adapter.scopesFor(['mail_read'])).toEqual([...BASE, 'Mail.Read']);
    expect(adapter.scopesFor(['mail_send'])).toEqual([...BASE, 'Mail.Read', 'Mail.Send']);
    expect(adapter.scopesFor(['mail_modify'])).toEqual([...BASE, 'Mail.Read', 'Mail.ReadWrite']);
    expect(adapter.scopesFor(['calendar_write'])).toEqual([...BASE, 'Calendars.Read', 'Calendars.ReadWrite']);
    expect(adapter.scopesFor(['docs_read'])).toEqual([...BASE, 'Files.Read']);
    expect(adapter.scopesFor(['docs_write'])).toEqual([...BASE, 'Files.Read', 'Files.ReadWrite']);
  });

  it('asks for no application permission and no tenant-wide one', () => {
    const all = adapter.scopesFor(['mail_read', 'mail_send', 'mail_modify', 'calendar_read', 'calendar_write', 'docs_read', 'docs_write']);
    expect(all.some((s) => /\.All$|\.default$/.test(s))).toBe(false);
  });

  it('reads what a grant covers: ReadWrite includes Read, but Mail.ReadWrite does not include Mail.Send', () => {
    expect(adapter.capabilitiesGranted(['Mail.ReadWrite'])).toEqual(['mail_read', 'mail_modify']);
    expect(adapter.capabilitiesGranted(['Mail.Read', 'Mail.Send'])).toEqual(['mail_read', 'mail_send']);
    expect(adapter.capabilitiesGranted(['Files.ReadWrite', 'Calendars.Read'])).toEqual(['calendar_read', 'docs_read', 'docs_write']);
    expect(adapter.capabilitiesGranted(['https://graph.microsoft.com/Mail.Read', 'MAIL.SEND'])).toEqual(['mail_read', 'mail_send']);
    expect(adapter.capabilitiesGranted(['openid', 'profile', 'User.Read'])).toEqual([]);
  });
});

describe('the authorization URL', () => {
  const { adapter } = setup();
  const input = { app: app(), state: 'st', codeChallenge: 'ch', scopes: adapter.scopesFor(['mail_read']) };

  it('is the v2 authorize endpoint of the app tenant with PKCE S256, a code response and offline access', () => {
    const u = new URL(adapter.authorizeUrl(input));
    expect(`${u.origin}${u.pathname}`).toBe('https://login.microsoftonline.com/common/oauth2/v2.0/authorize');
    expect(u.searchParams.get('client_id')).toBe('fake-client-id');
    expect(u.searchParams.get('response_type')).toBe('code');
    expect(u.searchParams.get('code_challenge_method')).toBe('S256');
    expect(u.searchParams.get('code_challenge')).toBe('ch');
    expect(u.searchParams.get('state')).toBe('st');
    expect(u.searchParams.get('redirect_uri')).toBe(input.app.redirectUri);
    expect(u.searchParams.get('scope')!.split(' ')).toEqual(expect.arrayContaining(['offline_access', 'Mail.Read']));
    expect(u.searchParams.get('client_secret')).toBeNull();
  });

  it('uses the authority of the setting: common, organizations, consumers or a tenant id; anything else is common', () => {
    for (const t of ['organizations', 'consumers', '11111111-2222-3333-4444-555555555555']) expect(adapter.authorizeUrl({ ...input, app: app({ tenant: t }) })).toContain(`/${t}/oauth2/v2.0/authorize`);
    expect(adapter.authorizeUrl({ ...input, app: app({ tenant: 'evil/../x?y' }) })).toContain('/common/oauth2/');
    expect(adapter.authorizeUrl({ ...input, app: app({ tenant: null }) })).toContain('/common/oauth2/');
  });

  it('lets the owner pick the account unless one is named, so a signed-in work account is not connected by accident', () => {
    expect(new URL(adapter.authorizeUrl(input)).searchParams.get('prompt')).toBe('select_account');
    const hinted = new URL(adapter.authorizeUrl({ ...input, loginHint: 'person-a@example.test' }));
    expect(hinted.searchParams.get('login_hint')).toBe('person-a@example.test');
    expect(hinted.searchParams.get('prompt')).toBeNull();
  });

  it('an incremental consent asks only the permission being added (plus the always-on ones)', () => {
    const u = new URL(adapter.authorizeUrl({ ...input, scopes: adapter.scopesFor(['calendar_read']), incremental: true, loginHint: 'person-a@example.test' }));
    const asked = u.searchParams.get('scope')!.split(' ');
    expect(asked).toContain('Calendars.Read');
    expect(asked).not.toContain('Mail.Read');
  });
});

describe('the code exchange and the account', () => {
  it('stores the account as tenant id and object id, lower case, and reads the address and name', async () => {
    const { work, consent } = setup();
    const r = await consent(work, ['mail_read']);
    expect(r.accountId).toBe(`${work.tenantId.toLowerCase()}:${work.objectId.toLowerCase()}`);
    expect(r.accountId).toBe(microsoftAccountId(work.tenantId, work.objectId));
    expect(r.email).toBe('person-a@org-alpha.example.test');
    expect(r.name).toBe('Person A');
    expect(r.refreshToken).toMatch(/^RT-/);
    expect(r.scopes).toEqual(expect.arrayContaining(['Mail.Read', 'offline_access']));
  });

  it('the same person is two accounts: a work one and a personal one (the consumer tenant), with different ids', async () => {
    const { work, personal, consent } = setup();
    const w = await consent(work, ['mail_read']);
    const p = await consent(personal, ['mail_read']);
    expect(w.accountId).not.toBe(p.accountId);
    expect(p.accountId.startsWith(`${CONSUMER_TENANT_ID}:`)).toBe(true);
    expect(microsoftAccountKind(w.accountId)).toBe('work');
    expect(microsoftAccountKind(p.accountId)).toBe('personal');
    expect(microsoftAccountKind(undefined)).toBe('work');
    expect(w.accessToken).not.toBe(p.accessToken);
    expect(w.refreshToken).not.toBe(p.refreshToken);
  });

  it('reads the granted scopes as the provider lists them, with or without the Graph prefix', async () => {
    const { fake, work, consent } = setup();
    fake.scopePrefix = true;
    const r = await consent(work, ['mail_read', 'calendar_read']);
    expect(r.scopes).toEqual(expect.arrayContaining(['Mail.Read', 'Calendars.Read']));
    expect(r.scopes.some((s) => s.startsWith('https://'))).toBe(false);
  });

  it('refuses a code with the wrong verifier, a code used twice and a wrong client secret, as typed OAuth errors', async () => {
    const { fake, adapter, work } = setup();
    const verifier = newCodeVerifier();
    const code = fake.authorizeCode(work, { scopes: adapter.scopesFor(['mail_read']), codeChallenge: codeChallengeS256(verifier) });
    const wrong = await adapter.exchangeCode({ app: app(), code, verifier: newCodeVerifier() }).catch((e: unknown) => e);
    expect(wrong).toBeInstanceOf(OAuthClientError);
    expect((wrong as OAuthClientError).kind).toBe('invalid_grant');
    const twice = await adapter.exchangeCode({ app: app(), code, verifier }).catch((e: unknown) => e);
    expect((twice as OAuthClientError).kind).toBe('invalid_grant');
    const code2 = fake.authorizeCode(work, { scopes: [], codeChallenge: codeChallengeS256(verifier) });
    const bad = await adapter.exchangeCode({ app: app({ clientSecret: 'nope' }), code: code2, verifier }).catch((e: unknown) => e);
    expect((bad as OAuthClientError).kind).toBe('invalid_client');
  });

  it('is unavailable (nothing consumed) when Microsoft cannot be reached or throttles', async () => {
    const { fake, adapter, work } = setup();
    const verifier = newCodeVerifier();
    const code = fake.authorizeCode(work, { scopes: [], codeChallenge: codeChallengeS256(verifier) });
    fake.drop((r) => r.host === 'login.microsoftonline.com');
    expect(((await adapter.exchangeCode({ app: app(), code, verifier }).catch((e: unknown) => e)) as OAuthClientError).kind).toBe('unavailable');
    fake.fail((r) => r.host === 'login.microsoftonline.com', 503);
    expect(((await adapter.exchangeCode({ app: app(), code, verifier }).catch((e: unknown) => e)) as OAuthClientError).kind).toBe('unavailable');
  });
});

describe('refresh tokens rotate', () => {
  it('gives a new refresh token on every refresh, and the old one is retired', async () => {
    const { adapter, work, consent } = setup();
    const first = await consent(work, ['mail_read']);
    const second = await adapter.refresh({ app: app(), refreshToken: first.refreshToken! });
    expect(second.refreshToken).toMatch(/^RT-/);
    expect(second.refreshToken).not.toBe(first.refreshToken);
    expect(second.accessToken).not.toBe(first.accessToken);
    expect(second.scopes).toEqual(expect.arrayContaining(['Mail.Read']));
    const replay = await adapter.refresh({ app: app(), refreshToken: first.refreshToken! }).catch((e: unknown) => e);
    expect((replay as OAuthClientError).kind).toBe('invalid_grant');
    // The new one still works, and rotates again.
    expect((await adapter.refresh({ app: app(), refreshToken: second.refreshToken! })).refreshToken).not.toBe(second.refreshToken);
  });

  it('a revoked grant is invalid_grant, and so is a sign-in the user must repeat (Conditional Access)', async () => {
    const { fake, adapter, work, consent } = setup();
    const t = await consent(work, ['mail_read']);
    fake.revokeGrant(t.refreshToken!);
    expect(((await adapter.refresh({ app: app(), refreshToken: t.refreshToken! }).catch((e: unknown) => e)) as OAuthClientError).kind).toBe('invalid_grant');
    const t2 = await consent(work, ['mail_read']);
    fake.answer((r) => r.form?.grant_type === 'refresh_token', () => new Response(JSON.stringify({ error: 'interaction_required', error_codes: [50076] }), { status: 400, headers: { 'content-type': 'application/json' } }));
    const e = (await adapter.refresh({ app: app(), refreshToken: t2.refreshToken! }).catch((x: unknown) => x)) as OAuthClientError;
    expect(e.kind).toBe('invalid_grant');
    expect(e.oauthError).toBe('interaction_required');
  });

  it('never puts the provider text, a token or a secret in an error', async () => {
    const { adapter, work, consent } = setup();
    const t = await consent(work, ['mail_read']);
    const e = (await adapter.refresh({ app: app({ clientSecret: 'wrong-secret-value' }), refreshToken: t.refreshToken! }).catch((x: unknown) => x)) as Error;
    const text = `${e.message} ${JSON.stringify(e)} ${e.stack ?? ''}`;
    for (const secret of ['wrong-secret-value', t.refreshToken!, t.accessToken, FakeGraph.CONTENT_MARKER]) expect(text).not.toContain(secret);
  });
});

describe('consent failures are told apart', () => {
  const { adapter } = setup();

  it('an owner who declined is not an administrator approval', () => {
    expect(adapter.classifyAuthorizationError('access_denied', 'AADSTS65004: The user declined to consent to access the app.')).toBe('denied');
    expect(adapter.classifyAuthorizationError('access_denied', null)).toBeNull();
  });

  it('an organization that needs an administrator is ADMIN_CONSENT_REQUIRED, whichever of its codes shows', () => {
    expect(adapter.classifyAuthorizationError('access_denied', 'AADSTS90094: Administrator consent is required.')).toBe('admin_consent_required');
    expect(adapter.classifyAuthorizationError('access_denied', 'AADSTS65001: The user or administrator has not consented to use the application.')).toBe('admin_consent_required');
    expect(adapter.classifyAuthorizationError('consent_required', null)).toBe('admin_consent_required');
    expect(adapter.classifyAuthorizationError('server_error', 'AADSTS500011: something else')).toBeNull();
  });

  it('at the token endpoint, a consent the user may not give is typed, with no text from Microsoft', async () => {
    const { fake, adapter, work } = setup();
    const verifier = newCodeVerifier();
    const code = fake.authorizeCode(work, { scopes: [], codeChallenge: codeChallengeS256(verifier) });
    fake.answer((r) => r.form?.grant_type === 'authorization_code', () => new Response(JSON.stringify({ error: 'invalid_grant', error_description: `AADSTS90094 ${FakeGraph.CONTENT_MARKER}`, error_codes: [90094] }), { status: 400, headers: { 'content-type': 'application/json' } }));
    const e = (await adapter.exchangeCode({ app: app(), code, verifier }).catch((x: unknown) => x)) as OAuthClientError;
    expect(e.oauthError).toBe('admin_consent_required');
    expect(`${e.message}${JSON.stringify(e)}`).not.toContain(FakeGraph.CONTENT_MARKER);
  });

  it('gives an administrator the address to approve the app for the organization, built from the app and nothing personal', () => {
    const u = new URL(adapter.adminConsentUrl(app())!);
    expect(`${u.origin}${u.pathname}`).toBe('https://login.microsoftonline.com/organizations/v2.0/adminconsent');
    expect(u.searchParams.get('client_id')).toBe('fake-client-id');
    expect(u.searchParams.get('redirect_uri')).toBe(app().redirectUri);
    expect(u.searchParams.get('scope')).toBe('https://graph.microsoft.com/.default');
    expect(u.toString()).not.toContain('fake-client-secret');
    expect(adapter.adminConsentUrl(app({ tenant: '11111111-2222-3333-4444-555555555555' }))).toContain('/11111111-2222-3333-4444-555555555555/v2.0/adminconsent');
    expect(adapter.adminConsentUrl(app({ tenant: 'consumers' }))).toBeNull();
  });
});

describe('revoke and probes', () => {
  it('cannot revoke a delegated token at Microsoft, and says so (Disconnect reports revoked: false)', async () => {
    const { adapter } = setup();
    const e = (await adapter.revoke({ app: app(), token: 'x', hint: 'refresh_token' }).catch((x: unknown) => x)) as OAuthClientError;
    expect(e).toBeInstanceOf(OAuthClientError);
    expect(e.oauthError).toBe('no_revocation');
  });

  it('probes one cheap read per capability, with a closed code for a failure', async () => {
    const { fake, adapter, work, consent } = setup();
    const t = await consent(work, ['mail_read', 'calendar_read', 'docs_read']);
    for (const capability of ['mail_read', 'mail_send', 'mail_modify', 'calendar_read', 'calendar_write', 'docs_read', 'docs_write'] as const) expect(await adapter.probe({ capability, accessToken: t.accessToken })).toEqual({ ok: true });
    const paths = fake.calls((r) => r.host === 'graph.microsoft.com').map((r) => r.path);
    expect(paths).toEqual(expect.arrayContaining(['/me/mailFolders/inbox', '/me/calendars', '/me/drive']));
    expect(await adapter.probe({ capability: 'mail_read', accessToken: 'stale' })).toEqual({ ok: false, code: 'UNAUTHORIZED' });
    fake.fail((r) => r.path === '/me/calendars', 403, 'ErrorAccessDenied');
    expect(await adapter.probe({ capability: 'calendar_read', accessToken: t.accessToken })).toEqual({ ok: false, code: 'FORBIDDEN' });
    fake.fail((r) => r.path === '/me/calendars', 503);
    expect(await adapter.probe({ capability: 'calendar_read', accessToken: t.accessToken })).toEqual({ ok: false, code: 'UNAVAILABLE' });
    fake.fail((r) => r.path === '/me/mailFolders/inbox', 404, 'MailboxNotEnabledForRESTAPI');
    expect(await adapter.probe({ capability: 'mail_read', accessToken: t.accessToken })).toEqual({ ok: false, code: 'NO_MAILBOX' });
    fake.drop((r) => r.path === '/me/drive');
    expect(await adapter.probe({ capability: 'docs_read', accessToken: t.accessToken })).toEqual({ ok: false, code: 'UNAVAILABLE' });
  });
});
