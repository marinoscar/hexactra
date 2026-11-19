// Connections without a database (E39.2, #599): the capability rules, labels, the return path, the settings merge, the callback
// kept out of logs, the registries and the fake provider's own behaviour.
import { CAPABILITIES, addedCapabilities, groupOf, groupsOf, keepSupported, normalizeCapabilities } from '../src/connections/connections.constants';
import { safeReturnTo, bindingCookieName } from '../src/connections/connection-flow.service';
import { defaultLabel, uniqueLabel } from '../src/connections/connection-labels';
import { ConnectionProviderRegistry } from '../src/connections/connection-provider.registry';
import { ConnectionUsageRegistry } from '../src/connections/connection-usage.registry';
import { CONNECTIONS_SYSTEM_SETTINGS, resolveConnectionsSystemSettings } from '../src/connections/connections.settings';
import { redactedCallbackUrl } from '../src/secrets/secrets.log-redaction';
import { codeChallengeS256, newCodeVerifier } from '../src/oauth-client';
import { FakeConnectionProvider } from './support/fake-connection-provider';

describe('capabilities', () => {
  it('a write capability brings its read capability, in a stable order, without duplicates', () => {
    expect(normalizeCapabilities(['docs_write', 'mail_send', 'mail_read'])).toEqual(['mail_read', 'mail_send', 'docs_read', 'docs_write']);
    expect(normalizeCapabilities(['calendar_write', 'calendar_write'])).toEqual(['calendar_read', 'calendar_write']);
    expect(normalizeCapabilities([])).toEqual([]);
  });

  it('groups are Mail, Calendar and Documents', () => {
    expect(CAPABILITIES.map(groupOf)).toEqual(['mail', 'mail', 'mail', 'calendar', 'calendar', 'docs', 'docs']);
    expect(groupsOf(['docs_read', 'mail_read'])).toEqual(['mail', 'docs']);
  });

  it('keeps only what was both wanted and granted, and never a write without its read', () => {
    expect(keepSupported(['mail_read', 'mail_send', 'calendar_read'], ['mail_read', 'calendar_read'])).toEqual(['mail_read', 'calendar_read']);
    expect(keepSupported(['mail_send'], ['mail_send'])).toEqual([]);
    expect(keepSupported(['mail_send'], ['mail_send', 'mail_read'])).toEqual(['mail_read', 'mail_send']);
  });

  it('names what an incremental consent has to add', () => {
    expect(addedCapabilities(['mail_read'], ['mail_read', 'docs_read'])).toEqual(['docs_read']);
  });
});

describe('labels', () => {
  it('names an account from its provider and email, within the length limit', () => {
    expect(defaultLabel('google', 'person.a@example.test')).toBe('Google (person.a@example.test)');
    expect(defaultLabel('microsoft', 'x'.repeat(100) + '@example.test').length).toBeLessThanOrEqual(60);
  });

  it('adds a number to a name that is taken, ignoring case', () => {
    expect(uniqueLabel('Work', [])).toBe('Work');
    expect(uniqueLabel('Work', ['work'])).toBe('Work 2');
    expect(uniqueLabel('Work', ['Work', 'Work 2'])).toBe('Work 3');
    expect(uniqueLabel('x'.repeat(60), ['x'.repeat(60)]).length).toBeLessThanOrEqual(60);
  });
});

describe('the return path and the binding cookie', () => {
  it('only a path on this console is a return page', () => {
    expect(safeReturnTo('/chat/new')).toBe('/chat/new');
    for (const bad of ['https://evil.example.test', '//evil.example.test', 'javascript:alert(1)', '/a b', undefined, null, '', `/${'x'.repeat(250)}`]) expect(safeReturnTo(bad as string)).toBe('/settings/connections');
  });

  it('names the cookie after the flow, so two flows do not clobber each other', () => {
    expect(bindingCookieName('state-1')).toMatch(/^hx_conn_[a-f0-9]{16}$/);
    expect(bindingCookieName('state-1')).not.toBe(bindingCookieName('state-2'));
  });
});

describe('the callback in logs', () => {
  it('drops the query of both providers\' callbacks, and of nothing else', () => {
    expect(redactedCallbackUrl('/api/connections/callback/google?code=abc&state=def')).toBe('/api/connections/callback/google?redacted');
    expect(redactedCallbackUrl('/api/connections/callback/microsoft?code=abc&state=def')).toBe('/api/connections/callback/microsoft?redacted');
    expect(redactedCallbackUrl('/api/secrets/vault/callback?code=abc')).toBe('/api/secrets/vault/callback?redacted');
    expect(redactedCallbackUrl('/api/connections?x=1')).toBe('/api/connections?x=1');
    expect(redactedCallbackUrl('/api/connections/callback/google')).toBe('/api/connections/callback/google');
  });
});

describe('the connections system settings', () => {
  it('are off by default, with no client id and the common tenant', () => {
    expect(resolveConnectionsSystemSettings(null)).toEqual({ mcp: { enabled: false, allowedHosts: [], blockedHosts: [] }, google: { enabled: false, clientId: null }, microsoft: { enabled: false, clientId: null, tenant: 'common' } });
  });

  it('merge a patch field by field, keep the rest, and tolerate a write to another namespace', () => {
    const merge = CONNECTIONS_SYSTEM_SETTINGS.merge as (c: unknown, p: unknown) => unknown;
    const base = merge(undefined, { providers: { google: { enabled: true, clientId: 'gid' }, microsoft: { tenant: 'consumers' } } });
    expect(resolveConnectionsSystemSettings(base as never)).toEqual({ mcp: { enabled: false, allowedHosts: [], blockedHosts: [] }, google: { enabled: true, clientId: 'gid' }, microsoft: { enabled: false, clientId: null, tenant: 'consumers' } });
    const next = merge(base, { providers: { google: { clientId: null } } });
    expect(resolveConnectionsSystemSettings(next as never).google).toEqual({ enabled: true, clientId: null });
    expect(() => merge(base, undefined)).not.toThrow();
    expect(resolveConnectionsSystemSettings(merge(base, undefined) as never).google.clientId).toBe('gid');
  });
});

describe('the registries', () => {
  it('hold the adapters that registered, and nothing else', () => {
    const r = new ConnectionProviderRegistry();
    expect(r.has('google')).toBe(false);
    const g = new FakeConnectionProvider('google');
    r.register(g);
    expect(r.get('google')).toBe(g);
    expect(r.list()).toEqual([g]);
    r.unregister('google');
    expect(r.get('google')).toBeUndefined();
  });

  it('list what uses a connection, and one source failing does not hide the others or stop the clearing', async () => {
    const r = new ConnectionUsageRegistry();
    const cleared: string[] = [];
    r.register({ kind: 'task', list: async () => [{ kind: 'task', id: '1', name: 'Pay' }], clear: async () => void cleared.push('task') });
    r.register({ kind: 'delivery', list: async () => Promise.reject(new Error('down')), clear: async () => Promise.reject(new Error('down')) });
    expect(await r.list('u', 'c')).toEqual([{ kind: 'task', id: '1', name: 'Pay' }]);
    await r.clear('u', 'c');
    expect(cleared).toEqual(['task']);
  });
});

describe('the fake provider', () => {
  const app = { clientId: 'id', clientSecret: 's', redirectUri: 'https://console.example.test/api/connections/callback/google' };

  it('checks the PKCE verifier, uses a code once, and retires a rotated refresh token', async () => {
    const p = new FakeConnectionProvider('google');
    const verifier = newCodeVerifier();
    const url = p.authorizeUrl({ app, state: 's1', codeChallenge: codeChallengeS256(verifier), scopes: p.scopesFor(['mail_read']) });
    const { code } = p.consent(url, { accountId: 'a', email: 'person.a@example.test' });
    await expect(p.exchangeCode({ app, code, verifier: newCodeVerifier() })).rejects.toMatchObject({ kind: 'invalid_grant' });
    const url2 = p.authorizeUrl({ app, state: 's2', codeChallenge: codeChallengeS256(verifier), scopes: p.scopesFor(['mail_read']) });
    const c2 = p.consent(url2, { accountId: 'a', email: 'person.a@example.test' });
    const t = await p.exchangeCode({ app, code: c2.code, verifier });
    expect(t).toMatchObject({ accountId: 'a', scopes: ['fake:mail.read'] });
    await expect(p.exchangeCode({ app, code: c2.code, verifier })).rejects.toMatchObject({ kind: 'invalid_grant' });
    const r = await p.refresh({ app, refreshToken: t.refreshToken! });
    expect(r.refreshToken).not.toBe(t.refreshToken);
    await expect(p.refresh({ app, refreshToken: t.refreshToken! })).rejects.toMatchObject({ kind: 'invalid_grant' });
    expect(p.capabilitiesGranted(['fake:mail.read', 'fake:docs.write'])).toEqual(['mail_read', 'docs_write']);
  });
});
