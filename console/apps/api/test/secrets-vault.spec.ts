// The Vault connection's building blocks without the database (E37.2, #591): PKCE, the SSRF guard on the address,
// the OAuth client against the fake Vault, and the fake Vault's own adherence to Vault's documented rules (so the
// tests that rely on it mean something).
import { createHash } from 'node:crypto';

import { OAuthClientError, OAuthClientService, PinnedOutboundHttp, checkOutboundUrl, codeChallengeS256, newCodeVerifier, normalizeBaseUrl, safeEqual } from '../src/oauth-client';
import { safeReturnTo } from '../src/secrets/vault-connection.service';
import { VAULT_OAUTH_PATHS, vaultConnectScopes, vaultResource } from '../src/secrets/vault-contract';
import { resolveSecretsSystemSettings } from '../src/secrets/secrets.settings';
import { FAKE_VAULT_CLIENT_ID, FAKE_VAULT_CLIENT_SECRET, FakeVault, startFakeVault } from './support/fake-vault';

const publicResolver = { resolveAll: async () => [{ address: '93.184.216.34', family: 4 as const }] };
const rebindResolver = { resolveAll: async () => [{ address: '10.0.0.7', family: 4 as const }] };

describe('PKCE', () => {
  it('matches the RFC 7636 appendix B vector and makes distinct 64-character verifiers', () => {
    expect(codeChallengeS256('dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk')).toBe('E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM');
    const a = newCodeVerifier();
    expect(a).toMatch(/^[A-Za-z0-9_-]{64}$/);
    expect(newCodeVerifier()).not.toBe(a);
    expect(createHash('sha256').update(a).digest('base64url')).toBe(codeChallengeS256(a));
    expect(safeEqual('abc', 'abc')).toBe(true);
    expect(safeEqual('abc', 'abd')).toBe(false);
  });
});

describe('the Vault address (SSRF guard)', () => {
  const refused = async (url: string, reason: string, resolver = publicResolver, allowDev = false, allowed: string[] = []) => {
    await expect(checkOutboundUrl(url, resolver, allowed, allowDev)).rejects.toMatchObject({ code: reason });
  };

  it('refuses a non-https address', async () => {
    await refused('http://vault.example.test', 'scheme_not_allowed');
    await refused('ftp://vault.example.test', 'scheme_not_allowed');
  });

  it('refuses user info, a malformed address and a low port', async () => {
    await refused('https://user:pw@vault.example.test', 'userinfo_not_allowed');
    await refused('not a url', 'invalid_url');
    await refused('https://vault.example.test:22', 'port_not_allowed');
  });

  it('refuses private, loopback, link-local and metadata addresses', async () => {
    await refused('https://10.0.0.5', 'private_target');
    await refused('https://192.168.1.10', 'private_target');
    await refused('https://169.254.169.254', 'private_target');
    await refused('https://100.64.0.1', 'private_target');
    await refused('https://127.0.0.1', 'private_target');
    await refused('https://[::1]', 'private_target');
    await refused('https://localhost', 'private_target');
    await refused('http://127.0.0.1:8080', 'scheme_not_allowed');
  });

  it('refuses a name that resolves to a private address (DNS rebinding), and one that does not resolve', async () => {
    await refused('https://vault.example.test', 'private_target', rebindResolver);
    await refused('https://vault.example.test', 'unresolvable', { resolveAll: async () => Promise.reject(new Error('ENOTFOUND')) });
  });

  it('accepts a public https address, and loopback http only where development targets are allowed', async () => {
    await expect(checkOutboundUrl('https://vault.example.test', publicResolver, [], false)).resolves.toMatchObject({ address: '93.184.216.34' });
    await expect(checkOutboundUrl('http://127.0.0.1:4000', publicResolver, [], true)).resolves.toMatchObject({ address: '127.0.0.1' });
    // development convenience never opens the rest of the private space
    await refused('https://10.0.0.5', 'private_target', publicResolver, true);
  });

  it('lets an administrator exempt one exact host from the private-address check, https still required', async () => {
    await expect(checkOutboundUrl('https://vault.corp.test', rebindResolver, ['vault.corp.test'], false)).resolves.toMatchObject({ address: '10.0.0.7' });
    await refused('http://vault.corp.test', 'scheme_not_allowed', rebindResolver, false, ['vault.corp.test']);
    await refused('https://other.corp.test', 'private_target', rebindResolver, false, ['vault.corp.test']);
  });

  it('checks again at send time: a name that now resolves to a private address is not called', async () => {
    const http = new PinnedOutboundHttp(rebindResolver);
    await expect(http.send({ method: 'GET', url: 'https://vault.example.test/api/oauth/token' })).rejects.toMatchObject({ code: 'private_target' });
  });

  it('normalizes a base URL and builds the resource indicator', () => {
    expect(normalizeBaseUrl(' https://vault.example.test/ ')).toBe('https://vault.example.test');
    expect(normalizeBaseUrl('https://vault.example.test/prefix/?x=1#y')).toBe('https://vault.example.test/prefix');
    expect(vaultResource('https://vault.example.test/')).toBe('https://vault.example.test/api/agent/v1');
  });

  it('only returns to a path on this console', () => {
    expect(safeReturnTo('/settings/secrets?tab=vault')).toBe('/settings/secrets?tab=vault');
    for (const bad of ['https://evil.example.test/', '//evil.example.test', 'javascript:alert(1)', '/a b', '', undefined, null, `/${'a'.repeat(300)}`]) expect(safeReturnTo(bad as string)).toBe('/settings/secrets');
  });
});

describe('the connection scopes', () => {
  it('asks for read, fill and offline_access; write only on request', () => {
    expect(vaultConnectScopes(false)).toEqual(['vault:items_read', 'vault:items_fill', 'offline_access']);
    expect(vaultConnectScopes(true)).toEqual(['vault:items_read', 'vault:items_fill', 'vault:items_write', 'offline_access']);
  });

  it('the deployment kill switch defaults to off', () => {
    expect(resolveSecretsSystemSettings(null).agentUse.enabled).toBe(false);
    expect(resolveSecretsSystemSettings({ agentUse: { enabled: true } }).agentUse.enabled).toBe(true);
  });
});

describe('the OAuth client against the fake Vault', () => {
  let vault: FakeVault;
  let oauth: OAuthClientService;
  const creds = { clientId: FAKE_VAULT_CLIENT_ID, clientSecret: FAKE_VAULT_CLIENT_SECRET };

  beforeAll(async () => {
    vault = await startFakeVault();
  });
  afterAll(async () => {
    await vault.stop();
  });
  beforeEach(() => {
    oauth = new OAuthClientService(new PinnedOutboundHttp());
  });

  const discover = (o: OAuthClientService = oauth) => o.discover(vault.baseUrl, { metadataPath: VAULT_OAUTH_PATHS.metadata, fallback: VAULT_OAUTH_PATHS });

  async function authorize(scopes = vaultConnectScopes(false), extra: Record<string, string> = {}) {
    const e = await discover();
    const verifier = newCodeVerifier();
    const url = oauth.authorizeUrl(e, { clientId: FAKE_VAULT_CLIENT_ID, redirectUri: vault.options.redirectUris[0]!, scopes, state: 'st', codeChallenge: codeChallengeS256(verifier), resource: vault.resource, ...extra });
    const location = new URL(await vault.consent(url));
    return { e, verifier, location };
  }

  it('discovers the endpoints, all on the Vault origin', async () => {
    const e = await discover();
    expect(e).toMatchObject({ issuer: vault.baseUrl, tokenEndpoint: `${vault.baseUrl}/api/oauth/token`, issuerInResponse: true });
  });

  it('falls back to the conventional paths when the Vault publishes no metadata', async () => {
    const quiet = await startFakeVault({ publishMetadata: false });
    try {
      const e = await new OAuthClientService(new PinnedOutboundHttp()).discover(quiet.baseUrl, { metadataPath: VAULT_OAUTH_PATHS.metadata, fallback: VAULT_OAUTH_PATHS });
      expect(e.authorizationEndpoint).toBe(`${quiet.baseUrl}/api/oauth/authorize`);
      expect(e.revocationEndpoint).toBe(`${quiet.baseUrl}/api/oauth/revoke`);
    } finally {
      await quiet.stop();
    }
  });

  it('sends the resource indicator on the authorize and token requests, and the code verifies with PKCE', async () => {
    const { e, verifier, location } = await authorize();
    expect(location.searchParams.get('iss')).toBe(vault.baseUrl);
    const tokens = await oauth.exchangeCode(e, creds, { code: location.searchParams.get('code')!, verifier, redirectUri: vault.options.redirectUris[0]!, resource: vault.resource });
    expect(tokens.accessToken).toMatch(/^oat_/);
    expect(tokens.refreshToken).toMatch(/^ort_/);
    expect(tokens.scopes).toEqual(['vault:items_read', 'vault:items_fill', 'offline_access']);
    const authz = vault.requests.filter((r) => r.path === '/api/oauth/authorize').at(-1)!;
    expect(authz.params).toMatchObject({ resource: vault.resource, code_challenge_method: 'S256', response_type: 'code', scope: 'vault:items_read vault:items_fill offline_access' });
    const token = vault.requests.filter((r) => r.path === '/api/oauth/token').at(-1)!;
    expect(token.params).toMatchObject({ grant_type: 'authorization_code', resource: vault.resource });
  });

  it('refuses a wrong verifier and a code used twice', async () => {
    const { e, location } = await authorize();
    await expect(oauth.exchangeCode(e, creds, { code: location.searchParams.get('code')!, verifier: newCodeVerifier(), redirectUri: vault.options.redirectUris[0]!, resource: vault.resource })).rejects.toMatchObject({ kind: 'invalid_grant' });
    const again = await authorize();
    const code = again.location.searchParams.get('code')!;
    await oauth.exchangeCode(again.e, creds, { code, verifier: again.verifier, redirectUri: vault.options.redirectUris[0]!, resource: vault.resource });
    await expect(oauth.exchangeCode(again.e, creds, { code, verifier: again.verifier, redirectUri: vault.options.redirectUris[0]!, resource: vault.resource })).rejects.toBeInstanceOf(OAuthClientError);
  });

  it('rotates the refresh token on use; replaying the old one revokes the whole grant', async () => {
    const { e, verifier, location } = await authorize();
    const first = await oauth.exchangeCode(e, creds, { code: location.searchParams.get('code')!, verifier, redirectUri: vault.options.redirectUris[0]!, resource: vault.resource });
    const second = await oauth.refresh(e, creds, { refreshToken: first.refreshToken!, resource: vault.resource });
    expect(second.refreshToken).not.toBe(first.refreshToken);
    // The old refresh token is replayed: invalid_grant, and the grant (so the NEW refresh token too) is gone.
    await expect(oauth.refresh(e, creds, { refreshToken: first.refreshToken!, resource: vault.resource })).rejects.toMatchObject({ kind: 'invalid_grant' });
    await expect(oauth.refresh(e, creds, { refreshToken: second.refreshToken!, resource: vault.resource })).rejects.toMatchObject({ kind: 'invalid_grant' });
  });

  it('authenticates a client registered for client_secret_basic after client_secret_post is refused', async () => {
    const basic = await startFakeVault({ clientAuth: 'basic' });
    try {
      const svc = new OAuthClientService(new PinnedOutboundHttp());
      const e = await svc.discover(basic.baseUrl, { metadataPath: VAULT_OAUTH_PATHS.metadata, fallback: VAULT_OAUTH_PATHS });
      const verifier = newCodeVerifier();
      const url = svc.authorizeUrl(e, { clientId: FAKE_VAULT_CLIENT_ID, redirectUri: basic.options.redirectUris[0]!, scopes: vaultConnectScopes(false), state: 's', codeChallenge: codeChallengeS256(verifier), resource: basic.resource });
      const code = new URL(await basic.consent(url)).searchParams.get('code')!;
      const tokens = await svc.exchangeCode(e, creds, { code, verifier, redirectUri: basic.options.redirectUris[0]!, resource: basic.resource });
      expect(tokens.accessToken).toMatch(/^oat_/);
      // the next refresh goes straight to the method that worked
      const before = basic.requests.length;
      await svc.refresh(e, creds, { refreshToken: tokens.refreshToken!, resource: basic.resource });
      expect(basic.requests.slice(before).filter((r) => r.path === '/api/oauth/token')).toHaveLength(1);
    } finally {
      await basic.stop();
    }
  });

  it('a wrong client secret is invalid_client; a server that is down is unavailable and consumes nothing', async () => {
    const e = await discover();
    await expect(oauth.refresh(e, { clientId: FAKE_VAULT_CLIENT_ID, clientSecret: 'wrong' }, { refreshToken: 'ort_x', resource: vault.resource })).rejects.toMatchObject({ kind: 'invalid_client' });
    const { e: e2, verifier, location } = await authorize();
    const tokens = await oauth.exchangeCode(e2, creds, { code: location.searchParams.get('code')!, verifier, redirectUri: vault.options.redirectUris[0]!, resource: vault.resource });
    vault.failNextRefresh(503);
    await expect(oauth.refresh(e2, creds, { refreshToken: tokens.refreshToken!, resource: vault.resource })).rejects.toMatchObject({ kind: 'unavailable', status: 503 });
    // the refresh token was not consumed by the failed call
    await expect(oauth.refresh(e2, creds, { refreshToken: tokens.refreshToken!, resource: vault.resource })).resolves.toMatchObject({ accessToken: expect.stringMatching(/^oat_/) });
  });

  it('revokes a grant at the Vault', async () => {
    const { e, verifier, location } = await authorize();
    const tokens = await oauth.exchangeCode(e, creds, { code: location.searchParams.get('code')!, verifier, redirectUri: vault.options.redirectUris[0]!, resource: vault.resource });
    await expect(oauth.revoke(e, creds, { token: tokens.refreshToken!, hint: 'refresh_token' })).resolves.toEqual({ revoked: true });
    await expect(oauth.refresh(e, creds, { refreshToken: tokens.refreshToken!, resource: vault.resource })).rejects.toMatchObject({ kind: 'invalid_grant' });
  });
});

describe('the fake Vault follows the documented agent API rules', () => {
  let vault: FakeVault;
  let access: string;
  const oauth = new OAuthClientService(new PinnedOutboundHttp());
  const call = async (method: string, path: string, body?: unknown, token = access) => {
    const res = await fetch(`${vault.baseUrl}/api/agent/v1${path}`, { method, headers: { authorization: `Bearer ${token}`, ...(body ? { 'content-type': 'application/json' } : {}) }, body: body ? JSON.stringify(body) : undefined });
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    return { status: res.status, headers: res.headers, body: (await res.json()) as { data?: any; code?: string } };
  };

  async function grant(scopes: string[]): Promise<string> {
    const e = await oauth.discover(vault.baseUrl, { metadataPath: VAULT_OAUTH_PATHS.metadata, fallback: VAULT_OAUTH_PATHS });
    const verifier = newCodeVerifier();
    const url = oauth.authorizeUrl(e, { clientId: FAKE_VAULT_CLIENT_ID, redirectUri: vault.options.redirectUris[0]!, scopes, state: 's', codeChallenge: codeChallengeS256(verifier), resource: vault.resource });
    const code = new URL(await vault.consent(url)).searchParams.get('code')!;
    return (await oauth.exchangeCode(e, { clientId: FAKE_VAULT_CLIENT_ID, clientSecret: FAKE_VAULT_CLIENT_SECRET }, { code, verifier, redirectUri: vault.options.redirectUris[0]!, resource: vault.resource })).accessToken;
  }

  beforeAll(async () => {
    vault = await startFakeVault();
    access = await grant(vaultConnectScopes(false));
  });
  afterAll(async () => {
    await vault.stop();
  });

  const shop = () => vault.login('Shop login');

  it('whoami answers the contract, with no-store on every response', async () => {
    const r = await call('GET', '/whoami');
    expect(r.status).toBe(200);
    expect(r.body.data).toMatchObject({ userId: vault.userId, scopes: ['vault:items_read', 'vault:items_fill'], contract: { version: '1.3', features: ['logins', 'totp', 'save_login'] } });
    expect(r.headers.get('cache-control')).toBe('no-store');
    expect(r.headers.get('pragma')).toBe('no-cache');
  });

  it('lookup lists exact matches first and a site match only for information; never a password', async () => {
    const exact = await call('GET', `/credentials?origin=${encodeURIComponent('https://app.example.test')}`);
    expect((exact.body.data as { matchKind: string }[])[0]).toMatchObject({ matchKind: 'exact', hasTotp: true, username: 'person-a@example.test' });
    expect(JSON.stringify(exact.body)).not.toContain(shop().password);
    const site = await call('GET', `/credentials?origin=${encodeURIComponent('https://login.example.test')}`);
    // every `*.example.test` host shares the registrable domain: listed for information, never fillable
    expect(new Set((site.body.data as { matchKind: string }[]).map((x) => x.matchKind))).toEqual(new Set(['site']));
    // a closed login is not listed
    expect(((await call('GET', `/credentials?origin=${encodeURIComponent('https://closed.example.test')}`)).body.data as { name: string }[]).map((x) => x.name)).not.toContain('Closed login');
  });

  it('fills one field at a time on an exact origin only', async () => {
    const ok = await call('POST', `/credentials/${shop().id}/fill`, { field: 'password', origin: 'https://app.example.test', purpose: 'login' });
    expect(ok.status).toBe(200);
    expect(ok.body.data).toEqual({ value: shop().password });
    const mismatch = await call('POST', `/credentials/${shop().id}/fill`, { field: 'password', origin: 'https://login.example.test', purpose: 'login' });
    expect(mismatch.status).toBe(403);
    expect(mismatch.body.code).toBe('ORIGIN_MISMATCH');
  });

  it('answers one identical 404 for a missing, closed or code-less login', async () => {
    const body = { field: 'password', origin: 'https://closed.example.test', purpose: 'login' };
    const closed = await call('POST', `/credentials/${vault.login('Closed login').id}/fill`, body);
    const missing = await call('POST', '/credentials/00000000-0000-4000-8000-000000000999/fill', body);
    expect([closed.status, missing.status]).toEqual([404, 404]);
    expect(closed.body).toEqual(missing.body);
    expect((await call('POST', `/credentials/${vault.login('Forum login (1)').id}/totp`, { origin: 'https://forum.example.test', purpose: 'mfa' })).status).toBe(404);
  });

  it('hands out a one-time code with its expiry, derived from a seed it never returns', async () => {
    const r = await call('POST', `/credentials/${shop().id}/totp`, { origin: 'https://app.example.test', purpose: 'mfa' });
    expect(r.status).toBe(200);
    expect(r.body.data).toMatchObject({ code: expect.stringMatching(/^\d{6}$/), expiresAt: expect.any(String) });
    expect(JSON.stringify(r.body)).not.toContain(shop().totpSeed!);
  });

  it('refuses a token without the scope, with the insufficient_scope challenge', async () => {
    const readOnly = await grant(['vault:items_read', 'offline_access']);
    const r = await call('POST', `/credentials/${shop().id}/fill`, { field: 'username', origin: 'https://app.example.test', purpose: 'login' }, readOnly);
    expect(r.status).toBe(403);
    expect(r.headers.get('www-authenticate')).toContain('insufficient_scope');
  });

  it('the kill switch answers 403 AGENT_ACCESS_DISABLED on every route including whoami', async () => {
    vault.setAgentAccess(false);
    try {
      for (const [m, p] of [['GET', '/whoami'], ['GET', '/credentials?origin=https://app.example.test']] as const) {
        const r = await call(m, p);
        expect([r.status, r.body.code]).toEqual([403, 'AGENT_ACCESS_DISABLED']);
      }
    } finally {
      vault.setAgentAccess(true);
    }
  });

  it('429 carries Retry-After; a revoked grant is 401', async () => {
    vault.throttleNext(1, 7);
    const limited = await call('GET', '/whoami');
    expect([limited.status, limited.body.code, limited.headers.get('retry-after')]).toEqual([429, 'RATE_LIMITED', '7']);
    expect((await call('GET', '/whoami')).status).toBe(200);
    const doomed = await grant(vaultConnectScopes(false));
    vault.revokeAllGrants();
    expect((await call('GET', '/whoami', undefined, doomed)).status).toBe(401);
  });
});
