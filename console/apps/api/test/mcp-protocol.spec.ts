// The MCP protocol layer (src/mcp/mcp.protocol.ts) on its own: the version
// table, how a request's revision is determined, the 2026-07-28 header
// rules, the request context, the client buckets, Origin and Accept.
import { appMetricRegistry } from '@marinoscar/platform-api/otel-core';

import { MCP_METRICS, McpMetrics } from '../src/mcp/mcp.metrics';
import {
  DEFAULT_VERSION,
  LATEST_HANDSHAKE_VERSION,
  MCP_VERSIONS,
  META,
  McpProtocolError,
  SUPPORTED_VERSIONS,
  acceptsJson,
  clientBucket,
  decodeHeaderValue,
  encodeHeaderValue,
  isAllowedOrigin,
  negotiateInitialize,
  requestContext,
  resolveVersion,
  validateHeaders,
  type McpHeaders,
  type RpcMessage,
} from '../src/mcp/mcp.protocol';

const meta = (v: string, extra: Record<string, unknown> = {}) => ({ [META.protocolVersion]: v, [META.clientCapabilities]: {}, ...extra });
const modern = (method: string, params: Record<string, unknown> = {}, id: number | null = 1): RpcMessage => ({ jsonrpc: '2.0', ...(id !== null ? { id } : {}), method, params: { ...params, _meta: meta('2026-07-28') } });

function refusal(fn: () => unknown): McpProtocolError {
  try {
    fn();
  } catch (e) {
    if (e instanceof McpProtocolError) return e;
    throw e;
  }
  throw new Error('expected a refusal');
}

describe('MCP version table', () => {
  it('lists the five revisions, newest first, each with its flags', () => {
    expect(SUPPORTED_VERSIONS).toEqual(['2026-07-28', '2025-11-25', '2025-06-18', '2025-03-26', '2024-11-05']);
    expect(Object.keys(MCP_VERSIONS).sort()).toEqual([...SUPPORTED_VERSIONS].sort());
  });

  it.each([
    ['2026-07-28', { handshake: false, batching: false, structuredContent: true, toolTitle: true, perRequestMeta: true, listCacheHints: true, multiRoundTrip: true }],
    ['2025-11-25', { handshake: true, batching: false, structuredContent: true, toolTitle: true, perRequestMeta: false, listCacheHints: false, multiRoundTrip: false }],
    ['2025-06-18', { handshake: true, batching: false, structuredContent: true, toolTitle: true, perRequestMeta: false, listCacheHints: false, multiRoundTrip: false }],
    ['2025-03-26', { handshake: true, batching: true, structuredContent: false, toolTitle: false, perRequestMeta: false, listCacheHints: false, multiRoundTrip: false }],
    ['2024-11-05', { handshake: true, batching: false, structuredContent: false, toolTitle: false, perRequestMeta: false, listCacheHints: false, multiRoundTrip: false }],
  ] as const)('%s', (v, flags) => {
    expect(MCP_VERSIONS[v]).toEqual(flags);
  });
});

describe('resolveVersion', () => {
  it('takes the header first', () => {
    expect(resolveVersion({ protocolVersion: '2025-06-18' }, modern('tools/list'))).toBe('2025-06-18');
  });
  it('then the _meta version', () => {
    expect(resolveVersion({}, modern('tools/list'))).toBe('2026-07-28');
  });
  it('then, for initialize, the asked revision (or the latest handshake one)', () => {
    expect(resolveVersion({}, { jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2024-11-05' } })).toBe('2024-11-05');
    expect(resolveVersion({}, { jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2099-01-01' } })).toBe(LATEST_HANDSHAKE_VERSION);
    expect(resolveVersion({}, { jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2026-07-28' } })).toBe(LATEST_HANDSHAKE_VERSION);
  });
  it('else 2025-03-26', () => {
    expect(resolveVersion({}, { jsonrpc: '2.0', id: 1, method: 'tools/list' })).toBe(DEFAULT_VERSION);
    expect(DEFAULT_VERSION).toBe('2025-03-26');
  });
  it('refuses an unsupported header or _meta version with -32022 naming the supported ones', () => {
    for (const fn of [() => resolveVersion({ protocolVersion: '1900-01-01' }, {}), () => resolveVersion({}, { method: 'tools/list', params: { _meta: meta('1900-01-01') } })]) {
      const e = refusal(fn);
      expect(e).toMatchObject({ httpStatus: 400, code: -32022, data: { supported: [...SUPPORTED_VERSIONS], requested: '1900-01-01' } });
      expect(e.message).toContain('2025-11-25');
    }
  });
  it('negotiateInitialize echoes a handshake revision only', () => {
    for (const v of ['2025-11-25', '2025-06-18', '2025-03-26', '2024-11-05']) expect(negotiateInitialize(v)).toBe(v);
    expect(negotiateInitialize(undefined)).toBe('2025-11-25');
  });
});

describe('validateHeaders on 2026-07-28', () => {
  const ok: McpHeaders = { protocolVersion: '2026-07-28', method: 'tools/call', name: 'run_status' };
  const call = modern('tools/call', { name: 'run_status', arguments: {} });

  it('accepts matching headers', () => {
    expect(() => validateHeaders('2026-07-28', ok, call)).not.toThrow();
    expect(() => validateHeaders('2026-07-28', { protocolVersion: '2026-07-28', method: 'tools/list' }, modern('tools/list'))).not.toThrow();
  });

  it.each([
    ['no version header', { method: 'tools/call', name: 'run_status' }],
    ['no Mcp-Method', { protocolVersion: '2026-07-28', name: 'run_status' }],
    ['no Mcp-Name on tools/call', { protocolVersion: '2026-07-28', method: 'tools/call' }],
    ['Mcp-Method differs', { ...ok, method: 'tools/list' }],
    ['Mcp-Name differs', { ...ok, name: 'run_goal' }],
  ] as [string, McpHeaders][])('refuses %s with 400 -32020', (_label, headers) => {
    expect(refusal(() => validateHeaders('2026-07-28', headers, call))).toMatchObject({ httpStatus: 400, code: -32020 });
  });

  it('refuses a version header that differs from _meta', () => {
    expect(refusal(() => validateHeaders('2026-07-28', ok, { ...call, params: { name: 'run_status', _meta: meta('2025-11-25') } }))).toMatchObject({ code: -32020 });
  });

  it('decodes a Base64 Mcp-Name before comparing', () => {
    const named = modern('resources/read', { uri: 'ui://hexactra/run-card' });
    expect(() => validateHeaders('2026-07-28', { protocolVersion: '2026-07-28', method: 'resources/read', name: encodeHeaderValue('ui://hexactra/run-card') }, named)).not.toThrow();
    const odd = modern('tools/call', { name: 'wetter_ä' });
    expect(encodeHeaderValue('wetter_ä')).toMatch(/^=\?base64\?.*\?=$/);
    expect(() => validateHeaders('2026-07-28', { protocolVersion: '2026-07-28', method: 'tools/call', name: encodeHeaderValue('wetter_ä') }, odd)).not.toThrow();
    expect(decodeHeaderValue('=?base64?SGVsbG8sIOS4lueVjA==?=')).toBe('Hello, 世界');
    expect(encodeHeaderValue('=?base64?literal?=')).toBe('=?base64?PT9iYXNlNjQ/bGl0ZXJhbD89?=');
  });

  it('does not require Mcp-Method on a notification', () => {
    expect(() => validateHeaders('2026-07-28', { protocolVersion: '2026-07-28' }, modern('notifications/cancelled', {}, null))).not.toThrow();
  });
});

describe('validateHeaders on handshake revisions', () => {
  it('requires nothing', () => {
    expect(() => validateHeaders('2025-06-18', {}, { jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'x' } })).not.toThrow();
  });
  it('still refuses a header that is present and disagrees with the body', () => {
    expect(refusal(() => validateHeaders('2025-11-25', { method: 'tools/list' }, { jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'x' } }))).toMatchObject({ code: -32020 });
  });
});

describe('requestContext', () => {
  it('reads client info and capabilities from _meta on 2026-07-28', () => {
    const msg = modern('tools/list');
    (msg.params as { _meta: Record<string, unknown> })._meta[META.clientInfo] = { name: 'ExampleClient', version: '1.0.0' };
    (msg.params as { _meta: Record<string, unknown> })._meta[META.clientCapabilities] = { extensions: { 'io.modelcontextprotocol/ui': {} } };
    const ctx = requestContext({ protocolVersion: '2026-07-28', method: 'tools/list' }, msg, { kind: 'pat', tokenId: 't' });
    expect(ctx).toMatchObject({ version: '2026-07-28', clientInfo: { name: 'ExampleClient', version: '1.0.0' }, clientCapabilities: { extensions: {} }, credential: { kind: 'pat' } });
    expect(ctx.flags.perRequestMeta).toBe(true);
  });
  it('reads them from initialize params on a handshake revision', () => {
    const ctx = requestContext({}, { jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18', clientInfo: { name: 'x'.repeat(100) }, capabilities: { roots: {} } } }, null);
    expect(ctx.version).toBe('2025-06-18');
    expect(ctx.clientInfo?.name).toHaveLength(64);
    expect(ctx.clientCapabilities).toEqual({ roots: {} });
  });
});

describe('clientBucket', () => {
  it.each([
    ['claude-ai', 'claude'],
    ['Anthropic/ClaudeAI', 'claude'],
    ['claude-code', 'claude-code'],
    ['openai-mcp', 'chatgpt'],
    ['ChatGPT', 'chatgpt'],
    ['hermes-agent', 'hermes'],
    ['openclaw', 'openclaw'],
    ['pi', 'pi'],
    ['pi-coding-agent', 'pi'],
    ['pipeline-tool', 'other'],
    ['mcp-inspector', 'other'],
    [undefined, 'other'],
  ])('%s → %s', (name, bucket) => {
    expect(clientBucket(name)).toBe(bucket);
  });
});

describe('isAllowedOrigin', () => {
  const app = 'https://console.example.test';
  it.each([
    ['https://console.example.test', true],
    ['http://localhost:6274', true],
    ['http://127.0.0.1:9999', true],
    ['http://[::1]:3000', true],
    ['https://evil.example.test', false],
    ['https://console.example.test.evil.test', false],
    ['http://console.example.test', false],
    ['null', false],
    ['https://console.example.test/path', false],
  ])('%s → %s', (origin, allowed) => {
    expect(isAllowedOrigin(origin, app)).toBe(allowed);
  });
  it('takes extra origins', () => {
    expect(isAllowedOrigin('https://tools.example.test', app, ['https://tools.example.test/'])).toBe(true);
  });
});

describe('acceptsJson', () => {
  it.each([
    [undefined, true],
    ['application/json, text/event-stream', true],
    ['*/*', true],
    ['application/json;q=0.9', true],
    ['text/html', false],
    ['text/event-stream', false],
  ])('%s → %s', (accept, ok) => {
    expect(acceptsJson(accept)).toBe(ok);
  });
});

describe('MCP metrics', () => {
  it('registers app.mcp.* with bounded labels and records without a metrics service', () => {
    for (const def of MCP_METRICS) expect(appMetricRegistry.get(def.key)).toMatchObject({ name: def.name });
    const m = new McpMetrics();
    expect(() => m.message({ method: 'tools/list', protocolVersion: '2026-07-28', client: 'claude', credential: 'pat', isError: false })).not.toThrow();
  });
});
