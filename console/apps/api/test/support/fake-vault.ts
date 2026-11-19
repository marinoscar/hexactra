// A FAKE VAULT for tests (E37.2, #591): a small HTTP server that behaves like Vault's OAuth server and agent
// credential API as documented in marinoscar/vault `docs/agent-credential-api.md` (commit 749cbc69, contract 1.2,
// beta). It holds only invented data (`Person A`, `*.example.test`, random canaries as the values).
//
// What it implements:
//   OAuth      discovery (`/api/oauth/.well-known/authorization-server`), `GET /api/oauth/authorize` (PKCE S256,
//              `resource` and redirect URI checks, auto-consent: it redirects to `redirect_uri` with `code`, `state`
//              and `iss`), `POST /api/oauth/token` (authorization code and refresh token; refresh tokens ROTATE ON
//              USE and replaying a used one revokes the WHOLE grant; `client_secret_post` or `client_secret_basic`),
//              `POST /api/oauth/revoke`. Form bodies only, RFC 6749 error JSON.
//   Agent API  `/api/agent/v1`: `GET /whoami`, `GET /credentials?origin=`, `POST /credentials/{id}/fill`,
//              `POST /credentials/{id}/totp`. The deployment kill switch (`403 AGENT_ACCESS_DISABLED`), scopes
//              (`403` with `WWW-Authenticate: ... insufficient_scope`), per-login opt-in with ONE identical `404`,
//              exact origin binding (`403 ORIGIN_MISMATCH`; a site-only match is listed but never fillable),
//              `429 RATE_LIMITED` with `Retry-After`, and `Cache-Control: no-store` on every response.
// It is a TEST SUPPORT file: it refuses to start with NODE_ENV=production. When marinoscar/vault#196's conformance
// kit is available a follow-up replaces this fake with the kit's.
//
// Use it from jest:  const vault = await startFakeVault(); ... await vault.stop();
// Or standalone:     npx ts-node test/support/fake-vault.main.ts   (prints one JSON line with its settings)
import { createHash, createHmac, randomBytes, randomUUID } from 'node:crypto';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';

export const FAKE_VAULT_CLIENT_ID = 'hexactra-test-client';
export const FAKE_VAULT_CLIENT_SECRET = 'fake-vault-client-secret-0000';

export interface FakeLogin {
  id: string;
  name: string;
  username: string;
  password: string;
  origins: string[];
  open: boolean;
  /** An authenticator seed (any string): a code is derived from it and the current 30 s period. */
  totpSeed: string | null;
}

export interface FakeVaultOptions {
  port?: number;
  clientId?: string;
  clientSecret?: string;
  /** Redirect URIs the client is registered with. */
  redirectUris?: string[];
  /** Which client authentication the client is registered for: the server then refuses the other (as Vault's does). Default `post`. */
  clientAuth?: 'post' | 'basic';
  /** Publish the discovery document (default true); false answers 404 so a client falls back to the conventional paths. */
  publishMetadata?: boolean;
  /** Send `iss` on the authorization response and declare it in the metadata (RFC 9207). Default true. */
  issInResponse?: boolean;
  accessTtlSeconds?: number;
  /** The deployment kill switch of the agent API (default true: on). */
  agentAccess?: boolean;
  /** How long after a rotation the previous refresh token still answers with the same new pair (Vault: 10 s). Default 0. */
  refreshGraceMs?: number;
  /** Extra delay on every refresh grant, to make concurrent refreshes overlap. */
  refreshDelayMs?: number;
}

/** What the server saw: no secret values; the token requests keep their field NAMES and the non-secret values. */
export interface RecordedRequest {
  method: string;
  path: string;
  status: number;
  /** For agent routes: the body fields that are not secret (`field`, `origin`, `purpose`). For token and authorize: the non-secret parameters (`grant_type`, `resource`, `redirect_uri`, `client_id`, `code_challenge_method`, `scope`). */
  params?: Record<string, string>;
}

interface Grant {
  id: string;
  clientId: string;
  userId: string;
  scopes: string[];
  revoked: boolean;
  refresh: string;
  rotatedAt: number;
  /** Retired refresh tokens, with their successor (for the grace window). */
  retired: Map<string, { next: { access: string; refresh: string }; at: number }>;
  access: Set<string>;
}

const b64u = (b: Buffer) => b.toString('base64url');
const token = (prefix: string) => `${prefix}${b64u(randomBytes(24))}`;
const sha256b64u = (s: string) => b64u(createHash('sha256').update(s, 'ascii').digest());

export class FakeVault {
  readonly options: Required<Omit<FakeVaultOptions, 'port'>>;
  readonly userId = 'vault-user-person-a';
  readonly requests: RecordedRequest[] = [];
  readonly stats = { authorize: 0, token: 0, refresh: 0, revoke: 0 };
  /** Every refresh token this server issued, oldest first (for replay tests). Test-only: real Vault never exposes them. */
  readonly issuedRefreshTokens: string[] = [];
  /** Every authorization code this server issued (test-only, for no-leak scans). */
  readonly issuedCodes: string[] = [];
  /** The login values are canaries: a test scans logs, spans and responses for them. */
  readonly logins: FakeLogin[];
  baseUrl = '';
  private server: Server | null = null;
  private readonly codes = new Map<string, { clientId: string; redirectUri: string; challenge: string; scopes: string[]; resource: string; used: boolean }>();
  readonly grants = new Map<string, Grant>();
  private denyNext = false;
  private throttle = { remaining: 0, retryAfter: 1 };
  private failRefresh: number | null = null;

  constructor(options: FakeVaultOptions = {}) {
    if (process.env.NODE_ENV === 'production') throw new Error('The fake Vault is test support and refuses to start in production.');
    this.options = {
      clientId: options.clientId ?? FAKE_VAULT_CLIENT_ID,
      clientSecret: options.clientSecret ?? FAKE_VAULT_CLIENT_SECRET,
      redirectUris: options.redirectUris ?? ['http://localhost:3535/api/secrets/vault/callback'],
      clientAuth: options.clientAuth ?? 'post',
      publishMetadata: options.publishMetadata ?? true,
      issInResponse: options.issInResponse ?? true,
      accessTtlSeconds: options.accessTtlSeconds ?? 300,
      agentAccess: options.agentAccess ?? true,
      refreshGraceMs: options.refreshGraceMs ?? 0,
      refreshDelayMs: options.refreshDelayMs ?? 0,
    };
    const canary = (label: string) => `CANARY-${label}-${b64u(randomBytes(9))}`;
    this.logins = [
      { id: '7f1c2e9a-0000-4000-8000-000000000001', name: 'Shop login', username: 'person-a@example.test', password: canary('shop-password'), origins: ['https://app.example.test'], open: true, totpSeed: canary('shop-totp-seed') },
      { id: '7f1c2e9a-0000-4000-8000-000000000002', name: 'Forum login (1)', username: 'person-a', password: canary('forum1-password'), origins: ['https://forum.example.test'], open: true, totpSeed: null },
      { id: '7f1c2e9a-0000-4000-8000-000000000003', name: 'Forum login (2)', username: 'person-a-alt', password: canary('forum2-password'), origins: ['https://forum.example.test'], open: true, totpSeed: null },
      { id: '7f1c2e9a-0000-4000-8000-000000000004', name: 'Closed login', username: 'person-a', password: canary('closed-password'), origins: ['https://closed.example.test'], open: false, totpSeed: null },
    ];
  }

  // ---- lifecycle ----

  async start(port = 0): Promise<this> {
    this.server = createServer((req, res) => {
      this.handle(req, res).catch(() => {
        if (!res.headersSent) res.writeHead(500, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ message: 'fake vault error' }));
      });
    });
    await new Promise<void>((resolve) => this.server!.listen(port, '127.0.0.1', resolve));
    this.baseUrl = `http://127.0.0.1:${(this.server!.address() as AddressInfo).port}`;
    return this;
  }

  async stop(): Promise<void> {
    await new Promise<void>((resolve) => (this.server ? this.server.close(() => resolve()) : resolve()));
    this.server = null;
  }

  get resource(): string {
    return `${this.baseUrl}/api/agent/v1`;
  }

  // ---- controls ----

  /** The agent API's deployment kill switch. */
  /** `agentAccess.identity.enabled` of the fake: off answers `403 IDENTITY_ACCESS_DISABLED` on the identity routes. */
  identityAccess = true;

  setAgentAccess(on: boolean): void {
    this.options.agentAccess = on;
  }

  /** Revokes every grant (an administrator removed the app): the next refresh is `invalid_grant`, the next agent call `401`. */
  revokeAllGrants(): void {
    for (const g of this.grants.values()) g.revoked = true;
  }

  setLoginOpen(id: string, open: boolean): void {
    const l = this.logins.find((x) => x.id === id);
    if (l) l.open = open;
  }

  /** The next `n` agent API calls answer `429 RATE_LIMITED` with `Retry-After`. */
  throttleNext(n: number, retryAfterSeconds = 1): void {
    this.throttle = { remaining: n, retryAfter: retryAfterSeconds };
  }

  /** The next authorization is denied by the user (`error=access_denied` on the redirect). */
  denyNextAuthorization(): void {
    this.denyNext = true;
  }

  /** The next refresh grant answers this HTTP status (503: Vault is down). */
  failNextRefresh(status: number): void {
    this.failRefresh = status;
  }

  /** The login whose values a test looks for. */
  login(name: string): FakeLogin {
    return this.logins.find((l) => l.name === name)!;
  }

  /** Every value this server can hand out: scan logs, spans, audit rows and responses for these. */
  canaries(): string[] {
    return this.logins.flatMap((l) => [l.password, ...(l.totpSeed ? [l.totpSeed] : [])]);
  }

  /** Plays the browser at the consent screen: GETs the authorize URL (auto-consent) and returns the redirect Location it answers with. */
  async consent(authorizeUrl: string): Promise<string> {
    const res = await fetch(authorizeUrl, { redirect: 'manual' });
    return res.headers.get('location') ?? '';
  }

  // ---- HTTP ----

  private json(res: ServerResponse, status: number, body: unknown, extra: Record<string, string> = {}): number {
    res.writeHead(status, { 'content-type': 'application/json', 'cache-control': 'no-store', pragma: 'no-cache', ...extra });
    res.end(JSON.stringify(body));
    return status;
  }

  private async readBody(req: IncomingMessage): Promise<string> {
    const chunks: Buffer[] = [];
    for await (const c of req) chunks.push(c as Buffer);
    return Buffer.concat(chunks).toString('utf8');
  }

  private async handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const url = new URL(req.url ?? '/', this.baseUrl || 'http://127.0.0.1');
    const method = req.method ?? 'GET';
    const rec: RecordedRequest = { method, path: url.pathname, status: 0 };
    this.requests.push(rec);
    const finish = (status: number) => {
      rec.status = status;
    };
    if (url.pathname === '/api/oauth/.well-known/authorization-server' && method === 'GET') return void finish(this.metadata(res));
    if (url.pathname === '/api/oauth/authorize' && method === 'GET') return void finish(this.authorize(url, res, rec));
    if (url.pathname === '/api/oauth/token' && method === 'POST') return void finish(await this.tokenEndpoint(req, res, rec));
    if (url.pathname === '/api/oauth/revoke' && method === 'POST') return void finish(await this.revoke(req, res));
    if (url.pathname.startsWith('/api/agent/v1/')) return void finish(await this.agent(req, res, url, rec));
    finish(this.json(res, 404, { message: 'Not found' }));
  }

  private metadata(res: ServerResponse): number {
    if (!this.options.publishMetadata) return this.json(res, 404, { message: 'Not found' });
    return this.json(res, 200, {
      issuer: this.baseUrl,
      authorization_endpoint: `${this.baseUrl}/api/oauth/authorize`,
      token_endpoint: `${this.baseUrl}/api/oauth/token`,
      revocation_endpoint: `${this.baseUrl}/api/oauth/revoke`,
      scopes_supported: ['vault:items_read', 'vault:items_fill', 'vault:items_write', 'vault:identity_read', 'vault:identity_fill', 'offline_access'],
      response_types_supported: ['code'],
      grant_types_supported: ['authorization_code', 'refresh_token'],
      token_endpoint_auth_methods_supported: ['none', 'client_secret_post', 'client_secret_basic'],
      code_challenge_methods_supported: ['S256'],
      ...(this.options.issInResponse ? { authorization_response_iss_parameter_supported: true } : {}),
    });
  }

  // ---- OAuth ----

  private authorize(url: URL, res: ServerResponse, rec: RecordedRequest): number {
    this.stats.authorize++;
    const q = url.searchParams;
    rec.params = { client_id: q.get('client_id') ?? '', redirect_uri: q.get('redirect_uri') ?? '', response_type: q.get('response_type') ?? '', scope: q.get('scope') ?? '', code_challenge_method: q.get('code_challenge_method') ?? '', resource: q.get('resource') ?? '', has_state: String(Boolean(q.get('state'))) };
    const redirectUri = q.get('redirect_uri') ?? '';
    // An unknown client or redirect URI is never redirected to (RFC 6749 §4.1.2.1).
    if (q.get('client_id') !== this.options.clientId || !this.options.redirectUris.includes(redirectUri)) return this.json(res, 400, { error: 'invalid_request' });
    const back = (params: Record<string, string>) => {
      const u = new URL(redirectUri);
      for (const [k, v] of Object.entries(params)) u.searchParams.set(k, v);
      if (q.get('state')) u.searchParams.set('state', q.get('state')!);
      if (this.options.issInResponse) u.searchParams.set('iss', this.baseUrl);
      res.writeHead(302, { location: u.toString(), 'cache-control': 'no-store' });
      res.end();
      return 302;
    };
    if (q.get('response_type') !== 'code') return back({ error: 'unsupported_response_type' });
    if (q.get('code_challenge_method') !== 'S256' || !q.get('code_challenge')) return back({ error: 'invalid_request' });
    if (q.get('resource') !== this.resource) return back({ error: 'invalid_target' });
    const scopes = (q.get('scope') ?? '').split(/\s+/).filter(Boolean);
    const allowed = ['vault:items_read', 'vault:items_fill', 'vault:items_write', 'vault:identity_read', 'vault:identity_fill', 'offline_access'];
    if (scopes.some((s) => !allowed.includes(s))) return back({ error: 'invalid_scope' });
    if (this.denyNext) {
      this.denyNext = false;
      return back({ error: 'access_denied' });
    }
    const code = token('code_');
    this.issuedCodes.push(code);
    this.codes.set(code, { clientId: this.options.clientId, redirectUri, challenge: q.get('code_challenge')!, scopes: scopes.length ? scopes : ['vault:items_read'], resource: this.resource, used: false });
    return back({ code });
  }

  private clientAuthenticated(req: IncomingMessage, form: URLSearchParams): boolean {
    const header = req.headers.authorization;
    const basic = header?.startsWith('Basic ') ? Buffer.from(header.slice(6), 'base64').toString('utf8').split(':') : null;
    const id = basic ? decodeURIComponent(basic[0] ?? '') : form.get('client_id');
    const secret = this.options.clientAuth === 'basic' ? (basic ? decodeURIComponent(basic.slice(1).join(':')) : undefined) : (form.get('client_secret') ?? undefined);
    return id === this.options.clientId && secret === this.options.clientSecret;
  }

  private async tokenEndpoint(req: IncomingMessage, res: ServerResponse, rec: RecordedRequest): Promise<number> {
    if (!String(req.headers['content-type'] ?? '').startsWith('application/x-www-form-urlencoded')) return this.json(res, 400, { error: 'invalid_request' });
    const form = new URLSearchParams(await this.readBody(req));
    this.stats.token++;
    rec.params = { grant_type: form.get('grant_type') ?? '', client_id: form.get('client_id') ?? '', resource: form.get('resource') ?? '', redirect_uri: form.get('redirect_uri') ?? '', has_client_secret_in_body: String(form.has('client_secret')), has_basic_auth: String(Boolean(req.headers.authorization)) };
    if (!this.clientAuthenticated(req, form)) return this.json(res, 401, { error: 'invalid_client' }, { 'www-authenticate': 'Basic' });
    const grantType = form.get('grant_type');
    if (grantType === 'authorization_code') return this.codeGrant(form, res);
    if (grantType === 'refresh_token') {
      this.stats.refresh++;
      if (this.options.refreshDelayMs > 0) await new Promise((r) => setTimeout(r, this.options.refreshDelayMs));
      if (this.failRefresh !== null) {
        const status = this.failRefresh;
        this.failRefresh = null;
        return this.json(res, status, { error: 'temporarily_unavailable' });
      }
      return this.refreshGrant(form, res);
    }
    return this.json(res, 400, { error: 'unsupported_grant_type' });
  }

  private issue(grant: Grant, res: ServerResponse): number {
    const access = token('oat_');
    grant.access.add(access);
    const out: Record<string, unknown> = { access_token: access, token_type: 'Bearer', expires_in: this.options.accessTtlSeconds, scope: grant.scopes.join(' ') };
    if (grant.scopes.includes('offline_access')) {
      const next = token('ort_');
      if (grant.refresh) grant.retired.set(grant.refresh, { next: { access, refresh: next }, at: Date.now() });
      grant.refresh = next;
      grant.rotatedAt = Date.now();
      this.issuedRefreshTokens.push(next);
      out.refresh_token = next;
    }
    return this.json(res, 200, out);
  }

  private codeGrant(form: URLSearchParams, res: ServerResponse): number {
    const c = this.codes.get(form.get('code') ?? '');
    if (!c || c.used || c.clientId !== this.options.clientId || c.redirectUri !== form.get('redirect_uri')) return this.json(res, 400, { error: 'invalid_grant' });
    c.used = true;
    if (sha256b64u(form.get('code_verifier') ?? '') !== c.challenge) return this.json(res, 400, { error: 'invalid_grant' });
    if (form.get('resource') !== c.resource) return this.json(res, 400, { error: 'invalid_target' });
    const grant: Grant = { id: randomUUID(), clientId: c.clientId, userId: this.userId, scopes: c.scopes, revoked: false, refresh: '', rotatedAt: Date.now(), retired: new Map(), access: new Set() };
    this.grants.set(grant.id, grant);
    return this.issue(grant, res);
  }

  private refreshGrant(form: URLSearchParams, res: ServerResponse): number {
    const presented = form.get('refresh_token') ?? '';
    const grant = [...this.grants.values()].find((g) => g.refresh === presented || g.retired.has(presented));
    if (!grant || grant.revoked) return this.json(res, 400, { error: 'invalid_grant' });
    if (form.get('resource') && form.get('resource') !== this.resource) return this.json(res, 400, { error: 'invalid_target' });
    if (grant.refresh !== presented) {
      const old = grant.retired.get(presented)!;
      // A retry of a lost response inside the grace window gets the pair that was issued; anything later is REUSE.
      if (Date.now() - old.at <= this.options.refreshGraceMs) return this.json(res, 200, { access_token: old.next.access, token_type: 'Bearer', expires_in: this.options.accessTtlSeconds, refresh_token: old.next.refresh, scope: grant.scopes.join(' ') });
      grant.revoked = true;
      return this.json(res, 400, { error: 'invalid_grant' });
    }
    return this.issue(grant, res);
  }

  private async revoke(req: IncomingMessage, res: ServerResponse): Promise<number> {
    this.stats.revoke++;
    const form = new URLSearchParams(await this.readBody(req));
    if (!this.clientAuthenticated(req, form)) return this.json(res, 401, { error: 'invalid_client' }, { 'www-authenticate': 'Basic' });
    const t = form.get('token') ?? '';
    for (const g of this.grants.values()) if (g.refresh === t || g.retired.has(t) || g.access.has(t)) g.revoked = true;
    return this.json(res, 200, {});
  }

  // ---- the agent API ----

  private async agent(req: IncomingMessage, res: ServerResponse, url: URL, rec: RecordedRequest): Promise<number> {
    const header = req.headers.authorization ?? '';
    const bearer = header.startsWith('Bearer ') ? header.slice(7) : '';
    const grant = bearer.startsWith('oat_') ? [...this.grants.values()].find((g) => g.access.has(bearer)) : undefined;
    if (!grant || grant.revoked) return this.json(res, 401, { message: 'Unauthorized' }, { 'www-authenticate': 'Bearer' });
    if (!this.options.agentAccess) return this.json(res, 403, { code: 'AGENT_ACCESS_DISABLED', message: 'Agent access is not enabled' });
    if (this.throttle.remaining > 0) {
      this.throttle.remaining--;
      return this.json(res, 429, { code: 'RATE_LIMITED', message: 'Too many requests' }, { 'retry-after': String(this.throttle.retryAfter) });
    }
    const route = url.pathname.slice('/api/agent/v1'.length);
    const need = (scope: string): boolean => grant.scopes.includes(scope);
    const insufficient = () => this.json(res, 403, { message: 'Insufficient scope' }, { 'www-authenticate': 'Bearer error="insufficient_scope"' });
    if (route === '/whoami' && req.method === 'GET') {
      if (!need('vault:items_read')) return insufficient();
      return this.json(res, 200, { data: { userId: grant.userId, scopes: grant.scopes.filter((s) => s !== 'offline_access'), clientId: grant.clientId, contract: { version: '1.2', features: ['logins', 'totp'] } } });
    }
    if (route === '/credentials' && req.method === 'GET') {
      if (!need('vault:items_read')) return insufficient();
      return this.lookup(res, url.searchParams.get('origin') ?? '');
    }
    if (route === '/identity' && req.method === 'GET') {
      if (!need('vault:identity_read')) return insufficient();
      if (!this.identityAccess) return this.json(res, 403, { code: 'IDENTITY_ACCESS_DISABLED', message: 'Identity access is not enabled' });
      // Labels and flags only, as Vault's contract 1.1 lists them: never a value.
      return this.json(res, 200, {
        data: [
          {
            id: '7f1c2e9a-0000-4000-8000-0000000000a1',
            name: 'Passport',
            originAllowed: false,
            fields: [
              { field: 'full_name', label: 'Full name', sensitive: false, fillable: true },
              { field: 'date_of_birth', label: 'Date of birth', sensitive: true, fillable: false },
              { field: 'id_number', label: 'ID number', sensitive: true, fillable: false },
            ],
          },
        ],
      });
    }
    const m = /^\/credentials\/([^/]+)\/(fill|totp)$/.exec(route);
    if (m && req.method === 'POST') {
      if (!need('vault:items_fill')) return insufficient();
      let body: { field?: string; origin?: string; purpose?: string } = {};
      try {
        body = JSON.parse(await this.readBody(req)) as typeof body;
      } catch {
        return this.json(res, 400, { message: 'Invalid body' });
      }
      rec.params = { field: body.field ?? '', origin: body.origin ?? '', purpose: body.purpose ?? '' };
      return m[2] === 'fill' ? this.fill(res, m[1]!, body) : this.totp(res, m[1]!, body);
    }
    return this.json(res, 404, { message: 'Not found' });
  }

  /** Vault's origin normalization: bare host means https; lower-case host; default port, path, query and userinfo dropped; https only (plus http for loopback). */
  static normalizeOrigin(raw: string): string | null {
    try {
      const u = new URL(/^[a-z][a-z0-9+.-]*:\/\//i.test(raw) ? raw : `https://${raw}`);
      const loopback = ['localhost', '127.0.0.1', '[::1]'].includes(u.hostname);
      if (u.protocol !== 'https:' && !(u.protocol === 'http:' && loopback)) return null;
      return u.origin;
    } catch {
      return null;
    }
  }

  private static registrable(origin: string): string {
    return new URL(origin).hostname.split('.').slice(-2).join('.');
  }

  private lookup(res: ServerResponse, rawOrigin: string): number {
    const origin = FakeVault.normalizeOrigin(rawOrigin);
    if (!origin) return this.json(res, 400, { message: 'Invalid origin' });
    const out = this.logins
      .filter((l) => l.open)
      .flatMap((l) => {
        const exact = l.origins.includes(origin);
        const site = !exact && l.origins.some((o) => FakeVault.registrable(o) === FakeVault.registrable(origin));
        return exact || site ? [{ id: l.id, name: l.name, username: l.username, origins: l.origins, matchKind: exact ? 'exact' : 'site', hasTotp: l.totpSeed !== null, updatedAt: '2030-01-02T03:04:05.000Z' }] : [];
      })
      .sort((a, b) => (a.matchKind === b.matchKind ? 0 : a.matchKind === 'exact' ? -1 : 1));
    return this.json(res, 200, { data: out });
  }

  /** The ONE identical 404 of the opt-in rule. */
  private notFound(res: ServerResponse): number {
    return this.json(res, 404, { message: 'Not found' });
  }

  private fill(res: ServerResponse, id: string, body: { field?: string; origin?: string; purpose?: string }): number {
    const login = this.logins.find((l) => l.id === id && l.open);
    if (!login) return this.notFound(res);
    const origin = FakeVault.normalizeOrigin(body.origin ?? '');
    if (!origin || (body.field !== 'username' && body.field !== 'password') || !body.purpose) return this.json(res, 400, { message: 'Invalid body' });
    if (!login.origins.includes(origin)) return this.json(res, 403, { code: 'ORIGIN_MISMATCH', message: 'Origin mismatch' });
    return this.json(res, 200, { data: { value: body.field === 'username' ? login.username : login.password } });
  }

  private totp(res: ServerResponse, id: string, body: { origin?: string; purpose?: string }): number {
    const login = this.logins.find((l) => l.id === id && l.open && l.totpSeed !== null);
    if (!login) return this.notFound(res);
    const origin = FakeVault.normalizeOrigin(body.origin ?? '');
    if (!origin || !body.purpose) return this.json(res, 400, { message: 'Invalid body' });
    if (!login.origins.includes(origin)) return this.json(res, 403, { code: 'ORIGIN_MISMATCH', message: 'Origin mismatch' });
    const period = Math.floor(Date.now() / 30_000);
    const digest = createHmac('sha1', login.totpSeed!).update(String(period)).digest();
    const code = String(digest.readUInt32BE(digest.length - 4) % 1_000_000).padStart(6, '0');
    return this.json(res, 200, { data: { code, expiresAt: new Date((period + 1) * 30_000).toISOString() } });
  }
}

/** Starts a fake Vault on a free loopback port. */
export async function startFakeVault(options: FakeVaultOptions = {}): Promise<FakeVault> {
  return new FakeVault(options).start(options.port ?? 0);
}
