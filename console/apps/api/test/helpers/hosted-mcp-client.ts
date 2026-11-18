// A scripted OAuth MCP client that behaves the way the hosted clients
// (ChatGPT, Claude on the web, desktop and phone, Claude Code) are documented
// to (#468, Part A). It knows only the console's MCP URL: everything else it
// learns from the `401` challenge and the two discovery documents.
//
// One class, five PROFILES (a row of behaviours each, named after what it
// imitates, never after a vendor): how it registers (Client ID Metadata
// Document, Dynamic Client Registration, or a predefined client), where it
// is sent back to (a fixed HTTPS callback or a loopback address on a random
// port), which MCP revision it speaks, and what it reads from `tools/list`.
//
// The root `/.well-known/...` paths are nginx's (infra/nginx/app.d/locations/
// oauth-server.conf): the client applies the same rewrite to reach the API.
// It drives the app in process (Fastify `inject`), so it needs no port.
import { randomInt, randomUUID } from 'node:crypto';
import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import type { PinnedGetRequest, PinnedGetResponse, PinnedGetTransport } from '@marinoscar/platform-api/core';
import { pkcePair } from '@marinoscar/platform-api/identity/testing';

/** The revisions the profiles speak. */
export type HostedProtocol = '2025-06-18' | '2025-11-25' | '2026-07-28';

/** One row of client behaviour (#468, "Profiles"). */
export interface HostedClientProfile {
  /** The profile's name, as the issue's table names it. */
  name: 'hosted-cimd' | 'hosted-dcr' | 'native-loopback' | 'stateless' | 'tool-level-auth';
  /** What it imitates, for the test titles. */
  imitates: string;
  /** How it gets a client identity. */
  registration: 'cimd' | 'dcr' | 'predefined';
  /** A fixed HTTPS callback on its own host, or an RFC 8252 loopback redirect on a port that changes per sign-in. */
  redirect: 'fixed' | 'loopback';
  /** The MCP revision it speaks (2026-07-28: no `initialize`, `server/discover`, the `Mcp-Method`/`Mcp-Name` headers). */
  protocol: HostedProtocol;
  /** The placeholder host it lives on (allowed in the OAuth settings by the test). */
  host: string;
  /** Appends `offline_access` when the authorization server lists it (Claude does, to get a refresh token). */
  appendsOfflineAccess: boolean;
  /** Reads each tool's `securitySchemes` before calling it (ChatGPT's per-tool auth declaration). */
  readsSecuritySchemes: boolean;
  /** Declares the elicitation capability (2026-07-28 only: answers a run's question in its own form). */
  elicitation: boolean;
}

const run = randomUUID().slice(0, 6);

/** The five profiles. Hosts are placeholders (`*.example.test`), never a vendor's. */
export const HOSTED_CLIENT_PROFILES: readonly HostedClientProfile[] = [
  { name: 'hosted-cimd', imitates: 'a hosted assistant with a client metadata document', registration: 'cimd', redirect: 'fixed', protocol: '2025-11-25', host: `assistant-a-${run}.example.test`, appendsOfflineAccess: true, readsSecuritySchemes: false, elicitation: false },
  { name: 'hosted-dcr', imitates: 'a hosted assistant that registers itself on every connection', registration: 'dcr', redirect: 'fixed', protocol: '2025-06-18', host: `assistant-b-${run}.example.test`, appendsOfflineAccess: false, readsSecuritySchemes: false, elicitation: false },
  { name: 'native-loopback', imitates: 'a terminal client signing in through a loopback page', registration: 'cimd', redirect: 'loopback', protocol: '2025-11-25', host: `assistant-c-${run}.example.test`, appendsOfflineAccess: true, readsSecuritySchemes: false, elicitation: false },
  { name: 'stateless', imitates: 'a client on the stateless 2026-07-28 revision with forms', registration: 'cimd', redirect: 'fixed', protocol: '2026-07-28', host: `assistant-d-${run}.example.test`, appendsOfflineAccess: true, readsSecuritySchemes: false, elicitation: true },
  { name: 'tool-level-auth', imitates: 'a hosted assistant that reads per-tool securitySchemes', registration: 'predefined', redirect: 'fixed', protocol: '2025-06-18', host: `assistant-e-${run}.example.test`, appendsOfflineAccess: false, readsSecuritySchemes: true, elicitation: false },
];

/** The `_meta` keys of 2026-07-28 (mirrors `META` in src/mcp/mcp.protocol.ts, read from there by the spec). */
export interface StatelessMetaKeys {
  protocolVersion: string;
  clientInfo: string;
  clientCapabilities: string;
}

/**
 * Serves client metadata documents to the platform's CIMD fetcher in place
 * of the network (the hosted clients publish theirs on their own HTTPS host).
 */
export class StubCimdTransport implements PinnedGetTransport {
  private readonly docs = new Map<string, unknown>();
  /** Every URL the server fetched, in order. */
  readonly fetched: string[] = [];
  set(url: string, document: unknown): void {
    this.docs.set(url, document);
  }
  async get(req: PinnedGetRequest): Promise<PinnedGetResponse> {
    this.fetched.push(req.target.url.href);
    const doc = this.docs.get(req.target.url.href);
    if (!doc) return { status: 404, headers: {}, body: Buffer.alloc(0) };
    return { status: 200, headers: { 'content-type': 'application/json', 'cache-control': 'max-age=300' }, body: Buffer.from(JSON.stringify(doc)) };
  }
}

/** Parses `Bearer a="b", c="d"` (what a client reads from WWW-Authenticate). */
export function parseChallenge(header: unknown): Record<string, string> {
  const out: Record<string, string> = {};
  for (const m of String(header ?? '').matchAll(/([a-z_]+)="([^"]*)"/g)) out[m[1]!] = m[2]!;
  return out;
}

/** What nginx does for the root well-known paths. */
export function apiPathOfWellKnown(url: string): string {
  const path = new URL(url).pathname;
  if (path.startsWith('/.well-known/oauth-protected-resource')) return `/api/oauth/.well-known/protected-resource${path.slice('/.well-known/oauth-protected-resource'.length)}`;
  if (path.startsWith('/.well-known/oauth-authorization-server')) return '/api/oauth/.well-known/authorization-server';
  throw new Error(`not a well-known path: ${path}`);
}

/** One HTTP exchange the client made, with how long the server took. */
export interface Timed {
  kind: 'oauth' | 'tool' | 'mcp';
  what: string;
  ms: number;
  status: number;
}

/** A parsed answer of the MCP endpoint. */
export interface McpAnswer {
  status: number;
  headers: Record<string, unknown>;
  json: any; // eslint-disable-line @typescript-eslint/no-explicit-any
}

/** The tokens the client holds. */
export interface HeldTokens {
  access_token: string;
  refresh_token?: string;
  scope: string;
  expires_in: number;
  token_type: string;
}

/** The two discovery documents, as the client read them. */
export interface Discovered {
  challenge: Record<string, string>;
  prm: Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any
  as: Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any
  issuer: string;
}

/** What the person in front of the consent page does. */
export type Approver = (consent: { scopes: Array<{ id: string; alreadyGranted: boolean; grantable: boolean }>; client: { host: string; name: string }; redirectHost: string; isLoopbackRedirect: boolean }) => string[] | undefined;

export interface HostedClientEnv {
  app: NestFastifyApplication;
  /** The MCP URL the person pasted: the only thing the client is given. */
  mcpUrl: string;
  /** Serves CIMD documents (profiles that use one). */
  cimd: StubCimdTransport;
  /** The signed-in person's console session (the consent routes take only a session). */
  session: () => string;
  /** `_meta` keys of the stateless revision. */
  meta: StatelessMetaKeys;
  /** A predefined client (the `predefined` registration): what an administrator created. */
  predefined?: { clientId: string; redirectUri: string };
  /** Everything secret the client handled, for the egress check. */
  secrets?: string[];
}

/**
 * A scripted MCP client following one profile. It keeps what a real client
 * keeps between calls (the discovery, its client id, its tokens) and records
 * the time of every exchange.
 */
export class HostedMcpClient {
  readonly timings: Timed[] = [];
  /** Every client_id registration returned (DCR registers on every connection). */
  readonly registeredIds: string[] = [];
  /** The redirect URIs it sent, in order. */
  readonly redirectsSent: string[] = [];
  found?: Discovered;
  clientId?: string;
  tokens?: HeldTokens;
  private nextId = 1;

  constructor(
    readonly profile: HostedClientProfile,
    private readonly env: HostedClientEnv,
  ) {}

  private async timed<T extends { statusCode: number }>(kind: Timed['kind'], what: string, work: () => Promise<T>): Promise<T> {
    const t0 = performance.now();
    const res = await work();
    this.timings.push({ kind, what, ms: performance.now() - t0, status: res.statusCode });
    return res;
  }

  private keep(...values: Array<string | undefined>) {
    for (const v of values) if (v) this.env.secrets?.push(v);
  }

  private get http() {
    return this.env.app;
  }

  // --- MCP ---------------------------------------------------------------------------------

  /** One JSON-RPC request the way this profile sends it, with the token it holds (or `null` for none). */
  async rpc(method: string, params: Record<string, unknown> = {}, opts: { token?: string | null } = {}): Promise<McpAnswer> {
    const token = opts.token === undefined ? this.tokens?.access_token : opts.token;
    const p = this.profile;
    const headers: Record<string, string> = { 'content-type': 'application/json', accept: 'application/json, text/event-stream', 'mcp-protocol-version': p.protocol };
    if (token) headers.authorization = `Bearer ${token}`;
    let body: Record<string, unknown>;
    const id = this.nextId++;
    if (p.protocol === '2026-07-28') {
      const caps = p.elicitation ? { elicitation: {} } : {};
      body = { jsonrpc: '2.0', id, method, params: { ...params, _meta: { [this.env.meta.protocolVersion]: p.protocol, [this.env.meta.clientInfo]: { name: `scripted-${p.name}`, version: '1.0' }, [this.env.meta.clientCapabilities]: caps } } };
      headers['mcp-method'] = method;
      if (typeof params.name === 'string') headers['mcp-name'] = params.name;
      else if (typeof params.uri === 'string') headers['mcp-name'] = params.uri;
    } else {
      body = { jsonrpc: '2.0', id, method, ...(Object.keys(params).length ? { params } : {}) };
    }
    const kind: Timed['kind'] = method === 'tools/call' ? 'tool' : 'mcp';
    const res = await this.timed(kind, method === 'tools/call' ? `tools/call ${String(params.name)}` : method, () =>
      this.http.inject({ method: 'POST', url: new URL(this.env.mcpUrl).pathname, headers, payload: JSON.stringify(body) }),
    );
    return { status: res.statusCode, headers: res.headers as Record<string, unknown>, json: res.body ? JSON.parse(res.body) : null };
  }

  /** The opening request: `initialize` (and `notifications/initialized`) on a handshake revision, `server/discover` on 2026-07-28. */
  async open(opts: { token?: string | null } = {}): Promise<McpAnswer> {
    if (this.profile.protocol === '2026-07-28') return this.rpc('server/discover', {}, opts);
    const init = await this.rpc('initialize', { protocolVersion: this.profile.protocol, capabilities: {}, clientInfo: { name: `scripted-${this.profile.name}`, version: '1.0' } }, opts);
    if (init.status === 200) await this.http.inject({ method: 'POST', url: new URL(this.env.mcpUrl).pathname, headers: { authorization: `Bearer ${this.tokens?.access_token}`, 'content-type': 'application/json', 'mcp-protocol-version': this.profile.protocol }, payload: JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }) });
    return init;
  }

  /** A `tools/call`; on 2026-07-28 it can carry the answers to an `input_required` result. */
  callTool(name: string, args: Record<string, unknown>, extra: { inputResponses?: unknown; requestState?: string } = {}): Promise<McpAnswer> {
    return this.rpc('tools/call', { name, arguments: args, ...(extra.inputResponses !== undefined ? { inputResponses: extra.inputResponses } : {}), ...(extra.requestState !== undefined ? { requestState: extra.requestState } : {}) });
  }

  // --- OAuth -------------------------------------------------------------------------------

  /** Step 1: the unauthenticated request, its challenge, then both discovery documents. */
  async discover(): Promise<Discovered> {
    const unauthorized = await this.open({ token: null });
    if (unauthorized.status !== 401) throw new Error(`expected 401 without a token, got ${unauthorized.status}`);
    const challenge = parseChallenge(unauthorized.headers['www-authenticate']);
    if (!String(unauthorized.headers['www-authenticate']).startsWith('Bearer ')) throw new Error('no Bearer challenge');
    const prmRes = await this.timed('oauth', 'protected resource metadata', () => this.http.inject({ method: 'GET', url: apiPathOfWellKnown(challenge.resource_metadata!) }));
    if (prmRes.statusCode !== 200) throw new Error(`protected resource metadata: ${prmRes.statusCode}`);
    const prm = prmRes.json();
    // Hosted clients use only the first authorization server and never fall back.
    const issuer: string = prm.authorization_servers[0];
    const asRes = await this.timed('oauth', 'authorization server metadata', () => this.http.inject({ method: 'GET', url: apiPathOfWellKnown(`${issuer}/.well-known/oauth-authorization-server`) }));
    if (asRes.statusCode !== 200) throw new Error(`authorization server metadata: ${asRes.statusCode}`);
    this.found = { challenge, prm, as: asRes.json(), issuer };
    return this.found;
  }

  /** The client_id document this profile publishes (a CIMD profile). */
  get metadataUrl(): string {
    return `https://${this.profile.host}/oauth/client-metadata.json`;
  }

  /** A fixed HTTPS callback, or a loopback one on a fresh random port (`localhost` when asked). */
  redirectUri(loopbackName: '127.0.0.1' | 'localhost' = '127.0.0.1'): string {
    if (this.profile.redirect === 'fixed') return this.profile.registration === 'predefined' ? this.env.predefined!.redirectUri : `https://${this.profile.host}/oauth/callback`;
    return `http://${loopbackName}:${randomInt(20_000, 60_000)}/callback`;
  }

  /** Gets a client identity the way the profile does. DCR registers again on every connection. */
  async identify(): Promise<string> {
    const p = this.profile;
    const found = this.found!;
    if (p.registration === 'predefined') {
      this.clientId = this.env.predefined!.clientId;
    } else if (p.registration === 'cimd') {
      const doc: Record<string, unknown> = {
        client_id: this.metadataUrl,
        client_name: `Scripted ${p.name}`,
        client_uri: `https://${p.host}/`,
        redirect_uris: p.redirect === 'loopback' ? ['http://127.0.0.1/callback', 'http://localhost/callback'] : [`https://${p.host}/oauth/callback`],
        grant_types: ['authorization_code', 'refresh_token'],
        response_types: ['code'],
        token_endpoint_auth_method: 'none',
        ...(p.redirect === 'loopback' ? { application_type: 'native' } : {}),
      };
      this.env.cimd.set(this.metadataUrl, doc);
      this.clientId = this.metadataUrl;
    } else {
      const res = await this.timed('oauth', 'registration', () =>
        this.http.inject({
          method: 'POST',
          url: new URL(found.as.registration_endpoint).pathname,
          headers: { 'content-type': 'application/json' },
          payload: JSON.stringify({ client_name: `Scripted ${p.name}`, redirect_uris: [`https://${p.host}/oauth/callback`], grant_types: ['authorization_code', 'refresh_token'], response_types: ['code'], token_endpoint_auth_method: 'none' }),
        }),
      );
      if (res.statusCode !== 201 && res.statusCode !== 200) throw new Error(`registration: ${res.statusCode} ${res.body}`);
      this.clientId = res.json().client_id as string;
      this.registeredIds.push(this.clientId);
    }
    return this.clientId!;
  }

  /** The scopes it asks for: the challenge's, else the resource's `scopes_supported`; plus `offline_access` when the profile appends it. */
  requestedScopes(explicit?: string): string {
    const found = this.found!;
    const base = (explicit ?? found.challenge.scope ?? (found.prm.scopes_supported as string[]).filter((s) => s !== 'offline_access').join(' ')).split(' ').filter(Boolean);
    const wantsOffline = this.profile.appendsOfflineAccess && (found.as.scopes_supported as string[]).includes('offline_access');
    return [...new Set([...base, ...(wantsOffline ? ['offline_access'] : [])])].join(' ');
  }

  /**
   * Step 2: authorize with PKCE, `state` and `resource`; the person approves
   * on the consent page (`approve` picks the boxes); verify `state` and
   * `iss`; exchange the code with a form body.
   */
  async authorize(scope: string, approve: Approver, opts: { loopbackName?: '127.0.0.1' | 'localhost' } = {}): Promise<{ tokens: HeldTokens; consent: Parameters<Approver>[0] }> {
    const found = this.found!;
    if (this.profile.registration === 'dcr' || !this.clientId) await this.identify();
    const pkce = pkcePair();
    const state = `st-${randomUUID().slice(0, 12)}`;
    const redirectUri = this.redirectUri(opts.loopbackName);
    this.redirectsSent.push(redirectUri);
    const query = new URLSearchParams({ response_type: 'code', client_id: this.clientId!, redirect_uri: redirectUri, state, code_challenge: pkce.challenge, code_challenge_method: 'S256', resource: found.prm.resource, scope });
    const authorized = await this.timed('oauth', 'authorize', () => this.http.inject({ method: 'GET', url: `${new URL(found.as.authorization_endpoint).pathname}?${query}` }));
    if (authorized.statusCode !== 302) throw new Error(`authorize: ${authorized.statusCode} ${authorized.body}`);
    const consentUrl = new URL(String(authorized.headers.location));
    const requestId = consentUrl.searchParams.get('request');
    if (!requestId) throw new Error(`authorize did not send the person to consent: ${consentUrl.href}`);

    // The person's browser, signed in to the console.
    const auth = { authorization: `Bearer ${this.env.session()}` };
    const consentRes = await this.timed('oauth', 'consent read', () => this.http.inject({ method: 'GET', url: `/api/oauth/requests/${requestId}`, headers: auth }));
    if (consentRes.statusCode !== 200) throw new Error(`consent read: ${consentRes.statusCode}`);
    const consent = consentRes.json().data as Parameters<Approver>[0];
    const scopes = approve(consent);
    const decision = await this.timed('oauth', 'consent decision', () =>
      this.http.inject({ method: 'POST', url: `/api/oauth/requests/${requestId}/decision`, headers: { ...auth, 'content-type': 'application/json' }, payload: JSON.stringify({ decision: 'approve', ...(scopes ? { scopes } : {}) }) }),
    );
    if (decision.statusCode !== 200) throw new Error(`decision: ${decision.statusCode} ${decision.body}`);
    const back = new URL(decision.json().data.redirectTo);
    if (`${back.origin}${back.pathname}` !== new URL(redirectUri).origin + new URL(redirectUri).pathname) throw new Error(`redirected to ${back.href}, sent ${redirectUri}`);
    if (back.searchParams.get('state') !== state) throw new Error('state does not match');
    if (back.searchParams.get('iss') !== found.issuer) throw new Error(`iss ${back.searchParams.get('iss')} is not ${found.issuer}`);
    const code = back.searchParams.get('code')!;

    const token = await this.tokenRequest('code exchange', { grant_type: 'authorization_code', code, redirect_uri: redirectUri, code_verifier: pkce.verifier });
    if (token.status !== 200) throw new Error(`token: ${token.status} ${JSON.stringify(token.body)}`);
    this.tokens = token.body as unknown as HeldTokens;
    this.keep(code, pkce.verifier, this.tokens.access_token, this.tokens.refresh_token);
    return { tokens: this.tokens, consent };
  }

  /** A token endpoint request with a form body (public client: `client_id` only). */
  async tokenRequest(what: string, form: Record<string, string>): Promise<{ status: number; body: Record<string, unknown> }> {
    const res = await this.timed('oauth', what, () =>
      this.http.inject({ method: 'POST', url: new URL(this.found!.as.token_endpoint).pathname, headers: { 'content-type': 'application/x-www-form-urlencoded' }, payload: new URLSearchParams({ client_id: this.clientId!, ...form }).toString() }),
    );
    return { status: res.statusCode, body: res.body ? (JSON.parse(res.body) as Record<string, unknown>) : {} };
  }

  /** A refresh with the held refresh token (or `refreshToken`); keeps the new pair on success. */
  async refresh(refreshToken = this.tokens?.refresh_token): Promise<{ status: number; body: Record<string, unknown> }> {
    if (!refreshToken) throw new Error('no refresh token held');
    const r = await this.tokenRequest('refresh', { grant_type: 'refresh_token', refresh_token: refreshToken });
    if (r.status === 200) {
      this.tokens = r.body as unknown as HeldTokens;
      this.keep(this.tokens.access_token, this.tokens.refresh_token);
    }
    return r;
  }
}
