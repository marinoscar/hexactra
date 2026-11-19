// An in-process MCP server over Streamable HTTP for the specs of E39.9 (#606): a real HTTP server on a loopback port (the console's own
// outbound transport allows loopback outside production), speaking enough of the protocol to test a client, and recording every request it
// receives so a spec can assert what left the console. Invented data only.
import { createHash } from 'node:crypto';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';

export interface FakeTool {
  name: string;
  title?: string;
  description?: string;
  inputSchema?: Record<string, unknown>;
  annotations?: Record<string, unknown>;
}

export interface Received {
  method: string;
  headers: Record<string, string | string[] | undefined>;
  /** The JSON-RPC body, or null for a request with none (DELETE). */
  body: { jsonrpc?: string; id?: unknown; method?: string; params?: Record<string, unknown>; result?: unknown; error?: { code?: number } } | null;
}

export interface FakeMcpOptions {
  /** The revisions it speaks, newest first. Default `['2025-11-25', '2025-06-18', '2025-03-26']`. */
  versions?: string[];
  tools?: FakeTool[];
  /** Tools per `tools/list` page (default: all). */
  pageSize?: number;
  /** Answer with `text/event-stream` instead of JSON. */
  sse?: boolean;
  /** Issue an `Mcp-Session-Id` on initialize and require it afterwards. */
  session?: boolean;
  /** A bearer token every request must carry (else 401 with a `WWW-Authenticate` challenge). */
  bearer?: string;
  /** A custom header every request must carry. */
  header?: { name: string; value: string };
  /** Delay every `tools/call` answer. */
  callDelayMs?: number;
  /** What `tools/call` returns, by tool name; the default echoes the arguments as text. */
  results?: Record<string, (args: Record<string, unknown>) => { content: unknown[]; structuredContent?: unknown; isError?: boolean }>;
  /** Send these server-to-client requests in the stream of a `tools/call` before its result (sampling, elicitation, roots). */
  serverRequests?: { method: string; params?: unknown }[];
  /** Answer every `tools/call` with this HTTP status instead of a result (a server that fails in the middle). */
  callStatus?: number;
  /** Answer every POST with this redirect. */
  redirectTo?: string;
  /** Answer `initialize` with this server name. */
  serverName?: string;
  /** Act as its own OAuth authorization server too (metadata, dynamic registration, token, revocation); the MCP endpoint then needs its access token. */
  oauth?: { registration?: boolean; issuerInResponse?: boolean };
}

/** What the fake authorization server issued: every value carries a marker so a spec can scan for a leak. */
export interface IssuedToken {
  access: string;
  refresh: string;
}

export class FakeMcpServer {
  readonly received: Received[] = [];
  tools: FakeTool[];
  private server!: Server;
  private sessions = 0;
  url = '';
  /** OAuth: the clients registered, the codes issued (with the PKCE challenge and redirect they were bound to), and the live tokens. */
  readonly registered: Record<string, unknown>[] = [];
  readonly revoked: string[] = [];
  private readonly codes = new Map<string, { challenge: string; redirect: string; resource: string | null }>();
  private readonly accessTokens = new Set<string>();
  private readonly refreshTokens = new Map<string, string>();
  private issuedCount = 0;
  /** The token requests received (form fields), in order. */
  readonly tokenRequests: Record<string, string>[] = [];
  /** The tokens the last token request issued. */
  lastIssued: IssuedToken | null = null;

  constructor(readonly opts: FakeMcpOptions = {}) {
    this.tools = opts.tools ?? [];
  }

  async start(): Promise<this> {
    this.server = createServer((req, res) => void this.handle(req, res));
    await new Promise<void>((r) => this.server.listen(0, '127.0.0.1', r));
    this.url = `http://127.0.0.1:${(this.server.address() as AddressInfo).port}/mcp`;
    return this;
  }

  async stop(): Promise<void> {
    this.server.closeAllConnections();
    await new Promise<void>((r) => this.server.close(() => r()));
  }

  get origin(): string {
    return new URL(this.url).origin;
  }

  /** The browser's side of the consent: validates what the authorize URL asked for and returns the `code` and `state` to hand back. */
  consent(authorizeUrl: string): { code: string; state: string; redirectUri: string; iss: string } {
    const u = new URL(authorizeUrl);
    const q = u.searchParams;
    if (q.get('response_type') !== 'code' || q.get('code_challenge_method') !== 'S256') throw new Error('not an authorization code request with PKCE');
    const code = `MARKER-code-${++this.issuedCount}`;
    this.codes.set(code, { challenge: q.get('code_challenge')!, redirect: q.get('redirect_uri')!, resource: q.get('resource') });
    return { code, state: q.get('state')!, redirectUri: q.get('redirect_uri')!, iss: this.origin };
  }

  /** Makes an access token the server issued stop working (the owner revoked it, or it expired there). */
  expireAccess(token: string): void {
    this.accessTokens.delete(token);
  }

  private issue(): IssuedToken {
    const n = ++this.issuedCount;
    const t = { access: `MARKER-access-${n}-${'a'.repeat(24)}`, refresh: `MARKER-refresh-${n}-${'r'.repeat(24)}` };
    this.accessTokens.add(t.access);
    this.refreshTokens.set(t.refresh, 'live');
    this.lastIssued = t;
    return t;
  }

  private async oauthRoute(req: IncomingMessage, res: ServerResponse, raw: string): Promise<boolean> {
    const path = new URL(req.url ?? '/', this.origin).pathname;
    const json = (status: number, v: unknown) => void res.writeHead(status, { 'content-type': 'application/json' }).end(JSON.stringify(v));
    if (path.startsWith('/.well-known/oauth-protected-resource')) return json(200, { resource: this.url, authorization_servers: [this.origin], scopes_supported: ['notes.read', 'notes.write'] }), true;
    if (path === '/.well-known/oauth-authorization-server') {
      return json(200, {
        issuer: this.origin,
        authorization_endpoint: `${this.origin}/authorize`,
        token_endpoint: `${this.origin}/token`,
        revocation_endpoint: `${this.origin}/revoke`,
        ...(this.opts.oauth?.registration === false ? {} : { registration_endpoint: `${this.origin}/register` }),
        code_challenge_methods_supported: ['S256'],
        authorization_response_iss_parameter_supported: this.opts.oauth?.issuerInResponse === true,
      }), true;
    }
    if (path === '/register' && req.method === 'POST') {
      this.registered.push(JSON.parse(raw) as Record<string, unknown>);
      return json(201, { client_id: `fake-client-${this.registered.length}` }), true;
    }
    if (path === '/revoke' && req.method === 'POST') {
      this.revoked.push(new URLSearchParams(raw).get('token') ?? '');
      return json(200, {}), true;
    }
    if (path === '/token' && req.method === 'POST') {
      const f = Object.fromEntries(new URLSearchParams(raw)) as Record<string, string>;
      this.tokenRequests.push(f);
      if (f.grant_type === 'authorization_code') {
        const c = this.codes.get(f.code ?? '');
        this.codes.delete(f.code ?? '');
        const ok = c && c.redirect === f.redirect_uri && c.challenge === createHash('sha256').update(f.code_verifier ?? '', 'ascii').digest('base64url') && c.resource === (f.resource ?? null);
        if (!ok) return json(400, { error: 'invalid_grant' }), true;
        const t = this.issue();
        return json(200, { access_token: t.access, refresh_token: t.refresh, expires_in: 3600, token_type: 'Bearer' }), true;
      }
      if (f.grant_type === 'refresh_token') {
        if (this.refreshTokens.get(f.refresh_token ?? '') !== 'live') return json(400, { error: 'invalid_grant' }), true;
        this.refreshTokens.set(f.refresh_token!, 'retired');
        const t = this.issue();
        return json(200, { access_token: t.access, refresh_token: t.refresh, expires_in: 3600, token_type: 'Bearer' }), true;
      }
      return json(400, { error: 'unsupported_grant_type' }), true;
    }
    return false;
  }

  get host(): string {
    return new URL(this.url).host;
  }

  /** The `tools/call` requests received, in order. */
  calls(): Received[] {
    return this.received.filter((r) => r.body?.method === 'tools/call');
  }

  /** The error responses the client sent to this server's own requests. */
  clientErrors(): Received[] {
    return this.received.filter((r) => r.body?.error !== undefined);
  }

  /** Everything received as one string: a spec searches it for a marker that must never have left the console. */
  transcript(): string {
    return JSON.stringify(this.received.map((r) => ({ headers: r.headers, body: r.body })));
  }

  private async handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const chunks: Buffer[] = [];
    for await (const c of req) chunks.push(c as Buffer);
    const raw = Buffer.concat(chunks).toString('utf8');
    let body: Received['body'] = null;
    try {
      body = raw ? JSON.parse(raw) : null;
    } catch {
      body = null;
    }
    this.received.push({ method: req.method ?? '', headers: req.headers, body });
    if (this.opts.oauth && (await this.oauthRoute(req, res, raw))) return;
    if (this.opts.redirectTo) {
      res.writeHead(307, { location: this.opts.redirectTo }).end();
      return;
    }
    if (this.opts.oauth && !this.accessTokens.has(String(req.headers.authorization ?? '').replace(/^Bearer /, ''))) return void res.writeHead(401, { 'www-authenticate': `Bearer resource_metadata="${this.origin}/.well-known/oauth-protected-resource"` }).end();
    if (this.opts.bearer && req.headers.authorization !== `Bearer ${this.opts.bearer}`) return void res.writeHead(401, { 'www-authenticate': 'Bearer resource_metadata="https://mcp.example.test/.well-known/oauth-protected-resource"' }).end();
    if (this.opts.header && req.headers[this.opts.header.name.toLowerCase()] !== this.opts.header.value) return void res.writeHead(401).end();
    if (req.method === 'DELETE') return void res.writeHead(200).end();
    if (!body) return void res.writeHead(400).end();
    // A response to one of this server's own requests (the client's refusal): acknowledged.
    if (!body.method) return void res.writeHead(202).end();
    const reply = (message: unknown, headers: Record<string, string> = {}) => {
      if (this.opts.sse) res.writeHead(200, { 'content-type': 'text/event-stream', ...headers }).end(`event: message\ndata: ${JSON.stringify(message)}\n\n`);
      else res.writeHead(200, { 'content-type': 'application/json', ...headers }).end(JSON.stringify(message));
    };
    const ok = (result: unknown, headers?: Record<string, string>) => reply({ jsonrpc: '2.0', id: body!.id, result }, headers);
    switch (body.method) {
      case 'initialize': {
        const versions = this.opts.versions ?? ['2025-11-25', '2025-06-18', '2025-03-26'];
        const asked = String(body.params?.protocolVersion ?? '');
        const version = versions.includes(asked) ? asked : versions[0]!;
        const headers = this.opts.session ? { 'mcp-session-id': `session-${++this.sessions}` } : undefined;
        return ok({ protocolVersion: version, capabilities: { tools: { listChanged: false } }, serverInfo: { name: this.opts.serverName ?? 'Fake Notes Server', version: '1.0.0' } }, headers);
      }
      case 'notifications/initialized':
        return void res.writeHead(202).end();
      case 'tools/list': {
        const cursor = typeof body.params?.cursor === 'string' ? Number(body.params.cursor) : 0;
        const size = this.opts.pageSize ?? this.tools.length;
        const page = this.tools.slice(cursor, cursor + size).map((t) => ({ inputSchema: { type: 'object', properties: {} }, ...t }));
        return ok({ tools: page, ...(cursor + size < this.tools.length ? { nextCursor: String(cursor + size) } : {}) });
      }
      case 'tools/call': {
        const name = String(body.params?.name ?? '');
        const args = (body.params?.arguments ?? {}) as Record<string, unknown>;
        if (this.opts.callStatus) return void res.writeHead(this.opts.callStatus).end();
        if (this.opts.callDelayMs) await new Promise((r) => setTimeout(r, this.opts.callDelayMs).unref());
        if (!this.tools.some((t) => t.name === name)) return reply({ jsonrpc: '2.0', id: body.id, error: { code: -32602, message: `Unknown tool ${name}` } });
        const result = (this.opts.results?.[name] ?? ((a: Record<string, unknown>) => ({ content: [{ type: 'text', text: `ok ${name} ${JSON.stringify(a)}` }] })))(args);
        if (this.opts.serverRequests?.length) {
          const events = this.opts.serverRequests.map((r, i) => `event: message\ndata: ${JSON.stringify({ jsonrpc: '2.0', id: `srv-${i + 1}`, method: r.method, params: r.params ?? {} })}\n\n`);
          events.push(`event: message\ndata: ${JSON.stringify({ jsonrpc: '2.0', id: body.id, result })}\n\n`);
          return void res.writeHead(200, { 'content-type': 'text/event-stream' }).end(events.join(''));
        }
        return ok(result);
      }
      default:
        if (body.id === undefined) return void res.writeHead(202).end();
        return reply({ jsonrpc: '2.0', id: body.id, error: { code: -32601, message: 'Method not found' } });
    }
  }
}
