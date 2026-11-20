// A small MCP CLIENT over the Streamable HTTP transport (E39.9, #606). The choice is recorded in docs/connections.md ("MCP servers"): a
// small client over the console's own protocol code and `OutboundHttp`, not the official SDK. Reasons: every request must go through the
// SSRF-guarded, address-pinned, never-redirecting transport, which the SDK's own `fetch` does not use; the console needs five JSON-RPC
// methods and refuses everything else; and it adds no dependency to the API image.
//
// What it does: `initialize` (asking for the newest revision it speaks, accepting any it speaks, retrying once on the server's own list),
// `notifications/initialized`, `tools/list` with paging, `tools/call`, and closing the session. Every request has a deadline, a response
// size cap and the caller's AbortSignal.
//
// What it never does: it declares NO client capability (no sampling, no elicitation, no roots), so a server that asks anyway gets a
// JSON-RPC "method not found" and nothing else happens; it never follows a redirect; it never starts a process; it never sends anything
// but what the caller passes (the caller redacts).
import { OutboundHttpError, type OutboundHttp } from '../../oauth-client';
import { MCP_CALL_TIMEOUT_MS, MCP_CLIENT_NAME, MCP_CLIENT_VERSIONS, MCP_MAX_LIST_PAGES, MCP_MAX_RESPONSE_BYTES, MCP_MAX_TOOLS } from './mcp.constants';
import { sanitizeInstructions, sanitizeServerMessage } from './mcp-text';
import { toDescriptor, type McpToolDescriptor } from './mcp-tools';
import { McpUrlError, type McpUrlRefusal } from './mcp-url';

export type McpClientErrorKind =
  /** The address (or the administrator's lists) refused it: `urlCode` says which. */
  | 'url_refused'
  /** 401: the server wants a sign-in, or the one given is no longer good. */
  | 'auth'
  /** 403. */
  | 'forbidden'
  /** The server or the network could not be reached, or answered 429 or 5xx. */
  | 'unavailable'
  | 'timeout'
  /** The server did not speak the protocol this client speaks. */
  | 'protocol'
  | 'too_large'
  | 'aborted'
  /** A redirect: never followed. */
  | 'redirect'
  /** The server answered the request with a JSON-RPC error. */
  | 'rpc';

/** A failed exchange with a server. `message` is static; `serverMessage` is the server's own text, cleaned and capped (it is data). */
export class McpClientError extends Error {
  constructor(
    readonly kind: McpClientErrorKind,
    message: string,
    readonly extra: { status?: number; rpcCode?: number; urlCode?: McpUrlRefusal; wwwAuthenticate?: string; serverMessage?: string } = {},
  ) {
    super(message);
    this.name = 'McpClientError';
  }
}

export interface McpClientOptions {
  http: OutboundHttp;
  url: string;
  /** Runs before EVERY request: the administrator's lists and the switch (throw `McpUrlError` or `McpClientError`), then the sign-in headers. */
  prepare(): Promise<Record<string, string>>;
  /** The most the whole exchange (initialise, call, close) may take. Default 30 s. */
  timeoutMs?: number;
  maxBytes?: number;
  signal?: AbortSignal;
  /** Sent as `clientInfo.version`. */
  clientVersion?: string;
}

export interface McpServerInfo {
  name: string | null;
  version: string | null;
  /** What the server says it is for (`initialize`'s `instructions`, E41.2), cleaned and capped; null when it gave none. */
  instructions: string | null;
}

/** A `tools/call` result as the server sent it, checked only for its shape. */
export interface McpCallResult {
  content: unknown[];
  structuredContent?: unknown;
  isError: boolean;
}

interface RpcMessage {
  jsonrpc?: string;
  id?: string | number | null;
  method?: string;
  params?: unknown;
  result?: unknown;
  error?: { code?: number; message?: string; data?: unknown };
}

const isRecord = (v: unknown): v is Record<string, unknown> => v !== null && typeof v === 'object' && !Array.isArray(v);

/** The JSON-RPC messages in a response body: one JSON value, an array of them, or a `text/event-stream` of `data:` events. */
export function parseMessages(contentType: string, body: string): RpcMessage[] {
  const out: RpcMessage[] = [];
  const take = (v: unknown) => {
    for (const m of Array.isArray(v) ? v : [v]) if (isRecord(m)) out.push(m as RpcMessage);
  };
  if (/text\/event-stream/i.test(contentType)) {
    for (const event of body.split(/\r?\n\r?\n/)) {
      const data = event
        .split(/\r?\n/)
        .filter((l) => l.startsWith('data:'))
        .map((l) => l.slice(5).replace(/^ /, ''))
        .join('\n');
      if (!data) continue;
      try {
        take(JSON.parse(data));
      } catch {
        // An event that is not JSON is ignored.
      }
    }
    return out;
  }
  try {
    take(JSON.parse(body));
  } catch {
    throw new McpClientError('protocol', 'The server did not answer in the protocol.');
  }
  return out;
}

export class McpClient {
  private nextId = 1;
  private sessionId: string | null = null;
  private version: string | null = null;
  private readonly deadline: number;
  private info: McpServerInfo = { name: null, version: null, instructions: null };
  /** How many requests the server made of this client that were refused (a well-behaved server makes none). */
  refusedServerRequests = 0;

  private constructor(private readonly o: McpClientOptions) {
    this.deadline = Date.now() + (o.timeoutMs ?? MCP_CALL_TIMEOUT_MS);
  }

  /** Opens a session: `initialize`, then `notifications/initialized`. */
  static async connect(options: McpClientOptions): Promise<McpClient> {
    const c = new McpClient(options);
    await c.initialize();
    return c;
  }

  get protocolVersion(): string | null {
    return this.version;
  }

  get serverInfo(): McpServerInfo {
    return this.info;
  }

  // ---- the methods ----

  /** Every tool the server lists, following the pages (at most 20) and keeping at most 500 usable entries. Entries that are not tools are skipped. */
  async listTools(): Promise<{ tools: McpToolDescriptor[]; skipped: number }> {
    const tools: McpToolDescriptor[] = [];
    let skipped = 0;
    let cursor: string | undefined;
    for (let page = 0; page < MCP_MAX_LIST_PAGES; page += 1) {
      const result = await this.request('tools/list', cursor ? { cursor } : {});
      const list = isRecord(result) && Array.isArray(result.tools) ? result.tools : null;
      if (!list) throw new McpClientError('protocol', 'The server did not answer tools/list in the protocol.');
      for (const raw of list) {
        const d = toDescriptor(raw);
        if (d) tools.push(d);
        else skipped += 1;
      }
      cursor = isRecord(result) && typeof result.nextCursor === 'string' && result.nextCursor ? result.nextCursor : undefined;
      if (!cursor || tools.length >= MCP_MAX_TOOLS) break;
    }
    return { tools: tools.slice(0, MCP_MAX_TOOLS), skipped: skipped + Math.max(0, tools.length - MCP_MAX_TOOLS) };
  }

  async callTool(name: string, args: Record<string, unknown>): Promise<McpCallResult> {
    const result = await this.request('tools/call', { name, arguments: args });
    if (!isRecord(result) || !Array.isArray(result.content)) throw new McpClientError('protocol', 'The server did not answer tools/call in the protocol.');
    return { content: result.content, ...(result.structuredContent !== undefined ? { structuredContent: result.structuredContent } : {}), isError: result.isError === true };
  }

  /** Ends the session (best effort: a server that does not support it, or does not answer, is not an error). */
  async close(): Promise<void> {
    if (!this.sessionId) return;
    try {
      await this.send('DELETE', undefined, 5_000);
    } catch {
      // Closing is courtesy.
    }
    this.sessionId = null;
  }

  // ---- the session ----

  private async initialize(): Promise<void> {
    let asked: string = MCP_CLIENT_VERSIONS[0];
    for (let attempt = 0; attempt < 2; attempt += 1) {
      const res = await this.exchange({ jsonrpc: '2.0', id: this.nextId++, method: 'initialize', params: { protocolVersion: asked, capabilities: {}, clientInfo: { name: MCP_CLIENT_NAME, version: this.o.clientVersion ?? '1' } } });
      if (res.message.error) {
        // A server that does not speak the revision asked for may list the ones it does: retry once on the newest of those we speak.
        const supported = isRecord(res.message.error.data) && Array.isArray(res.message.error.data.supported) ? res.message.error.data.supported : [];
        const common = MCP_CLIENT_VERSIONS.find((v) => supported.includes(v));
        if (attempt === 0 && common && common !== asked) {
          asked = common;
          continue;
        }
        throw this.rpcError(res.message.error);
      }
      const result = res.message.result;
      const version = isRecord(result) && typeof result.protocolVersion === 'string' ? result.protocolVersion : null;
      if (!version || !(MCP_CLIENT_VERSIONS as readonly string[]).includes(version)) throw new McpClientError('protocol', 'The server speaks no revision of the protocol this console speaks.');
      this.version = version;
      this.sessionId = res.headers['mcp-session-id'] ?? null;
      const si = isRecord(result) && isRecord(result.serverInfo) ? result.serverInfo : null;
      const instructions = isRecord(result) && typeof result.instructions === 'string' ? sanitizeInstructions(result.instructions) || null : null;
      this.info = { name: typeof si?.name === 'string' ? sanitizeServerMessage(si.name).slice(0, 200) || null : null, version: typeof si?.version === 'string' ? sanitizeServerMessage(si.version).slice(0, 100) || null : null, instructions };
      await this.send('POST', { jsonrpc: '2.0', method: 'notifications/initialized' });
      return;
    }
  }

  /** One request and its result; a JSON-RPC error is thrown as `rpc`. */
  private async request(method: string, params: unknown): Promise<unknown> {
    const res = await this.exchange({ jsonrpc: '2.0', id: this.nextId++, method, params });
    if (res.message.error) throw this.rpcError(res.message.error);
    return res.message.result;
  }

  private rpcError(e: NonNullable<RpcMessage['error']>): McpClientError {
    return new McpClientError('rpc', 'The server answered with an error.', { rpcCode: typeof e.code === 'number' ? e.code : undefined, serverMessage: sanitizeServerMessage(e.message) });
  }

  /** POSTs one request and finds its response among the messages. A request the SERVER makes in the same stream is refused (after the stream ends). */
  private async exchange(body: { id: number } & Record<string, unknown>): Promise<{ message: RpcMessage; headers: Record<string, string> }> {
    const res = await this.send('POST', body);
    const messages = parseMessages(res.headers['content-type'] ?? '', res.body);
    const refuse = messages.filter((m) => typeof m.method === 'string' && m.id !== undefined && m.id !== null);
    const found = messages.find((m) => m.id === body.id && typeof m.method !== 'string' && (m.result !== undefined || m.error !== undefined));
    // Sampling, elicitation and roots: no client capability was declared, so each is answered "method not found" and nothing is done.
    for (const m of refuse) {
      this.refusedServerRequests += 1;
      try {
        await this.send('POST', { jsonrpc: '2.0', id: m.id, error: { code: -32601, message: 'This client does not support that request.' } });
      } catch {
        // The refusal is best effort.
      }
    }
    if (!found) throw new McpClientError('protocol', 'The server did not answer the request.');
    return { message: found, headers: res.headers };
  }

  private async send(method: 'POST' | 'DELETE', body?: unknown, capMs?: number): Promise<{ status: number; headers: Record<string, string>; body: string }> {
    if (this.o.signal?.aborted) throw new McpClientError('aborted', 'The call was cancelled.');
    const remaining = this.deadline - Date.now();
    if (remaining <= 0) throw new McpClientError('timeout', 'The server did not answer in time.');
    let auth: Record<string, string>;
    try {
      auth = await this.o.prepare();
    } catch (e) {
      if (e instanceof McpUrlError) throw new McpClientError('url_refused', e.message, { urlCode: e.code });
      throw e;
    }
    const headers: Record<string, string> = {
      ...auth,
      accept: 'application/json, text/event-stream',
      ...(body !== undefined ? { 'content-type': 'application/json' } : {}),
      ...(this.version ? { 'mcp-protocol-version': this.version } : {}),
      ...(this.sessionId ? { 'mcp-session-id': this.sessionId } : {}),
    };
    let res;
    try {
      res = await this.o.http.send({ method, url: this.o.url, headers, ...(body !== undefined ? { body: JSON.stringify(body) } : {}), timeoutMs: Math.min(remaining, capMs ?? remaining), maxBytes: this.o.maxBytes ?? MCP_MAX_RESPONSE_BYTES, ...(this.o.signal ? { signal: this.o.signal } : {}) });
    } catch (e) {
      throw this.transportError(e);
    }
    const www = res.headers['www-authenticate'];
    if (res.status === 401) throw new McpClientError('auth', 'The server did not accept the sign-in.', { status: 401, ...(www ? { wwwAuthenticate: www } : {}) });
    if (res.status === 403) throw new McpClientError('forbidden', 'The server refused access.', { status: 403 });
    if (res.status >= 300 && res.status < 400) throw new McpClientError('redirect', 'The server redirected: redirects are not followed.', { status: res.status });
    if (res.status === 429 || res.status >= 500) throw new McpClientError('unavailable', 'The server is not available.', { status: res.status });
    if (res.status === 202 || res.status === 204) return res;
    if (res.status === 405 && method === 'DELETE') return res;
    if (res.status !== 200) throw new McpClientError('protocol', 'The server answered in a way this console does not understand.', { status: res.status });
    return res;
  }

  private transportError(e: unknown): McpClientError {
    if (!(e instanceof OutboundHttpError)) return new McpClientError('unavailable', 'The server could not be reached.');
    switch (e.code) {
      case 'timeout':
        return new McpClientError('timeout', 'The server did not answer in time.');
      case 'too_large':
        return new McpClientError('too_large', 'The server answered with more than the size limit.');
      case 'aborted':
        return new McpClientError('aborted', 'The call was cancelled.');
      case 'network':
        return new McpClientError('unavailable', 'The server could not be reached.');
      default:
        return new McpClientError('url_refused', e.message, { urlCode: e.code });
    }
  }
}
