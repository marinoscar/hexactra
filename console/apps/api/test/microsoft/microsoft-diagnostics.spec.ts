// Microsoft's diagnostics against the fake Graph and identity platform (E50.11, #981): the Graph error `code` (never the message)
// mapped to a closed list (a missing permission, no mailbox, no licence, an administrator's approval), one capability failing
// without hiding another, the clock, and the checks of the deployment's app registration: the tenant, the client id and secret.
// Invented data only; no real Microsoft account is called.
import type { DiagnosticStage } from '../../src/diagnostics/diagnostic-report';
import { ConnectionError } from '../../src/connections/connections.errors';
import type { Capability } from '../../src/connections/connections.constants';
import { MicrosoftConnectionAdapter } from '../../src/connections/microsoft/microsoft.adapter';
import { graphOutcome } from '../../src/connections/microsoft/microsoft-diagnostics';
import { FakeGraph } from '../../src/connections/microsoft/testing/fake-graph';
import { DIAGNOSTIC_CODE } from '../../src/connections/oauth-diagnostics';
import type { ConnectionDiagnoseInput, ProviderApp } from '../../src/connections/provider';

const NOW = Date.now();
const setup = () => {
  const fake = new FakeGraph();
  const adapter = new MicrosoftConnectionAdapter({ fetch: (...a) => fake.fetch(...a) });
  const account = fake.addAccount({ email: 'person-a@example.test' });
  const token = fake.issue(account, ['Mail.Read', 'Calendars.Read', 'Files.Read']);
  const app: ProviderApp = { clientId: fake.clientId, clientSecret: fake.clientSecret, tenant: 'common', redirectUri: 'https://console.example.test/api/connections/callback/microsoft' };
  return { fake, adapter, account, token, app };
};

const input = (token: string | (() => Promise<string>), capabilities: Capability[], granted = ['openid', 'offline_access', 'User.Read', 'Mail.Read', 'Calendars.Read', 'Files.Read']): ConnectionDiagnoseInput => ({
  capabilities,
  grantedScopes: granted,
  accessToken: typeof token === 'string' ? () => Promise.resolve(token) : token,
  signal: new AbortController().signal,
  app: { clientId: 'x', clientSecret: 'y', tenant: 'common', redirectUri: 'https://console.example.test/api/connections/callback/microsoft' },
  providerEnabled: true,
  token: { expiresAt: new Date(NOW + 30 * 60_000), lastRefreshAt: new Date(NOW - 60_000), createdAt: new Date(NOW - 86_400_000) },
});
const shape = (stages: DiagnosticStage[]) => stages.map((s) => [s.id, s.status, s.code]);
const stage = (stages: DiagnosticStage[], id: string) => stages.find((s) => s.id === id)!;

describe("a Microsoft connection's stages", () => {
  it('every stage in order, all passing', async () => {
    const { adapter, token } = setup();
    expect(shape(await adapter.diagnose(input(token, ['mail_read', 'calendar_read', 'docs_read'])))).toEqual([
      ['app_config', 'pass', null],
      ['sign_in', 'pass', null],
      ['token_lifetime', 'pass', null],
      ['permissions', 'pass', null],
      ['capability:mail_read', 'pass', null],
      ['capability:calendar_read', 'pass', null],
      ['capability:docs_read', 'pass', null],
      ['clock', 'pass', null],
    ]);
  });

  it('an account without a mailbox fails Mail with MAILBOX_NOT_FOUND; Calendar and Documents still pass', async () => {
    const { fake, adapter, token } = setup();
    fake.fail((r) => r.path.startsWith('/me/mailFolders'), 404, 'MailboxNotEnabledForRESTAPI');
    const stages = await adapter.diagnose(input(token, ['mail_read', 'calendar_read', 'docs_read']));
    expect(stage(stages, 'capability:mail_read')).toMatchObject({ status: 'fail', code: 'MAILBOX_NOT_FOUND', remedy: 'MAILBOX_NOT_FOUND' });
    expect(stage(stages, 'capability:calendar_read').status).toBe('pass');
    expect(stage(stages, 'capability:docs_read').status).toBe('pass');
    expect(JSON.stringify(stages)).not.toContain(FakeGraph.CONTENT_MARKER);
  });

  it.each([
    [403, 'ErrorAccessDenied', 'PERMISSION_MISSING'],
    [403, 'Authorization_RequestDenied', 'PERMISSION_MISSING'],
    [403, 'SomethingElse', 'FORBIDDEN'],
    [403, 'ErrorInvalidLicense', 'LICENSE_MISSING'],
    [403, 'AdminConsentRequired', 'ADMIN_CONSENT_REQUIRED'],
    [401, 'InvalidAuthenticationToken', 'UNAUTHORIZED'],
    [429, 'ApplicationThrottled', 'RATE_LIMITED'],
    [507, 'quotaLimitReached', 'QUOTA_EXCEEDED'],
    [503, 'serviceNotAvailable', 'UNAVAILABLE'],
    [400, 'BadRequest', 'FAILED'],
  ])('a Graph %s %s on Documents is %s', async (status, code, expected) => {
    const { fake, adapter, token } = setup();
    fake.fail((r) => r.path === '/me/drive', status, code);
    const stages = await adapter.diagnose(input(token, ['docs_read', 'mail_read']));
    expect(stage(stages, 'capability:docs_read')).toMatchObject({ status: 'fail', code: expected });
    expect(stage(stages, 'capability:mail_read').status).toBe('pass');
  });

  it('reads the code only; a mail 404 ResourceNotFound is no mailbox, elsewhere it is NOT_FOUND', () => {
    expect(graphOutcome(404, 'ResourceNotFound', 'mail_read').code).toBe('MAILBOX_NOT_FOUND');
    expect(graphOutcome(404, 'ResourceNotFound', 'calendar_read').code).toBe('NOT_FOUND');
    expect(graphOutcome(200, '', 'mail_read').status).toBe('pass');
  });

  it('a missing permission names the capability; an administrator approval needed at the sign-in is named too', async () => {
    const { adapter, token } = setup();
    const stages = await adapter.diagnose(input(token, ['mail_read', 'mail_send'], ['openid', 'Mail.Read']));
    expect(stage(stages, 'permissions')).toMatchObject({ status: 'fail', code: 'PERMISSION_MISSING', data: { capability: 'mail_send', missing: 1 } });
    const consent = await adapter.diagnose(input(() => Promise.reject(new ConnectionError('CONNECTION_UNAVAILABLE', 'x', { reason: 'admin_consent_required' })), ['mail_read']));
    expect(shape(consent).slice(1, 2)).toEqual([['sign_in', 'fail', 'ADMIN_CONSENT_REQUIRED']]);
    expect(stage(consent, 'capability:mail_read').status).toBe('skipped');
  });

  it("clock warns when Microsoft's Date is more than two minutes off", async () => {
    const { fake, adapter, token } = setup();
    fake.clockSkewMs = -4 * 60_000;
    expect(stage(await adapter.diagnose(input(token, ['calendar_read'])), 'clock')).toMatchObject({ status: 'warn', code: 'CLOCK_SKEW' });
  });
});

describe("the deployment's Microsoft app registration, with no user", () => {
  const appInput = (app: ProviderApp) => ({ app, publicOrigin: 'https://console.example.test', signal: new AbortController().signal });

  it('passes for a good app, presenting a deliberately invalid code', async () => {
    const { fake, adapter, app } = setup();
    const stages = await adapter.diagnoseApp(appInput(app));
    expect(shape(stages)).toEqual([
      ['redirect_uri', 'pass', null],
      ['discovery', 'pass', null],
      ['client_check', 'pass', null],
    ]);
    expect(stage(stages, 'discovery').data).toEqual({ tenant_kind: 'common' });
    const tokenCalls = fake.calls((r) => r.path.endsWith('/oauth2/v2.0/token'));
    expect(tokenCalls).toHaveLength(1);
    expect(tokenCalls[0]!.form).toMatchObject({ grant_type: 'authorization_code', code: DIAGNOSTIC_CODE });
    expect(JSON.stringify(stages)).not.toContain(app.clientSecret);
  });

  it('a wrong secret is APP_CREDENTIALS_REFUSED; an unknown tenant is TENANT_NOT_FOUND', async () => {
    const { fake, adapter, app } = setup();
    expect(stage(await adapter.diagnoseApp(appInput({ ...app, clientSecret: 'wrong' })), 'client_check')).toMatchObject({ status: 'fail', code: 'APP_CREDENTIALS_REFUSED' });
    const tenant = '11111111-2222-4333-8444-555555555555';
    fake.unknownTenants.add(tenant);
    const stages = await adapter.diagnoseApp(appInput({ ...app, tenant }));
    expect(shape(stages)).toEqual([
      ['redirect_uri', 'pass', null],
      ['discovery', 'fail', 'TENANT_NOT_FOUND'],
      ['client_check', 'fail', 'TENANT_NOT_FOUND'],
    ]);
    expect(JSON.stringify(stages)).not.toContain(tenant);
    expect(JSON.stringify(stages)).not.toContain(FakeGraph.CONTENT_MARKER);
  });

  it('an answer that cannot tell the client apart is skipped with NEEDS_A_SIGN_IN', async () => {
    const { fake, adapter, app } = setup();
    fake.answer(
      (r) => r.path.endsWith('/oauth2/v2.0/token'),
      () => new Response(JSON.stringify({ error: 'invalid_request', error_codes: [900144] }), { status: 400, headers: { 'content-type': 'application/json' } }),
    );
    expect(stage(await adapter.diagnoseApp(appInput(app)), 'client_check')).toMatchObject({ status: 'skipped', code: 'NEEDS_A_SIGN_IN' });
  });
});
