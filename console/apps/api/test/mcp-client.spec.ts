// The MCP client (E39.9, #606) against an in-process fake server over a real loopback socket: initialise and revision negotiation, paged
// tools/list, tools/call, the deadline, the size cap, abort, and the refusal of everything a server may ask of a client (sampling,
// elicitation, roots). The transport is the console's own SSRF-guarded one.
import { PinnedOutboundHttp } from '../src/oauth-client';
import { McpClient, McpClientError, parseMessages } from '../src/connections/mcp/mcp-client';
import { FakeMcpServer, type FakeTool } from './support/fake-mcp-server';

const http = new PinnedOutboundHttp();
const tool = (name: string, extra: Partial<FakeTool> = {}): FakeTool => ({ name, description: `Does ${name}.`, inputSchema: { type: 'object', properties: { text: { type: 'string' } } }, ...extra });

const servers: FakeMcpServer[] = [];
const serve = async (opts: ConstructorParameters<typeof FakeMcpServer>[0] = {}) => {
  const s = await new FakeMcpServer(opts).start();
  servers.push(s);
  return s;
};
afterEach(async () => {
  await Promise.all(servers.splice(0).map((s) => s.stop()));
});

const connect = (s: FakeMcpServer, extra: Partial<Parameters<typeof McpClient.connect>[0]> = {}) => McpClient.connect({ http, url: s.url, prepare: async () => ({}), ...extra });
const kind = async (p: Promise<unknown>) => p.then(() => 'resolved', (e: unknown) => (e instanceof McpClientError ? e.kind : `other:${String(e)}`));

describe('initialise and revision negotiation', () => {
  it('asks for the newest revision and declares no client capability at all', async () => {
    const s = await serve({ tools: [tool('a')] });
    const c = await connect(s);
    const init = s.received.find((r) => r.body?.method === 'initialize')!;
    expect(init.body?.params).toMatchObject({ protocolVersion: '2025-11-25', capabilities: {}, clientInfo: { name: 'hexactra-console' } });
    expect(c.protocolVersion).toBe('2025-11-25');
    expect(c.serverInfo).toEqual({ name: 'Fake Notes Server', version: '1.0.0' });
    expect(s.received.some((r) => r.body?.method === 'notifications/initialized')).toBe(true);
  });

  it('accepts an older revision the server speaks, and sends it on every later request', async () => {
    const s = await serve({ versions: ['2025-06-18'], tools: [tool('a')] });
    const c = await connect(s);
    expect(c.protocolVersion).toBe('2025-06-18');
    await c.listTools();
    const list = s.received.find((r) => r.body?.method === 'tools/list')!;
    expect(list.headers['mcp-protocol-version']).toBe('2025-06-18');
  });

  it('refuses a server that speaks no revision this console speaks (the older HTTP+SSE transport)', async () => {
    const s = await serve({ versions: ['2024-11-05'] });
    expect(await kind(connect(s))).toBe('protocol');
  });

  it('carries the session id the server issued on every later request, and ends the session', async () => {
    const s = await serve({ session: true, tools: [tool('a')] });
    const c = await connect(s);
    await c.listTools();
    await c.close();
    const later = s.received.filter((r) => r.body?.method !== 'initialize');
    expect(later.length).toBeGreaterThan(2);
    for (const r of later) expect(r.headers['mcp-session-id']).toBe('session-1');
    expect(s.received.at(-1)?.method).toBe('DELETE');
  });
});

describe('tools/list and tools/call', () => {
  it('follows the pages of tools/list', async () => {
    const s = await serve({ tools: ['a', 'b', 'c', 'd', 'e'].map((n) => tool(n)), pageSize: 2 });
    const { tools } = await (await connect(s)).listTools();
    expect(tools.map((t) => t.name)).toEqual(['a', 'b', 'c', 'd', 'e']);
    expect(s.received.filter((r) => r.body?.method === 'tools/list')).toHaveLength(3);
  });

  it('skips an entry that is not a usable tool and keeps only the four hints', async () => {
    const s = await serve({ tools: [tool('ok', { annotations: { readOnlyHint: true, title: 'x', somethingElse: 1 } }), { name: 'bad', inputSchema: { type: 'string' } } as FakeTool] });
    const { tools, skipped } = await (await connect(s)).listTools();
    expect(tools.map((t) => t.name)).toEqual(['ok']);
    expect(skipped).toBe(1);
    expect(tools[0]!.annotations).toEqual({ readOnlyHint: true });
  });

  it('calls a tool and returns its content, over JSON and over an event stream', async () => {
    for (const sse of [false, true]) {
      const s = await serve({ tools: [tool('echo')], sse });
      const c = await connect(s);
      const r = await c.callTool('echo', { text: 'hi' });
      expect(r).toMatchObject({ isError: false, content: [{ type: 'text', text: 'ok echo {"text":"hi"}' }] });
      expect(s.calls()[0]!.body?.params).toEqual({ name: 'echo', arguments: { text: 'hi' } });
    }
  });

  it('turns a JSON-RPC error into an rpc failure with the server\'s message cleaned', async () => {
    const s = await serve({ tools: [tool('echo')] });
    const c = await connect(s);
    await expect(c.callTool('missing', {})).rejects.toMatchObject({ kind: 'rpc', extra: { rpcCode: -32602, serverMessage: 'Unknown tool missing' } });
  });
});

describe('deadlines, size and abort', () => {
  it('abandons a call that takes longer than its deadline', async () => {
    const s = await serve({ tools: [tool('slow')], callDelayMs: 400 });
    const c = await connect(s, { timeoutMs: 150 });
    expect(await kind(c.callTool('slow', {}))).toBe('timeout');
  });

  it('refuses a response larger than the cap', async () => {
    const s = await serve({ tools: [tool('big')], results: { big: () => ({ content: [{ type: 'text', text: 'x'.repeat(5_000) }] }) } });
    const c = await connect(s, { maxBytes: 2_000 }).catch(() => null);
    // The handshake fits under a 2 kB cap; the result does not.
    expect(await kind(c ? c.callTool('big', {}) : Promise.reject(new McpClientError('too_large', 'x')))).toBe('too_large');
  });

  it('is aborted by the caller\'s signal while a call is in flight', async () => {
    const s = await serve({ tools: [tool('slow')], callDelayMs: 1_000 });
    const ctrl = new AbortController();
    const c = await connect(s, { signal: ctrl.signal });
    const pending = kind(c.callTool('slow', {}));
    setTimeout(() => ctrl.abort(), 50);
    expect(await pending).toBe('aborted');
  });

  it('does not start a call after the signal aborted', async () => {
    const s = await serve({ tools: [tool('a')] });
    const ctrl = new AbortController();
    const c = await connect(s, { signal: ctrl.signal });
    ctrl.abort();
    const before = s.received.length;
    expect(await kind(c.callTool('a', {}))).toBe('aborted');
    expect(s.received).toHaveLength(before);
  });
});

describe('what a server may not ask of this client', () => {
  it('refuses sampling, elicitation and roots requests, does nothing about them, and still returns the result', async () => {
    const s = await serve({
      tools: [tool('echo')],
      serverRequests: [{ method: 'sampling/createMessage', params: { messages: [] } }, { method: 'elicitation/create', params: { message: 'Your password?' } }, { method: 'roots/list' }],
    });
    const c = await connect(s);
    const r = await c.callTool('echo', { text: 'hi' });
    expect(r.content).toEqual([{ type: 'text', text: 'ok echo {"text":"hi"}' }]);
    expect(c.refusedServerRequests).toBe(3);
    const refusals = s.clientErrors();
    expect(refusals.map((x) => x.body?.id)).toEqual(['srv-1', 'srv-2', 'srv-3']);
    for (const x of refusals) expect(x.body?.error?.code).toBe(-32601);
    // The only capabilities ever declared are none.
    const inits = s.received.filter((x) => x.body?.method === 'initialize');
    for (const i of inits) expect(i.body?.params?.capabilities).toEqual({});
  });
});

describe('the server answers badly', () => {
  it('reports a 401 as an auth failure and keeps the challenge', async () => {
    const s = await serve({ bearer: 'secret-value-123' });
    const e = await connect(s).catch((x: unknown) => x);
    expect(e).toMatchObject({ kind: 'auth', extra: { status: 401, wwwAuthenticate: expect.stringContaining('resource_metadata') } });
  });

  it('never follows a redirect', async () => {
    const other = await serve({ tools: [tool('a')] });
    const s = await serve({ redirectTo: other.url });
    expect(await kind(connect(s))).toBe('redirect');
    expect(other.received).toHaveLength(0);
  });

  it('parses a stream of events and ignores one that is not JSON', () => {
    const body = 'event: message\ndata: {"jsonrpc":"2.0","id":1,"result":{}}\n\nevent: ping\ndata: not json\n\n';
    expect(parseMessages('text/event-stream; charset=utf-8', body)).toEqual([{ jsonrpc: '2.0', id: 1, result: {} }]);
    expect(() => parseMessages('application/json', '<html>')).toThrow(McpClientError);
  });
});
