// The MCP endpoint across protocol revisions (#461), against a real
// database: 2024-11-05 to 2025-11-25 with the initialize handshake, the
// stateless 2026-07-28 (per-request _meta, server/discover, Mcp-Method /
// Mcp-Name, cache hints), version negotiation, batches, and the transport
// rules (405, 406, Origin and CORS, JSON-RPC parse errors, no sessions).
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { NestFastifyApplication } from '@nestjs/platform-fastify';

import { createApp } from '../src/main';
import { MCP_VERSIONS, META, SUPPORTED_VERSIONS, type McpVersion } from '../src/mcp/mcp.protocol';

let app: NestFastifyApplication;
let t = '';
const stamp = `${Date.now()}`;
const consoleVersion = (JSON.parse(readFileSync(join(__dirname, '..', 'package.json'), 'utf8')) as { version: string }).version;
const HANDSHAKE = ['2025-11-25', '2025-06-18', '2025-03-26', '2024-11-05'] as const;

const workerMode = process.env.JOBS_WORKER_MODE;
beforeAll(async () => {
  process.env.JOBS_WORKER_MODE = 'off';
  app = await createApp();
  await app.init();
  await app.getHttpAdapter().getInstance().ready();
  if (workerMode === undefined) delete process.env.JOBS_WORKER_MODE;
  else process.env.JOBS_WORKER_MODE = workerMode;
  const res = await app.inject({ method: 'POST', url: '/api/auth/test/login', payload: { email: `mcp-protocol-${stamp}@example.test`, role: 'contributor' } });
  t = new URL(String(res.headers.location)).searchParams.get('token')!;
});
afterAll(async () => {
  await app?.close();
});

interface Sent {
  status: number;
  json: any; // eslint-disable-line @typescript-eslint/no-explicit-any
  headers: Record<string, unknown>;
  raw: string;
}

async function post(body: unknown, headers: Record<string, string> = {}, opts: { auth?: boolean; raw?: string } = {}): Promise<Sent> {
  const res = await app.inject({
    method: 'POST',
    url: '/api/mcp',
    headers: { ...(opts.auth === false ? {} : { authorization: `Bearer ${t}` }), 'content-type': 'application/json', ...headers },
    payload: opts.raw ?? JSON.stringify(body),
  });
  let json: unknown = null;
  try {
    json = res.body ? JSON.parse(res.body) : null;
  } catch {
    json = null;
  }
  return { status: res.statusCode, json, headers: res.headers, raw: res.body };
}

/** A 2026-07-28 request with the headers the transport requires. */
function modern(method: string, params: Record<string, unknown> = {}, id: number | string = 1, headerOverrides: Record<string, string | undefined> = {}) {
  const body = {
    jsonrpc: '2.0',
    id,
    method,
    params: { ...params, _meta: { [META.protocolVersion]: '2026-07-28', [META.clientInfo]: { name: 'claude-ai', version: '1.0' }, [META.clientCapabilities]: {} } },
  };
  const headers: Record<string, string> = { 'mcp-protocol-version': '2026-07-28', 'mcp-method': method };
  if (typeof params.name === 'string') headers['mcp-name'] = params.name;
  for (const [k, v] of Object.entries(headerOverrides)) {
    if (v === undefined) delete headers[k];
    else headers[k] = v;
  }
  return post(body, headers);
}

describe.each(HANDSHAKE)('handshake revision %s', (version) => {
  it('initialize echoes the version; tools/list and tools/call work with and without the version header', async () => {
    const init = await post({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: version, capabilities: {}, clientInfo: { name: 'test', version: '0' } } });
    expect(init.status).toBe(200);
    expect(init.json.result).toMatchObject({ protocolVersion: version, capabilities: { tools: { listChanged: false } }, serverInfo: { name: 'hexactra-console', title: 'Hexactra', version: consoleVersion } });
    // MCP Apps (#466): the ui:// resources and the extension.
    expect(init.json.result.capabilities).toMatchObject({ resources: { listChanged: false, subscribe: false }, extensions: { 'io.modelcontextprotocol/ui': { mimeTypes: ['text/html;profile=mcp-app'] } } });
    expect(init.json.result.instructions).toMatch(/full authority/i);
    expect(init.headers['mcp-session-id']).toBeUndefined();
    expect((await post({ jsonrpc: '2.0', method: 'notifications/initialized' }, { 'mcp-protocol-version': version })).status).toBe(202);

    for (const headers of [{ 'mcp-protocol-version': version }, {}] as Record<string, string>[]) {
      const list = await post({ jsonrpc: '2.0', id: 2, method: 'tools/list' }, headers);
      expect(list.status).toBe(200);
      expect(list.json.result.tools.map((x: { name: string }) => x.name)).toContain('run_goal');
      expect(list.json.result.ttlMs).toBeUndefined();
      expect(list.json.result.resultType).toBeUndefined();
      const call = await post({ jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'tasks_list', arguments: {} } }, headers);
      expect(call.status).toBe(200);
      expect(call.json.result.isError).toBeFalsy();
      // Revisions with structured output (#462): a summary line, then the same JSON; structuredContent wraps the list in items.
      const structured = MCP_VERSIONS[(headers['mcp-protocol-version'] ?? '2025-03-26') as McpVersion].structuredContent;
      const text: string = call.json.result.content[0].text;
      expect(Array.isArray(JSON.parse(structured ? text.slice(text.indexOf('\n') + 1) : text))).toBe(true);
      if (structured) expect(Array.isArray(call.json.result.structuredContent.items)).toBe(true);
      else expect(call.json.result.structuredContent).toBeUndefined();
      expect(call.headers['mcp-session-id']).toBeUndefined();
      expect((await post({ jsonrpc: '2.0', id: 4, method: 'ping' }, headers)).json.result).toEqual({});
    }
  });
});

describe('stateless revision 2026-07-28', () => {
  it('tools/list and tools/call work with no initialize, with cache hints and resultType', async () => {
    const list = await modern('tools/list');
    expect(list.status).toBe(200);
    expect(list.json.result).toMatchObject({ resultType: 'complete', ttlMs: 300000, cacheScope: 'private' });
    expect(list.json.result._meta[META.serverInfo]).toMatchObject({ name: 'hexactra-console', version: consoleVersion });
    const names = list.json.result.tools.map((x: { name: string }) => x.name);
    expect(names).toContain('run_goal');
    // Deterministic order.
    expect((await modern('tools/list', {}, 2)).json.result.tools.map((x: { name: string }) => x.name)).toEqual(names);

    const call = await modern('tools/call', { name: 'tasks_list', arguments: {} }, 3);
    expect(call.status).toBe(200);
    expect(call.json.result).toMatchObject({ resultType: 'complete' });
    expect(call.json.result.isError).toBeFalsy();
    expect(call.json.result.ttlMs).toBeUndefined();
    expect(call.headers['mcp-session-id']).toBeUndefined();
  });

  it('server/discover returns the versions, capabilities, identity and instructions', async () => {
    const d = await modern('server/discover');
    expect(d.status).toBe(200);
    expect(d.json.result).toMatchObject({ resultType: 'complete', supportedVersions: [...SUPPORTED_VERSIONS], capabilities: { tools: { listChanged: false } }, ttlMs: 300000, cacheScope: 'private' });
    expect(d.json.result._meta[META.serverInfo]).toEqual({ name: 'hexactra-console', title: 'Hexactra', version: consoleVersion });
    expect(d.json.result.instructions).toMatch(/browser_request_human/);
  });

  it.each([
    ['Mcp-Method differs from method', { 'mcp-method': 'tools/list' }],
    ['Mcp-Name differs from params.name', { 'mcp-name': 'run_goal' }],
    ['Mcp-Method is missing', { 'mcp-method': undefined }],
    ['Mcp-Name is missing', { 'mcp-name': undefined }],
    ['the version header is missing', { 'mcp-protocol-version': undefined }],
  ] as [string, Record<string, string | undefined>][])('%s → 400 HeaderMismatch', async (_label, overrides) => {
    const r = await modern('tools/call', { name: 'tasks_list', arguments: {} }, 7, overrides);
    expect(r.status).toBe(400);
    expect(r.json).toMatchObject({ jsonrpc: '2.0', id: 7, error: { code: -32020 } });
  });

  it('a version header differing from _meta is 400', async () => {
    const r = await post({ jsonrpc: '2.0', id: 1, method: 'tools/list', params: { _meta: { [META.protocolVersion]: '2026-07-28', [META.clientCapabilities]: {} } } }, { 'mcp-protocol-version': '2025-11-25', 'mcp-method': 'tools/list' });
    expect(r.status).toBe(400);
    expect(r.json.error.code).toBe(-32020);
  });

  it('an unknown method, ping and initialize marked 2026-07-28 are 404 -32601', async () => {
    for (const m of ['nope/nothing', 'ping', 'logging/setLevel', 'sampling/createMessage', 'prompts/list', 'initialize']) {
      const r = await modern(m);
      expect(r.status).toBe(404);
      expect(r.json.error.code).toBe(-32601);
    }
  });

  it('resources/list carries the cache hints and an unknown resource is not found (-32602); the run card: mcp-apps.db.spec.ts', async () => {
    expect((await modern('resources/list')).json.result).toMatchObject({ resources: expect.any(Array), ttlMs: 300000, cacheScope: 'private' });
    const read = await modern('resources/read', { uri: 'ui://hexactra/none' }, 1, { 'mcp-name': 'ui://hexactra/none' });
    expect(read.json.error.code).toBe(-32602);
  });
});

describe('version negotiation', () => {
  it('an unsupported header version is 400 naming the supported versions', async () => {
    const r = await post({ jsonrpc: '2.0', id: 9, method: 'tools/list' }, { 'mcp-protocol-version': '1900-01-01' });
    expect(r.status).toBe(400);
    expect(r.json).toMatchObject({ id: 9, error: { code: -32022, data: { supported: [...SUPPORTED_VERSIONS], requested: '1900-01-01' } } });
  });

  it('initialize with an unknown version is answered with 2025-11-25', async () => {
    const r = await post({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2099-12-31', capabilities: {}, clientInfo: { name: 'future', version: '9' } } });
    expect(r.status).toBe(200);
    expect(r.json.result.protocolVersion).toBe('2025-11-25');
  });
});

describe('batches', () => {
  const batch = [
    { jsonrpc: '2.0', id: 1, method: 'tools/list' },
    { jsonrpc: '2.0', id: 2, method: 'ping' },
    { jsonrpc: '2.0', method: 'notifications/initialized' },
  ];
  it('are accepted for 2025-03-26 (and with no version header)', async () => {
    for (const headers of [{ 'mcp-protocol-version': '2025-03-26' }, {}] as Record<string, string>[]) {
      const r = await post(batch, headers);
      expect(r.status).toBe(200);
      expect(r.json).toHaveLength(2);
      expect(r.json[1]).toMatchObject({ id: 2, result: {} });
    }
  });
  it.each(['2026-07-28', '2025-11-25', '2025-06-18', '2024-11-05'])('are refused for %s', async (version) => {
    const r = await post(batch, { 'mcp-protocol-version': version });
    expect(r.status).toBe(400);
    expect(r.json.error.code).toBe(-32600);
  });
});

describe('transport rules', () => {
  it('GET and DELETE are 405 with Allow: POST', async () => {
    for (const method of ['GET', 'DELETE'] as const) {
      const r = await app.inject({ method, url: '/api/mcp', headers: { authorization: `Bearer ${t}` } });
      expect(r.statusCode).toBe(405);
      expect(r.headers.allow).toBe('POST');
      expect(r.headers['content-type']).toMatch(/application\/json/);
    }
  });

  it('Accept: text/html is 406; JSON and wildcards pass', async () => {
    expect((await post({ jsonrpc: '2.0', id: 1, method: 'tools/list' }, { accept: 'text/html' })).status).toBe(406);
    expect((await post({ jsonrpc: '2.0', id: 1, method: 'tools/list' }, { accept: 'application/json, text/event-stream' })).status).toBe(200);
    expect((await post({ jsonrpc: '2.0', id: 1, method: 'tools/list' }, { accept: '*/*' })).status).toBe(200);
  });

  it('a foreign Origin is 403, no Origin passes, an allowed Origin gets CORS headers', async () => {
    const foreign = await post({ jsonrpc: '2.0', id: 1, method: 'tools/list' }, { origin: 'https://evil.example.test' });
    expect(foreign.status).toBe(403);
    expect(foreign.json.error).toBeDefined();
    // Refused before authentication.
    expect((await post({ jsonrpc: '2.0', id: 1, method: 'tools/list' }, { origin: 'https://evil.example.test' }, { auth: false })).status).toBe(403);

    const none = await post({ jsonrpc: '2.0', id: 1, method: 'tools/list' });
    expect(none.status).toBe(200);
    expect(none.headers['access-control-allow-origin']).toBeUndefined();

    const local = await post({ jsonrpc: '2.0', id: 1, method: 'tools/list' }, { origin: 'http://localhost:6274' });
    expect(local.status).toBe(200);
    expect(local.headers['access-control-allow-origin']).toBe('http://localhost:6274');
    expect(local.headers['access-control-expose-headers']).toBe('www-authenticate');

    const pre = await app.inject({ method: 'OPTIONS', url: '/api/mcp', headers: { origin: 'http://127.0.0.1:6274', 'access-control-request-method': 'POST', 'access-control-request-headers': 'authorization, mcp-protocol-version' } });
    expect(pre.statusCode).toBe(204);
    expect(pre.headers['access-control-allow-origin']).toBe('http://127.0.0.1:6274');
    expect(String(pre.headers['access-control-allow-headers'])).toBe('authorization, content-type, mcp-protocol-version, mcp-method, mcp-name');
    expect(String(pre.headers['access-control-allow-methods'])).toContain('POST');
    expect(pre.headers['access-control-expose-headers']).toBe('www-authenticate');
    expect((await app.inject({ method: 'OPTIONS', url: '/api/mcp', headers: { origin: 'https://evil.example.test' } })).statusCode).toBe(403);
  });

  it('malformed JSON is -32700 with 400; a message without jsonrpc 2.0 is -32600', async () => {
    const parse = await post(null, {}, { raw: '{"jsonrpc":"2.0", nope' });
    expect(parse.status).toBe(400);
    expect(parse.json).toMatchObject({ jsonrpc: '2.0', id: null, error: { code: -32700 } });
    const notRpc = await post({ id: 5, method: 'tools/list' });
    expect(notRpc.status).toBe(400);
    expect(notRpc.json).toMatchObject({ id: 5, error: { code: -32600 } });
  });

  it('a body over 1 MiB is refused with a JSON-RPC error', async () => {
    const big = await post(null, {}, { raw: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list', params: { pad: 'x'.repeat(1024 * 1024 + 10) } }) });
    expect(big.status).toBe(413);
    expect(big.json.error.code).toBe(-32600);
  });

  it('an unknown method on a handshake revision is -32601; sampling, roots, prompts, completion and logging are not offered', async () => {
    for (const m of ['nope', 'logging/setLevel', 'sampling/createMessage', 'roots/list', 'prompts/list', 'completion/complete']) {
      const r = await post({ jsonrpc: '2.0', id: 1, method: m }, { 'mcp-protocol-version': '2025-11-25' });
      expect(r.json.error.code).toBe(-32601);
    }
  });

  it('never issues Mcp-Session-Id, even when a client sends one', async () => {
    const r = await post({ jsonrpc: '2.0', id: 1, method: 'tools/list' }, { 'mcp-session-id': 'abc' });
    expect(r.status).toBe(200);
    expect(r.headers['mcp-session-id']).toBeUndefined();
  });
});
