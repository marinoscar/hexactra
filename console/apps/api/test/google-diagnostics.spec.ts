// Google's diagnostics against the in-process fake Google (E50.11, #981; #681): the stages of a connection in order, the API to
// enable named from the answer's service id only, a missing permission naming the capability, a revoked grant failing at sign_in
// with the capability stages skipped, one capability failing without hiding another, the token's age, the clock, and the checks of
// the deployment's app with no user. Invented data only; no real Google is called.
import type { DiagnosticStage } from '../src/diagnostics/diagnostic-report';
import { REMEDY_CODES } from '../src/diagnostics/remedies';
import { ConnectionError } from '../src/connections/connections.errors';
import type { Capability } from '../src/connections/connections.constants';
import { GoogleConnectionAdapter } from '../src/connections/google/google.adapter';
import { GOOGLE_APIS, disabledApiOf } from '../src/connections/google/google-diagnostics';
import { SCOPE } from '../src/connections/google/google.scopes';
import { FakeGoogle } from '../src/connections/google/testing';
import { DIAGNOSTIC_CODE } from '../src/connections/oauth-diagnostics';
import type { ConnectionDiagnoseInput, ProviderApp } from '../src/connections/provider';
import { OAuthClientService } from '../src/oauth-client';

const NOW = Date.now();
const setup = () => {
  const fake = new FakeGoogle();
  const adapter = new GoogleConnectionAdapter(new OAuthClientService(fake), fake);
  const app: ProviderApp = { clientId: '123456789012-abcd1234wxyz.apps.googleusercontent.com', clientSecret: 'MARKER-app-secret-google', redirectUri: 'https://console.example.test/api/connections/callback/google' };
  fake.client = { id: app.clientId, secret: app.clientSecret };
  const account = fake.addAccount({ email: 'person-a@example.test' });
  return { fake, adapter, app, account };
};

const input = (o: { token: string | (() => Promise<string>); capabilities: Capability[]; granted?: string[]; app?: ProviderApp | null; enabled?: boolean; lastRefreshAt?: Date | null }): ConnectionDiagnoseInput => ({
  capabilities: o.capabilities,
  grantedScopes: o.granted ?? Object.values(SCOPE),
  accessToken: typeof o.token === 'string' ? () => Promise.resolve(o.token as string) : o.token,
  signal: new AbortController().signal,
  app: o.app === undefined ? { clientId: 'x', clientSecret: 'y', redirectUri: 'https://console.example.test/api/connections/callback/google' } : o.app,
  providerEnabled: o.enabled ?? true,
  token: { expiresAt: new Date(NOW + 30 * 60_000), lastRefreshAt: o.lastRefreshAt === undefined ? new Date(NOW - 60_000) : o.lastRefreshAt, createdAt: new Date(NOW - 3 * 86_400_000) },
});

const shape = (stages: DiagnosticStage[]) => stages.map((s) => [s.id, s.status, s.code]);
const stage = (stages: DiagnosticStage[], id: string) => stages.find((s) => s.id === id)!;

describe("a Google connection's stages", () => {
  it('every stage in order, all passing, with the token times and the clock', async () => {
    const { adapter, account } = setup();
    const stages = await adapter.diagnose(input({ token: account.accessToken, capabilities: ['mail_read', 'calendar_read', 'docs_read'] }));
    expect(shape(stages)).toEqual([
      ['app_config', 'pass', null],
      ['sign_in', 'pass', null],
      ['token_lifetime', 'pass', null],
      ['permissions', 'pass', null],
      ['capability:mail_read', 'pass', null],
      ['capability:calendar_read', 'pass', null],
      ['capability:docs_read', 'pass', null],
      ['clock', 'pass', null],
    ]);
    expect(stage(stages, 'token_lifetime').data).toMatchObject({ last_refresh_age_s: 60 });
    expect(stage(stages, 'capability:docs_read').data).toEqual({ drive: true, docs: true, sheets: true });
    expect(stage(stages, 'permissions').data).toEqual({ checked: 3 });
  });

  it("#681: Read documents with Drive, Docs and Sheets switched off names each API, and Mail still passes", async () => {
    const { fake, adapter, account } = setup();
    for (const api of ['drive.googleapis.com', 'docs.googleapis.com', 'sheets.googleapis.com']) fake.disabledApis.add(api);
    const stages = await adapter.diagnose(input({ token: account.accessToken, capabilities: ['mail_read', 'docs_read'] }));
    expect(stage(stages, 'capability:mail_read').status).toBe('pass');
    const docs = stage(stages, 'capability:docs_read');
    expect(docs).toMatchObject({ status: 'fail', code: 'API_DISABLED', remedy: 'API_DISABLED_DRIVE', data: { api: 'drive.googleapis.com', drive: false, docs: false, sheets: false, disabled: 3 } });
    // Only Sheets off: Sheets is the one named.
    fake.disabledApis.clear();
    fake.disabledApis.add('sheets.googleapis.com');
    const again = stage(await adapter.diagnose(input({ token: account.accessToken, capabilities: ['docs_write'] })), 'capability:docs_write');
    expect(again).toMatchObject({ code: 'API_DISABLED', remedy: 'API_DISABLED_SHEETS', data: { api: 'sheets.googleapis.com', drive: true, docs: true, sheets: false, disabled: 1 } });
    // Calendar: Google's service id for it.
    fake.disabledApis.add('calendar-json.googleapis.com');
    expect(stage(await adapter.diagnose(input({ token: account.accessToken, capabilities: ['calendar_read'] })), 'capability:calendar_read')).toMatchObject({ code: 'API_DISABLED', remedy: 'API_DISABLED_CALENDAR', data: { api: 'calendar-json.googleapis.com' } });
    // The project number in Google's message is never copied.
    expect(JSON.stringify(stages)).not.toContain('123456789012');
    expect(JSON.stringify(stages)).not.toContain('console.developers');
  });

  it('reads the reason and the service id only; an id outside the closed list is dropped', () => {
    expect(disabledApiOf({ error: { details: [{ reason: 'SERVICE_DISABLED', metadata: { service: 'gmail.googleapis.com' } }] } })).toEqual({ disabled: true, api: 'gmail.googleapis.com' });
    expect(disabledApiOf({ error: { details: [{ reason: 'SERVICE_DISABLED', metadata: { service: 'evil.example.test' } }] } })).toEqual({ disabled: true, api: null });
    expect(disabledApiOf({ error: { errors: [{ reason: 'accessNotConfigured' }], message: 'Gmail API has not been used in project 1' } })).toEqual({ disabled: true, api: null });
    expect(disabledApiOf({ error: { errors: [{ reason: 'forbidden' }] } })).toEqual({ disabled: false, api: null });
    for (const remedy of Object.values(GOOGLE_APIS)) expect(REMEDY_CODES.has(remedy)).toBe(true);
  });

  it('a missing permission names the capability (and offers the reconnect); the other capabilities still run', async () => {
    const { adapter, account } = setup();
    const stages = await adapter.diagnose(input({ token: account.accessToken, capabilities: ['mail_read', 'mail_send', 'calendar_read'], granted: ['openid', 'email', SCOPE.gmailRead, SCOPE.calendarRead] }));
    expect(stage(stages, 'permissions')).toMatchObject({ status: 'fail', code: 'PERMISSION_MISSING', remedy: 'PERMISSION_MISSING', data: { capability: 'mail_send', missing: 1, checked: 3 } });
    expect(stage(stages, 'capability:mail_read').status).toBe('pass');
    expect(stage(stages, 'capability:calendar_read').status).toBe('pass');
  });

  it('a revoked grant fails at sign_in and every capability stage is skipped', async () => {
    const { adapter } = setup();
    const revoked = () => Promise.reject(new ConnectionError('CONNECTION_NEEDS_RECONNECT', 'x', { label: 'Work', reason: 'GRANT_REVOKED' }));
    const stages = await adapter.diagnose(input({ token: revoked, capabilities: ['mail_read', 'docs_read'] }));
    expect(shape(stages)).toEqual([
      ['app_config', 'pass', null],
      ['sign_in', 'fail', 'GRANT_REVOKED'],
      ['token_lifetime', 'pass', null],
      ['permissions', 'pass', null],
      ['capability:mail_read', 'skipped', null],
      ['capability:docs_read', 'skipped', null],
      ['clock', 'skipped', null],
    ]);
  });

  it.each([
    [new ConnectionError('CONNECTION_NEEDS_RECONNECT', 'x', { reason: 'NO_REFRESH_TOKEN' }), 'NO_REFRESH_TOKEN'],
    [new ConnectionError('CONNECTION_NEEDS_RECONNECT', 'x', { reason: 'TOKEN_STORE_FAILED' }), 'TOKEN_STORE_FAILED'],
    [new ConnectionError('CONNECTION_UNAVAILABLE', 'x', { reason: 'app_refused' }), 'APP_CREDENTIALS_REFUSED'],
    [new ConnectionError('CONNECTION_UNAVAILABLE', 'x', { reason: 'unavailable' }), 'UNAVAILABLE'],
    [new ConnectionError('CONNECTION_UNAVAILABLE', 'x', { reason: 'token_store_failed' }), 'TOKEN_STORE_FAILED'],
    [new Error('person-a@example.test'), 'UNAVAILABLE'],
  ])('sign_in maps %s to %s', async (error, code) => {
    const { adapter } = setup();
    const stages = await adapter.diagnose(input({ token: () => Promise.reject(error), capabilities: ['mail_read'] }));
    expect(stage(stages, 'sign_in')).toMatchObject({ status: 'fail', code });
  });

  it('app_config: no client id or secret fails (the sign-in is not tried), the switch off warns', async () => {
    const { adapter, account } = setup();
    const token = jest.fn(() => Promise.resolve(account.accessToken));
    const off = await adapter.diagnose(input({ token, capabilities: ['mail_read'], app: null }));
    expect(shape(off).slice(0, 2)).toEqual([
      ['app_config', 'fail', 'APP_NOT_CONFIGURED'],
      ['sign_in', 'skipped', null],
    ]);
    expect(token).not.toHaveBeenCalled();
    expect(stage(await adapter.diagnose(input({ token: account.accessToken, capabilities: ['mail_read'], enabled: false })), 'app_config')).toMatchObject({ status: 'warn', code: 'PROVIDER_OFF' });
  });

  it('token_lifetime warns when the last refresh is older than the health job allows', async () => {
    const { adapter, account } = setup();
    const stages = await adapter.diagnose(input({ token: account.accessToken, capabilities: ['mail_read'], lastRefreshAt: new Date(NOW - 50 * 3_600_000) }));
    expect(stage(stages, 'token_lifetime')).toMatchObject({ status: 'warn', code: 'REFRESH_STALE' });
    expect(stage(stages, 'token_lifetime').data!.last_refresh_age_s).toBeGreaterThan(44 * 3600);
  });

  it("clock warns when Google's Date is more than two minutes off", async () => {
    const { fake, adapter, account } = setup();
    fake.clockSkewMs = 5 * 60_000;
    const c = stage(await adapter.diagnose(input({ token: account.accessToken, capabilities: ['mail_read'] })), 'clock');
    expect(c).toMatchObject({ status: 'warn', code: 'CLOCK_SKEW' });
    expect(Math.abs(Number(c.data!.skew_s) - 300)).toBeLessThanOrEqual(2);
  });

  it('every capability answer is a closed code, and one failing hides none of the others', async () => {
    const { fake, adapter, account } = setup();
    const cases: [object | 'network', string][] = [
      [{ status: 401 }, 'UNAUTHORIZED'],
      [{ status: 403, body: { error: { details: [{ reason: 'ACCESS_TOKEN_SCOPE_INSUFFICIENT' }] } } }, 'PERMISSION_MISSING'],
      [{ status: 403, body: { error: { errors: [{ reason: 'forbidden' }] } } }, 'FORBIDDEN'],
      [{ status: 429, body: { error: { errors: [{ reason: 'rateLimitExceeded' }] } } }, 'RATE_LIMITED'],
      [{ status: 403, body: { error: { errors: [{ reason: 'dailyLimitExceeded' }] } } }, 'QUOTA_EXCEEDED'],
      [{ status: 503 }, 'UNAVAILABLE'],
      ['network', 'UNAVAILABLE'],
    ];
    for (const [stub, code] of cases) {
      fake.failNext('labels$', stub as never);
      const stages = await adapter.diagnose(input({ token: account.accessToken, capabilities: ['mail_read', 'calendar_read'] }));
      expect([code, stage(stages, 'capability:mail_read').status, stage(stages, 'capability:mail_read').code]).toEqual([code, 'fail', code]);
      expect(stage(stages, 'capability:calendar_read').status).toBe('pass');
    }
  });

  it('makes read calls only', async () => {
    const { fake, adapter, account } = setup();
    fake.requests.length = 0;
    await adapter.diagnose(input({ token: account.accessToken, capabilities: ['mail_modify', 'mail_send', 'calendar_write', 'docs_write'] }));
    expect(fake.requests.length).toBeGreaterThan(0);
    expect(fake.requests.every((r) => r.method === 'GET')).toBe(true);
    expect(account.sent).toHaveLength(0);
  });
});

describe("the deployment's Google app, with no user", () => {
  const appInput = (app: ProviderApp, o: { publicOrigin?: string | null; picker?: string | null } = {}) => ({ app, publicOrigin: o.publicOrigin === undefined ? 'https://console.example.test' : o.publicOrigin, pickerApiKey: o.picker === undefined ? 'AIzaFakePickerKey-0000' : o.picker, signal: new AbortController().signal });

  it('passes every stage for a good app, presenting a deliberately invalid code that issues nothing', async () => {
    const { fake, adapter, app } = setup();
    fake.requests.length = 0;
    const stages = await adapter.diagnoseApp(appInput(app));
    expect(shape(stages)).toEqual([
      ['redirect_uri', 'pass', null],
      ['discovery', 'pass', null],
      ['client_check', 'pass', null],
      ['picker_key', 'pass', null],
    ]);
    expect(stage(stages, 'redirect_uri').data).toEqual({ https: true, redirect_host: 'console.example.test', public_host: 'console.example.test', matches_public: true });
    expect(stage(stages, 'discovery').data).toEqual({ endpoints_match: true });
    const token = fake.requestsTo('oauth2.googleapis.com/token');
    expect(token).toHaveLength(1);
    expect(token[0]!.form).toMatchObject({ grant_type: 'authorization_code', code: DIAGNOSTIC_CODE });
    expect(JSON.stringify(stages)).not.toContain(app.clientSecret);
  });

  it('a refused secret is APP_CREDENTIALS_REFUSED; the other stages still run', async () => {
    const { adapter, app } = setup();
    const stages = await adapter.diagnoseApp(appInput({ ...app, clientSecret: 'wrong' }));
    expect(shape(stages)).toEqual([
      ['redirect_uri', 'pass', null],
      ['discovery', 'pass', null],
      ['client_check', 'fail', 'APP_CREDENTIALS_REFUSED'],
      ['picker_key', 'pass', null],
    ]);
  });

  it('the redirect address: not https fails, another address than the public one warns, loopback http warns', async () => {
    const { adapter, app } = setup();
    expect(stage(await adapter.diagnoseApp(appInput({ ...app, redirectUri: 'http://console.example.test/api/connections/callback/google' })), 'redirect_uri')).toMatchObject({ status: 'fail', code: 'REDIRECT_NOT_HTTPS' });
    expect(stage(await adapter.diagnoseApp(appInput(app, { publicOrigin: 'https://other.example.test' })), 'redirect_uri')).toMatchObject({ status: 'warn', code: 'APP_URL_MISMATCH', data: { public_host: 'other.example.test', matches_public: false } });
    expect(stage(await adapter.diagnoseApp(appInput({ ...app, redirectUri: 'http://localhost:3535/api/connections/callback/google' }, { publicOrigin: 'http://localhost:3535' })), 'redirect_uri')).toMatchObject({ status: 'warn', code: 'REDIRECT_NOT_HTTPS' });
  });

  it('discovery down, an answer that cannot tell, and no picker key', async () => {
    const { fake, adapter, app } = setup();
    fake.discoveryStatus = 503;
    fake.failNext('oauth2.googleapis.com/token', { status: 400, body: { error: 'invalid_request' } });
    const stages = await adapter.diagnoseApp(appInput(app, { picker: null }));
    expect(shape(stages)).toEqual([
      ['redirect_uri', 'pass', null],
      ['discovery', 'fail', 'UNAVAILABLE'],
      ['client_check', 'skipped', 'NEEDS_A_SIGN_IN'],
      ['picker_key', 'warn', 'PICKER_KEY_MISSING'],
    ]);
  });
});
