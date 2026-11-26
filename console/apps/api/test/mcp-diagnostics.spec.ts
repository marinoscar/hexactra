// The MCP diagnostics without a database or a server (E50.12, #982): the ONE mapping of every `McpClientError` kind (and of the
// address, transport and sign-in failures) to a stage and a code, as a table; the cleaned server name; every code has a remedy; and the
// presets file: each entry well formed, https, dated, without a secret or a tool mode, and filtered by the administrator's lists.
import { DIAGNOSTIC_REMEDIES, MCP_PRESETS } from '@app/shared';

import { ConnectionError } from '../src/connections/connections.errors';
import { McpClientError, type McpClientErrorKind } from '../src/connections/mcp/mcp-client';
import { MCP_DIAGNOSTIC_CODES, mcpFailure, serverNameData, signInCode } from '../src/connections/mcp/mcp-diagnostics';
import { loadPresets, presetsFor } from '../src/connections/mcp/mcp-presets';
import { McpUrlError } from '../src/connections/mcp/mcp-url';
import { stageDataStringSchema } from '../src/diagnostics/diagnostic-report';
import { OutboundHttpError } from '../src/oauth-client';

const err = (kind: McpClientErrorKind, extra: ConstructorParameters<typeof McpClientError>[2] = {}) => new McpClientError(kind, 'static', extra);

describe('a failure as a stage and a code', () => {
  it.each<[string, unknown, 'initialize' | 'tool_list', { stage: string; code: string; data?: Record<string, string> }]>([
    ['url_refused host_blocked', err('url_refused', { urlCode: 'host_blocked' }), 'initialize', { stage: 'address', code: 'HOST_BLOCKED' }],
    ['url_refused host_not_allowed', err('url_refused', { urlCode: 'host_not_allowed' }), 'initialize', { stage: 'address', code: 'HOST_NOT_ALLOWED' }],
    ['url_refused private_target (rebinding at call time)', err('url_refused', { urlCode: 'private_target' }), 'tool_list', { stage: 'network', code: 'PRIVATE_TARGET' }],
    ['url_refused unresolvable', err('url_refused', { urlCode: 'unresolvable' }), 'initialize', { stage: 'network', code: 'UNRESOLVABLE' }],
    ['McpUrlError invalid_url', new McpUrlError('invalid_url', 'x'), 'initialize', { stage: 'address', code: 'INVALID_URL' }],
    ['OutboundHttpError scheme_not_allowed', new OutboundHttpError('scheme_not_allowed', 'x'), 'initialize', { stage: 'address', code: 'SCHEME_NOT_ALLOWED' }],
    ['auth', err('auth', { status: 401 }), 'initialize', { stage: 'sign_in', code: 'AUTH_REFUSED' }],
    ['forbidden', err('forbidden', { status: 403 }), 'tool_list', { stage: 'sign_in', code: 'AUTH_REFUSED' }],
    ['unavailable 503', err('unavailable', { status: 503 }), 'initialize', { stage: 'initialize', code: 'UNAVAILABLE' }],
    ['unavailable 503 listing', err('unavailable', { status: 503 }), 'tool_list', { stage: 'tool_list', code: 'TOOL_LIST_FAILED' }],
    ['unavailable no answer', err('unavailable', { netCode: 'ECONNREFUSED' }), 'initialize', { stage: 'network', code: 'NETWORK' }],
    ['unavailable TLS (EPROTO)', err('unavailable', { netCode: 'EPROTO' }), 'initialize', { stage: 'network', code: 'TLS_FAILED' }],
    ['unavailable TLS (certificate)', err('unavailable', { netCode: 'CERT_HAS_EXPIRED' }), 'initialize', { stage: 'network', code: 'TLS_FAILED' }],
    ['unavailable TLS (self-signed)', err('unavailable', { netCode: 'DEPTH_ZERO_SELF_SIGNED_CERT' }), 'initialize', { stage: 'network', code: 'TLS_FAILED' }],
    ['unavailable TLS (wrong version)', err('unavailable', { netCode: 'ERR_SSL_WRONG_VERSION_NUMBER' }), 'initialize', { stage: 'network', code: 'TLS_FAILED' }],
    ['timeout initialize', err('timeout'), 'initialize', { stage: 'network', code: 'TIMEOUT' }],
    ['timeout listing', err('timeout'), 'tool_list', { stage: 'tool_list', code: 'TIMEOUT' }],
    ['protocol not MCP', err('protocol', { protocolReason: 'not_mcp' }), 'initialize', { stage: 'initialize', code: 'NOT_AN_MCP_SERVER' }],
    ['protocol revision', err('protocol', { protocolReason: 'revision', offered: '2024-11-05' }), 'initialize', { stage: 'initialize', code: 'REVISION_NOT_SPOKEN', data: { offered: '2024-11-05' } }],
    ['protocol while listing', err('protocol', { protocolReason: 'not_mcp' }), 'tool_list', { stage: 'tool_list', code: 'TOOL_LIST_FAILED' }],
    ['rpc initialize', err('rpc', { rpcCode: -32603 }), 'initialize', { stage: 'initialize', code: 'RPC' }],
    ['rpc listing', err('rpc', { rpcCode: -32603 }), 'tool_list', { stage: 'tool_list', code: 'TOOL_LIST_FAILED' }],
    ['too_large', err('too_large'), 'tool_list', { stage: 'tool_list', code: 'TOO_LARGE' }],
    ['redirect', err('redirect', { status: 307 }), 'initialize', { stage: 'initialize', code: 'REDIRECT' }],
    ['aborted', err('aborted'), 'initialize', { stage: 'initialize', code: 'ABORTED' }],
    ['a sign-in the console could not produce', new ConnectionError('CONNECTION_NEEDS_RECONNECT', 'x', { reason: 'NO_SECRET' }), 'initialize', { stage: 'sign_in', code: 'SECRET_MISSING' }],
    ['anything else', new Error('person.a@example.test'), 'initialize', { stage: 'initialize', code: 'UNKNOWN' }],
  ])('%s', (_name, e, during, expected) => {
    const f = mcpFailure(e, during);
    expect(f).toEqual(expected);
    expect(MCP_DIAGNOSTIC_CODES).toContain(f.code);
  });

  it('covers every kind of McpClientError', () => {
    const kinds: McpClientErrorKind[] = ['url_refused', 'auth', 'forbidden', 'unavailable', 'timeout', 'protocol', 'too_large', 'aborted', 'redirect', 'rpc'];
    for (const k of kinds) for (const during of ['initialize', 'tool_list'] as const) expect([k, mcpFailure(err(k), during).code === 'UNKNOWN']).toEqual([k, false]);
  });

  it('maps a sign-in the console could not produce', () => {
    expect(signInCode(new ConnectionError('CONNECTION_NEEDS_RECONNECT', 'x', { reason: 'GRANT_REVOKED' }))).toBe('GRANT_REVOKED');
    expect(signInCode(new ConnectionError('CONNECTION_NEEDS_RECONNECT', 'x', { reason: 'NO_REFRESH_TOKEN' }))).toBe('NO_REFRESH_TOKEN');
    expect(signInCode(new ConnectionError('CONNECTION_NEEDS_RECONNECT', 'x', { reason: 'something' }))).toBe('CONNECTION_NEEDS_RECONNECT');
    expect(signInCode(new ConnectionError('CONNECTION_UNAVAILABLE', 'x', { reason: 'app_refused' }))).toBe('OAUTH_DISCOVERY_FAILED');
    expect(signInCode(new ConnectionError('CONNECTION_UNAVAILABLE', 'x', { reason: 'unavailable' }))).toBe('UNAVAILABLE');
    expect(signInCode(new ConnectionError('CONNECTION_UNAVAILABLE', 'x', { reason: 'refresh_wait_timeout' }))).toBe('TIMEOUT');
    expect(signInCode(new ConnectionError('CONNECTION_PAUSED', 'x'))).toBe('CONNECTION_PAUSED');
  });

  it('every code has an entry in the remedy table', () => {
    expect(MCP_DIAGNOSTIC_CODES.filter((c) => !DIAGNOSTIC_REMEDIES[c])).toEqual([]);
  });
});

describe('the server name in a report', () => {
  it('is plain, capped and a valid data value; markup, spaces and control characters do not survive', () => {
    expect(serverNameData('Fake Notes Server')).toBe('Fake-Notes-Server');
    expect(serverNameData('<script>alert(1)</script> Notes\u0000')).not.toMatch(/[<>()\s\u0000]/);
    expect(serverNameData('')).toBeNull();
    expect(serverNameData(null)).toBeNull();
    expect(serverNameData('x'.repeat(500))!.length).toBeLessThanOrEqual(60);
    for (const raw of ['Fake Notes Server', 'GitHub MCP Server', 'sentry.dev', 'Ünïcödé Sërvér']) expect([raw, stageDataStringSchema.safeParse(serverNameData(raw)).success]).toEqual([raw, true]);
  });
});

describe('the presets file', () => {
  it('is well formed: https addresses in the form they are kept, a documentation link and the date checked', () => {
    const presets = loadPresets();
    expect(presets.length).toBeGreaterThan(0);
    expect(new Set(presets.map((p) => p.id)).size).toBe(presets.length);
    for (const p of presets) {
      expect(p.url.startsWith('https://')).toBe(true);
      expect(p.docsUrl.startsWith('https://')).toBe(true);
      expect(p.verified).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    }
  });

  it('never carries a secret or a tool mode', () => {
    for (const p of MCP_PRESETS as readonly Record<string, unknown>[]) {
      expect(Object.keys(p).sort()).toEqual(expect.arrayContaining(['auth', 'docsUrl', 'id', 'name', 'notes', 'url', 'verified']));
      for (const k of Object.keys(p)) expect(['id', 'name', 'url', 'auth', 'headerName', 'docsUrl', 'notes', 'verified']).toContain(k);
    }
    expect(() => loadPresets([{ ...MCP_PRESETS[0], token: 'x' }])).toThrow();
    expect(() => loadPresets([{ ...MCP_PRESETS[0], mode: 'read' }])).toThrow();
    expect(() => loadPresets([{ ...MCP_PRESETS[0], url: 'http://mcp.example.test/mcp' }])).toThrow();
    expect(() => loadPresets([{ ...MCP_PRESETS[0], url: 'https://mcp.example.test/mcp?key=1' }])).toThrow();
  });

  it('follows the administrator\'s lists', () => {
    const all = loadPresets();
    expect(presetsFor({ allowedHosts: [], blockedHosts: [] }, all)).toEqual(all);
    expect(presetsFor({ allowedHosts: [], blockedHosts: ['api.githubcopilot.com'] }, all).map((p) => p.id)).not.toContain('github');
    expect(presetsFor({ allowedHosts: ['mcp.example.test'], blockedHosts: [] }, all)).toEqual([]);
  });
});
