// MCP server diagnostics, Try a tool, presets and the idle OAuth refresh against a real database and an in-process fake MCP server
// (E50.12, #982). Every code of the MCP stages is produced by the fake (or by the address and the administrator's lists), a diagnostic is
// shown to store nothing in `connection_mcp_tools`, Try a tool is refused for `write` and `off`, validates, redacts, caps and is audited
// without values, the presets route filters by the host lists, and the daily health job refreshes an idle MCP OAuth connection and marks a
// refused one. NOT VERIFIED AGAINST A REAL MCP SERVER: none is reachable from the test environment.
import { randomUUID } from 'node:crypto';
import type { NestFastifyApplication } from '@nestjs/platform-fastify';

import { ConnectionApps } from '../src/connections/connection-apps.service';
import { ConnectionError } from '../src/connections/connections.errors';
import { ConnectionTokenStore } from '../src/connections/connection-token.store';
import { ConnectionsHealth, ConnectionsHealthHandler, IDLE_AFTER_MS } from '../src/connections/connections.jobs';
import { McpDiagnostics } from '../src/connections/mcp/mcp-diagnostics';
import { McpSecretStore } from '../src/connections/mcp/mcp-secrets';
import type { DiagnosticStage } from '../src/diagnostics/diagnostic-report';
import { createApp } from '../src/main';
import { PrismaService } from '../src/prisma/prisma.service';
import { FakeMcpServer, type FakeMcpOptions, type FakeTool } from './support/fake-mcp-server';

const savedKey = process.env.SECRETS_ENCRYPTION_KEY;
process.env.SECRETS_ENCRYPTION_KEY ||= Buffer.alloc(32, 7).toString('base64');
const stamp = `${Date.now()}`;
const BEARER = `MARKER-bearer-${randomUUID()}`;

let app: NestFastifyApplication;
let prisma: PrismaService;
let admin: Session;
const servers: FakeMcpServer[] = [];
const responses: string[] = [];

interface Session {
  token: string;
  userId: string;
}
interface Report {
  overall: string;
  stages: DiagnosticStage[];
}
interface Tool {
  id: string;
  name: string;
  mode: string;
}

async function login(name: string, role: 'contributor' | 'admin' = 'contributor'): Promise<Session> {
  const res = await app.inject({ method: 'POST', url: '/api/auth/test/login', payload: { email: `${name}-${stamp}@example.test`, role } });
  const token = new URL(String(res.headers.location)).searchParams.get('token')!;
  const me = await app.inject({ method: 'GET', url: '/api/auth/me', headers: { authorization: `Bearer ${token}` } });
  return { token, userId: me.json<{ data: { id: string } }>().data.id };
}

async function call<T = unknown>(s: Session, method: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE', url: string, payload?: unknown) {
  const res = await app.inject({ method, url, headers: { authorization: `Bearer ${s.token}` }, ...(payload === undefined ? {} : { payload: payload as object }) });
  responses.push(`${res.statusCode} ${res.body}`);
  const body = res.body ? (res.json() as { data?: T; error?: { code?: string; details?: Record<string, unknown> }; code?: string; details?: Record<string, unknown> }) : {};
  return { statusCode: res.statusCode, code: body.error?.code ?? body.code ?? '', data: body.data as T, details: body.error?.details ?? body.details };
}

const TOOLS: FakeTool[] = [
  { name: 'search_notes', title: 'Search notes', description: 'Search the notes.', inputSchema: { type: 'object', properties: { query: { type: 'string', maxLength: 200 } }, required: ['query'], additionalProperties: false }, annotations: { readOnlyHint: true } },
  { name: 'add_note', description: 'Adds a note.', inputSchema: { type: 'object', properties: { title: { type: 'string' } } } },
];

const serve = async (opts: FakeMcpOptions = {}) => {
  const s = await new FakeMcpServer({ tools: TOOLS.map((t) => ({ ...t })), ...opts }).start();
  servers.push(s);
  return s;
};
const setMcp = async (patch: { enabled?: boolean; allowedHosts?: string[]; blockedHosts?: string[] }) => {
  expect((await call(admin, 'PUT', '/api/connections/admin/mcp', patch)).statusCode).toBe(200);
  app.get(ConnectionApps, { strict: false }).invalidate();
};
const tools = async (s: Session, id: string) => (await call<{ tools: Tool[] }>(s, 'GET', `/api/connections/${id}/tools`)).data.tools;
const toolId = async (s: Session, id: string, name: string) => (await tools(s, id)).find((t) => t.name === name)!.id;
const diagnose = async (s: Session, id: string) => {
  const r = await call<Report>(s, 'POST', `/api/connections/${id}/diagnose`);
  expect(r.statusCode).toBe(200);
  return r.data;
};
const stage = (r: Report, id: string) => r.stages.find((x) => x.id === id)!;
const shape = (r: Report) => r.stages.map((x) => [x.id, x.status, x.code]);

/** A user with one MCP connection to `srv` (bearer `BEARER` when the server wants it). */
async function connected(name: string, srv: FakeMcpServer, auth: Record<string, unknown> = { kind: 'none' }): Promise<{ s: Session; id: string }> {
  const s = await login(name);
  const r = await call<{ connection: { id: string } }>(s, 'POST', '/api/connections/mcp', { url: srv.url, label: 'Notes', auth });
  expect(r.statusCode).toBe(200);
  return { s, id: r.data.connection.id };
}

/** A user with an OAuth MCP connection, through the real consent flow. */
async function oauthConnected(name: string, srv: FakeMcpServer): Promise<{ s: Session; id: string }> {
  const s = await login(name);
  const start = await app.inject({ method: 'POST', url: '/api/connections/mcp', headers: { authorization: `Bearer ${s.token}` }, payload: { url: srv.url, label: 'OAuth notes', auth: { kind: 'oauth' } } });
  expect(start.statusCode).toBe(200);
  const raw = Array.isArray(start.headers['set-cookie']) ? String(start.headers['set-cookie'][0]) : String(start.headers['set-cookie']);
  const m = /^(hx_conn_[a-f0-9]+)=([^;]*)/.exec(raw)!;
  const { code, state, iss } = srv.consent(start.json<{ data: { consent: { authorizeUrl: string } } }>().data.consent.authorizeUrl);
  const cb = await app.inject({ method: 'GET', url: `/api/connections/callback/mcp?${new URLSearchParams({ code, state, iss })}`, headers: { cookie: `${m[1]}=${m[2]}` } });
  const location = String(cb.headers.location);
  expect(location).toContain('connect=connected');
  return { s, id: new URL(location, 'http://console.example.test').searchParams.get('connection')! };
}

/** Points a stored connection at another address (what a stale row, a rebinding or a hand-edited config looks like). */
async function pointAt(id: string, url: string): Promise<void> {
  const row = await prisma.connection.findUniqueOrThrow({ where: { id } });
  await prisma.connection.update({ where: { id }, data: { config: { ...(row.config as Record<string, unknown>), url } } });
}

beforeAll(async () => {
  app = await createApp();
  await app.init();
  await app.getHttpAdapter().getInstance().ready();
  prisma = app.get(PrismaService);
  admin = await login('mcpd-admin', 'admin');
  await setMcp({ enabled: true, allowedHosts: [], blockedHosts: [] });
});

afterAll(async () => {
  await call(admin, 'PUT', '/api/connections/admin/mcp', { enabled: false, allowedHosts: [], blockedHosts: [] });
  await prisma.connectionDiagnostic.deleteMany({ where: { user: { email: { contains: stamp } } } });
  await prisma.connection.deleteMany({ where: { user: { email: { contains: stamp } } } });
  await Promise.all(servers.map((s) => s.stop()));
  await app?.close();
  if (savedKey === undefined) delete process.env.SECRETS_ENCRYPTION_KEY;
  else process.env.SECRETS_ENCRYPTION_KEY = savedKey;
});

describe('the stages of an MCP server', () => {
  it('a healthy server: every stage in order, with the revision, the cleaned server name and counts only', async () => {
    const srv = await serve({ bearer: BEARER, serverName: 'Fake Notes Server <b>x</b>', pageSize: 1 });
    const { s, id } = await connected('mcpd-ok', srv, { kind: 'bearer', token: BEARER });
    await call(s, 'PATCH', `/api/connections/${id}/tools/${await toolId(s, id, 'search_notes')}`, { mode: 'read' });
    const r = await diagnose(s, id);
    expect(shape(r)).toEqual([
      ['status', 'pass', null],
      ['provider_installed', 'pass', null],
      ['switch', 'pass', null],
      ['address', 'pass', null],
      ['network', 'pass', null],
      ['initialize', 'pass', null],
      ['sign_in', 'pass', null],
      ['tool_list', 'pass', null],
      ['tool_changes', 'pass', null],
      ['enabled_tools', 'pass', null],
      ['offered_cap', 'pass', null],
      ['latency', 'pass', null],
    ]);
    expect(stage(r, 'address').data).toEqual({ host: '127.0.0.1' });
    expect(stage(r, 'initialize').data).toEqual({ revision: '2025-11-25', server_name: 'Fake-Notes-Server-x' });
    expect(stage(r, 'sign_in').data).toEqual({ kind: 'bearer' });
    expect(stage(r, 'tool_list').data).toEqual({ count: 2, pages: 2 });
    expect(stage(r, 'tool_changes').data).toEqual({ changed: 0, new: 0, removed: 0 });
    expect(stage(r, 'enabled_tools').data).toEqual({ read: 1, write: 0 });
    expect(stage(r, 'offered_cap').data).toEqual({ enabled: 1, cap: 40, toolbox: false, not_offered: 0 });
    const text = JSON.stringify(r);
    for (const leak of ['search_notes', 'Search the notes', BEARER, '/mcp']) expect(text).not.toContain(leak);
  });

  it('MCP_OFF: the switch stage, when the administrator switched MCP servers off after the report started', async () => {
    const srv = await serve();
    const { id } = await connected('mcpd-off', srv);
    const row = await prisma.connection.findUniqueOrThrow({ where: { id } });
    await setMcp({ enabled: false });
    try {
      const stages = await app.get(McpDiagnostics, { strict: false }).diagnose({ connection: row, accessToken: () => Promise.reject(new Error('unused')) }, { signal: new AbortController().signal, trigger: 'owner' });
      expect(stages.slice(0, 2).map((x) => [x.id, x.status, x.code])).toEqual([
        ['switch', 'fail', 'MCP_OFF'],
        ['address', 'skipped', null],
      ]);
    } finally {
      await setMcp({ enabled: true });
    }
  });

  it('address: INVALID_URL, HOST_BLOCKED and HOST_NOT_ALLOWED', async () => {
    const srv = await serve();
    const { s, id } = await connected('mcpd-address', srv);
    await setMcp({ blockedHosts: ['127.0.0.1'] });
    try {
      expect(stage(await diagnose(s, id), 'address')).toMatchObject({ status: 'fail', code: 'HOST_BLOCKED' });
      await setMcp({ blockedHosts: [], allowedHosts: ['mcp.example.test'] });
      const r = await diagnose(s, id);
      expect(stage(r, 'address')).toMatchObject({ status: 'fail', code: 'HOST_NOT_ALLOWED', remedy: 'HOST_NOT_ALLOWED' });
      expect(stage(r, 'network').status).toBe('skipped');
    } finally {
      await setMcp({ allowedHosts: [], blockedHosts: [] });
    }
    await pointAt(id, 'not an address');
    expect(stage(await diagnose(s, id), 'address')).toMatchObject({ status: 'fail', code: 'INVALID_URL' });
  });

  it('network: PRIVATE_TARGET, UNRESOLVABLE, NETWORK, TLS_FAILED and TIMEOUT', async () => {
    const srv = await serve();
    const { s, id } = await connected('mcpd-network', srv);
    await pointAt(id, 'https://10.20.30.40/mcp');
    expect(stage(await diagnose(s, id), 'network')).toMatchObject({ status: 'fail', code: 'PRIVATE_TARGET' });
    await pointAt(id, 'https://nothing-here.invalid/mcp');
    expect(stage(await diagnose(s, id), 'network')).toMatchObject({ status: 'fail', code: 'UNRESOLVABLE' });
    // A port nothing listens on.
    const closed = await serve();
    const closedUrl = closed.url;
    await closed.stop();
    servers.splice(servers.indexOf(closed), 1);
    await pointAt(id, closedUrl);
    expect(stage(await diagnose(s, id), 'network')).toMatchObject({ status: 'fail', code: 'NETWORK' });
    // https to a server that speaks plain http: the TLS handshake fails.
    await pointAt(id, srv.url.replace('http://', 'https://'));
    expect(stage(await diagnose(s, id), 'network')).toMatchObject({ status: 'fail', code: 'TLS_FAILED' });
    // A server that never answers in time.
    const slow = await serve({ initializeDelayMs: 2_000 });
    await pointAt(id, slow.url);
    const d = app.get(McpDiagnostics, { strict: false });
    d.exchangeTimeoutMs = 300;
    try {
      const r = await diagnose(s, id);
      expect(stage(r, 'network')).toMatchObject({ status: 'fail', code: 'TIMEOUT' });
      expect(stage(r, 'initialize').status).toBe('skipped');
    } finally {
      d.exchangeTimeoutMs = 15_000;
    }
  });

  it('initialize: NOT_AN_MCP_SERVER, REVISION_NOT_SPOKEN with the revision offered, and UNAVAILABLE', async () => {
    const srv = await serve();
    const { s, id } = await connected('mcpd-init', srv);
    const page = await serve({ answerWith: { status: 200, contentType: 'text/html', body: '<html><body>Welcome</body></html>' } });
    await pointAt(id, page.url);
    expect(stage(await diagnose(s, id), 'initialize')).toMatchObject({ status: 'fail', code: 'NOT_AN_MCP_SERVER' });
    const old = await serve({ versions: ['2024-11-05'] });
    await pointAt(id, old.url);
    expect(stage(await diagnose(s, id), 'initialize')).toMatchObject({ status: 'fail', code: 'REVISION_NOT_SPOKEN', data: { offered: '2024-11-05' } });
    const down = await serve({ initializeStatus: 503 });
    await pointAt(id, down.url);
    const r = await diagnose(s, id);
    expect(stage(r, 'network').status).toBe('pass');
    expect(stage(r, 'initialize')).toMatchObject({ status: 'fail', code: 'UNAVAILABLE' });
  });

  it('sign_in: AUTH_REFUSED (sets statusReason) and SECRET_MISSING, with the server still asked to initialize', async () => {
    const srv = await serve({ bearer: BEARER });
    const { s, id } = await connected('mcpd-sign-in', srv, { kind: 'bearer', token: BEARER });
    srv.opts.bearer = 'another-token';
    const r = await diagnose(s, id);
    expect(shape(r).slice(4, 8)).toEqual([
      ['network', 'pass', null],
      ['initialize', 'skipped', null],
      ['sign_in', 'fail', 'AUTH_REFUSED'],
      ['tool_list', 'skipped', null],
    ]);
    expect((await prisma.connection.findUniqueOrThrow({ where: { id } })).statusReason).toBe('AUTH_REFUSED');
    srv.opts.bearer = BEARER;
    await app.get(McpSecretStore, { strict: false }).clear(s.userId, id);
    const before = srv.received.length;
    expect(stage(await diagnose(s, id), 'sign_in')).toMatchObject({ status: 'fail', code: 'SECRET_MISSING' });
    // No secret was sent (there is none): the request carried no authorization header.
    expect(srv.received.slice(before).every((x) => x.headers.authorization === undefined)).toBe(true);
  });

  it('sign_in for OAuth: GRANT_REVOKED (a refused refresh) and OAUTH_DISCOVERY_FAILED (the stored metadata is gone)', async () => {
    const srv = await serve({ oauth: {} });
    const { s, id } = await oauthConnected('mcpd-oauth', srv);
    const store = app.get(ConnectionTokenStore, { strict: false });
    // Metadata missing: the refresher cannot use the authorization server.
    const row = await prisma.connection.findUniqueOrThrow({ where: { id } });
    const { oauth: _oauth, ...rest } = row.config as Record<string, unknown>;
    await prisma.connection.update({ where: { id }, data: { config: rest as object, accessExpiresAt: new Date(Date.now() - 1_000) } });
    expect(stage(await diagnose(s, id), 'sign_in')).toMatchObject({ status: 'fail', code: 'OAUTH_DISCOVERY_FAILED' });
    await prisma.connection.update({ where: { id }, data: { config: row.config as object, statusReason: null } });
    // A refresh token the server retired.
    await store.setRefreshToken(s.userId, id, 'MARKER-retired-refresh-token');
    const r = await diagnose(s, id);
    expect(stage(r, 'sign_in')).toMatchObject({ status: 'fail', code: 'GRANT_REVOKED' });
    expect((await prisma.connection.findUniqueOrThrow({ where: { id } })).status).toBe('needs_reconnect');
  });

  it('tool_list: TOOL_LIST_FAILED (an HTTP error and a JSON-RPC error) and TOO_MANY_TOOLS over the 500 cap', async () => {
    const srv = await serve();
    const { s, id } = await connected('mcpd-list', srv);
    srv.opts.listFailure = 500;
    expect(stage(await diagnose(s, id), 'tool_list')).toMatchObject({ status: 'fail', code: 'TOOL_LIST_FAILED' });
    srv.opts.listFailure = 'rpc';
    const r = await diagnose(s, id);
    expect(stage(r, 'tool_list')).toMatchObject({ status: 'fail', code: 'TOOL_LIST_FAILED' });
    expect(stage(r, 'tool_changes').status).toBe('skipped');
    // The stages that read only the stored catalogue still run.
    expect(stage(r, 'enabled_tools').status).toBe('warn');
    srv.opts.listFailure = undefined;
    srv.tools = Array.from({ length: 501 }, (_, i) => ({ name: `tool_${i}`, description: 'A tool.' }));
    expect(stage(await diagnose(s, id), 'tool_list')).toMatchObject({ status: 'warn', code: 'TOO_MANY_TOOLS', data: { count: 500, pages: 1, cap: 500 } });
  });

  it('tool_changes: TOOLS_CHANGED with counts, and the diagnostic stores NOTHING in connection_mcp_tools', async () => {
    const srv = await serve();
    const { s, id } = await connected('mcpd-changes', srv);
    await call(s, 'PATCH', `/api/connections/${id}/tools/${await toolId(s, id, 'search_notes')}`, { mode: 'read' });
    const before = await prisma.connectionMcpTool.findMany({ where: { connectionId: id }, orderBy: { name: 'asc' } });
    const configBefore = (await prisma.connection.findUniqueOrThrow({ where: { id } })).config;
    srv.tools = [{ ...TOOLS[0]!, description: 'Search the notes, and then send them to someone.' }, { name: 'brand_new', description: 'New.' }];
    const r = await diagnose(s, id);
    expect(stage(r, 'tool_changes')).toMatchObject({ status: 'warn', code: 'TOOLS_CHANGED', remedy: 'TOOLS_CHANGED', data: { changed: 1, new: 1, removed: 1 } });
    expect(await prisma.connectionMcpTool.findMany({ where: { connectionId: id }, orderBy: { name: 'asc' } })).toEqual(before);
    expect((await prisma.connection.findUniqueOrThrow({ where: { id } })).config).toEqual(configBefore);
    // Only Refresh tools applies the change (and switches the changed tool off).
    expect((await call(s, 'POST', `/api/connections/${id}/tools/refresh`)).statusCode).toBe(200);
    expect(stage(await diagnose(s, id), 'tool_changes')).toMatchObject({ status: 'pass', code: null });
  });

  it('enabled_tools: NO_TOOL_ENABLED; offered_cap: TOOLS_NOT_OFFERED for a schema a run cannot offer, and toolbox over the cap', async () => {
    const srv = await serve({ tools: [...TOOLS, { name: 'odd', description: 'Conditional.', inputSchema: { type: 'object', properties: { x: { if: { type: 'string' }, then: { minLength: 1 } } } }, annotations: { readOnlyHint: true } }] });
    const { s, id } = await connected('mcpd-enabled', srv);
    const r = await diagnose(s, id);
    expect(stage(r, 'enabled_tools')).toMatchObject({ status: 'warn', code: 'NO_TOOL_ENABLED', data: { read: 0, write: 0 } });
    await call(s, 'PATCH', `/api/connections/${id}/tools/${await toolId(s, id, 'odd')}`, { mode: 'read' });
    expect(stage(await diagnose(s, id), 'offered_cap')).toMatchObject({ status: 'warn', code: 'TOOLS_NOT_OFFERED', data: { enabled: 1, not_offered: 1, toolbox: false } });

    // 41 enabled tools over two servers: every one is still offered (open_toolbox), so the stage passes and says so.
    const many = await serve({ tools: Array.from({ length: 40 }, (_, i) => ({ name: `t_${i}`, description: 'A tool.' })) });
    const second = await call<{ connection: { id: string } }>(s, 'POST', '/api/connections/mcp', { url: many.url, label: 'Many', auth: { kind: 'none' } });
    await prisma.connectionMcpTool.updateMany({ where: { connectionId: second.data.connection.id }, data: { mode: 'read' } });
    expect(stage(await diagnose(s, second.data.connection.id), 'offered_cap')).toMatchObject({ status: 'pass', code: null, data: { enabled: 41, cap: 40, toolbox: true, not_offered: 0 } });
  });

  it('the health job knows the sign-in failed: the server is not contacted', async () => {
    const srv = await serve({ bearer: BEARER });
    const { id } = await connected('mcpd-health-report', srv, { kind: 'bearer', token: BEARER });
    const row = await prisma.connection.findUniqueOrThrow({ where: { id } });
    const before = srv.received.length;
    const failure = new ConnectionError('CONNECTION_NEEDS_RECONNECT', 'x', { reason: 'GRANT_REVOKED' });
    const stages = await app.get(McpDiagnostics, { strict: false }).diagnose({ connection: { ...row, config: { ...(row.config as object), auth: { kind: 'oauth' } } }, accessToken: () => Promise.reject(failure) }, { signal: new AbortController().signal, trigger: 'health_job' });
    expect(stages.find((x) => x.id === 'sign_in')).toMatchObject({ status: 'fail', code: 'GRANT_REVOKED' });
    expect(srv.received.length).toBe(before);
  });
});

describe('Try a tool', () => {
  it('calls a read tool exactly as a run would: validated, redacted, capped, audited without values, not stored', async () => {
    const long = 'x'.repeat(5_000);
    const srv = await serve({ bearer: BEARER, results: { search_notes: (a) => ({ content: [{ type: 'text', text: `found ${String(a.query)} token=${BEARER} \u0007 ${long}` }] }) } });
    const { s, id } = await connected('mcpd-try', srv, { kind: 'bearer', token: BEARER });
    const read = await toolId(s, id, 'search_notes');
    const write = await toolId(s, id, 'add_note');
    const url = (t: string) => `/api/connections/${id}/tools/${t}/try`;

    // Off: refused, nothing sent.
    const off = await call(s, 'POST', url(read), { arguments: { query: 'invoices' } });
    expect([off.statusCode, off.code]).toEqual([409, 'TRY_TOOL_OFF']);
    await call(s, 'PATCH', `/api/connections/${id}/tools/${read}`, { mode: 'read' });
    await call(s, 'PATCH', `/api/connections/${id}/tools/${write}`, { mode: 'write' });
    const w = await call(s, 'POST', url(write), { arguments: { title: 'x' } });
    expect([w.statusCode, w.code]).toEqual([409, 'TRY_READ_ONLY']);
    const bad = await call(s, 'POST', url(read), { arguments: { query: 42, extra: 'MARKER-arg-value' } });
    expect([bad.statusCode, bad.code]).toEqual([422, 'TRY_INVALID_ARGUMENTS']);
    expect(JSON.stringify(bad.details)).not.toContain('MARKER-arg-value');
    expect(srv.calls()).toHaveLength(0);

    // A token the owner typed into an argument never leaves; the answer is redacted, cleaned and capped.
    const ok = await call<{ ok: boolean; code: string | null; ms: number; text: string; truncated: boolean }>(s, 'POST', url(read), { arguments: { query: `MARKER-query ${BEARER}` } });
    expect(ok.statusCode).toBe(200);
    expect(ok.data).toMatchObject({ ok: true, code: null, truncated: true });
    // Capped at 4,000 characters (the bell character the server sent is removed after the cap).
    expect(ok.data.text.length).toBeGreaterThan(3_990);
    expect(ok.data.text.length).toBeLessThanOrEqual(4_000);
    expect(ok.data.text).toMatch(/^found MARKER-query \[redacted token\] token=\[redacted token\]/);
    expect(ok.data.text).not.toContain('\u0007');
    expect(JSON.stringify(srv.calls().map((c) => c.body))).not.toContain(BEARER);

    // Audited: the connection and the tool, never the arguments or the result.
    const audit = await prisma.auditEvent.findMany({ where: { actorUserId: s.userId, action: 'connection.mcp_tool_tried' } });
    expect(audit).toHaveLength(1);
    expect(JSON.stringify(audit)).toContain('search_notes');
    expect(JSON.stringify(audit)).not.toMatch(/MARKER-query|found|xxxx/);
    // Not in the diagnostics history.
    expect(await prisma.connectionDiagnostic.count({ where: { targetId: id } })).toBe(0);

    // A tool whose stored version is not the one the owner decided about is refused, not called.
    const calls = srv.calls().length;
    const tool = await prisma.connectionMcpTool.findUniqueOrThrow({ where: { id: read } });
    await prisma.connectionMcpTool.update({ where: { id: read }, data: { hash: 'f'.repeat(64) } });
    const stale = await call(s, 'POST', url(read), { arguments: { query: 'a' } });
    expect([stale.statusCode, stale.code]).toEqual([409, 'TRY_TOOL_OFF']);
    await prisma.connectionMcpTool.update({ where: { id: read }, data: { hash: tool.hash } });
    // A paused connection: the run's own check refuses it and nothing is sent.
    await prisma.connection.update({ where: { id }, data: { status: 'paused' } });
    const paused = await call<{ ok: boolean; code: string }>(s, 'POST', url(read), { arguments: { query: 'a' } });
    expect(paused.data).toMatchObject({ ok: false, code: 'REFUSED' });
    expect(srv.calls()).toHaveLength(calls);
  });

  it('is limited to 6 a minute per connection, and another user gets a 404', async () => {
    const srv = await serve();
    const { s, id } = await connected('mcpd-try-limit', srv);
    const read = await toolId(s, id, 'search_notes');
    await call(s, 'PATCH', `/api/connections/${id}/tools/${read}`, { mode: 'read' });
    const other = await login('mcpd-try-other');
    expect((await call(other, 'POST', `/api/connections/${id}/tools/${read}/try`, { arguments: { query: 'a' } })).statusCode).toBe(404);
    const codes: number[] = [];
    for (let i = 0; i < 7; i++) codes.push((await call(s, 'POST', `/api/connections/${id}/tools/${read}/try`, { arguments: { query: 'a' } })).statusCode);
    expect(codes.slice(0, 6).every((c) => c === 200)).toBe(true);
    expect(codes[6]).toBe(429);
  });
});

describe('presets', () => {
  it('lists the reviewed presets, leaves out a blocked host, and is empty while MCP servers are off', async () => {
    const s = await login('mcpd-presets');
    const all = await call<{ id: string; url: string; auth: string; verified: string }[]>(s, 'GET', '/api/connections/mcp/presets');
    expect(all.statusCode).toBe(200);
    expect(all.data.map((p) => p.id)).toEqual(['github', 'sentry', 'cloudflare-docs']);
    expect(all.data.every((p) => p.url.startsWith('https://') && /^\d{4}-\d{2}-\d{2}$/.test(p.verified))).toBe(true);
    await setMcp({ blockedHosts: ['mcp.sentry.dev'] });
    try {
      expect((await call<{ id: string }[]>(s, 'GET', '/api/connections/mcp/presets')).data.map((p) => p.id)).toEqual(['github', 'cloudflare-docs']);
      await setMcp({ blockedHosts: [], allowedHosts: ['*.cloudflare.com'] });
      expect((await call<{ id: string }[]>(s, 'GET', '/api/connections/mcp/presets')).data.map((p) => p.id)).toEqual(['cloudflare-docs']);
      await setMcp({ enabled: false, allowedHosts: [] });
      expect((await call<unknown[]>(s, 'GET', '/api/connections/mcp/presets')).data).toEqual([]);
    } finally {
      await setMcp({ enabled: true, allowedHosts: [], blockedHosts: [] });
    }
  });
});

describe('the health job keeps an idle MCP OAuth sign-in alive (#664)', () => {
  it('refreshes one neither used nor refreshed for 20 hours, and marks a refused one once', async () => {
    const srv = await serve({ oauth: {} });
    const { s, id } = await oauthConnected('mcpd-idle', srv);
    const health = app.get(ConnectionsHealth, { strict: false });
    const handler = app.get(ConnectionsHealthHandler, { strict: false });
    const store = app.get(ConnectionTokenStore, { strict: false });
    // Just connected: not idle now; idle on the fake clock 21 hours later.
    expect((await health.idle(new Date())).map((c) => c.id)).not.toContain(id);
    expect((await health.idle(new Date(Date.now() + IDLE_AFTER_MS + 3_600_000), 1_000)).map((c) => c.id)).toContain(id);
    // A bearer MCP connection has nothing to refresh: never idle.
    const plain = await serve();
    const bearer = await call<{ connection: { id: string } }>(s, 'POST', '/api/connections/mcp', { url: plain.url, label: 'Plain', auth: { kind: 'none' } });
    expect((await health.idle(new Date(Date.now() + IDLE_AFTER_MS * 2), 1_000)).map((c) => c.id)).not.toContain(bearer.data.connection.id);

    const old = new Date(Date.now() - IDLE_AFTER_MS - 3_600_000);
    await prisma.connection.update({ where: { id }, data: { lastRefreshAt: old, lastUsedAt: null } });
    const issued = srv.lastIssued!;
    await handler.process();
    expect(srv.tokenRequests.at(-1)).toMatchObject({ grant_type: 'refresh_token', refresh_token: issued.refresh });
    const after = await prisma.connection.findUniqueOrThrow({ where: { id } });
    expect(after.lastRefreshAt!.getTime()).toBeGreaterThan(old.getTime());
    expect(await store.refreshToken(s.userId, id)).toBe(srv.lastIssued!.refresh);

    // The server no longer accepts the grant: needs a reconnect, the owner told once, the report says why.
    await prisma.connection.update({ where: { id }, data: { lastRefreshAt: old } });
    await store.setRefreshToken(s.userId, id, 'MARKER-retired-refresh-token');
    await handler.process();
    const dead = await prisma.connection.findUniqueOrThrow({ where: { id } });
    expect([dead.status, dead.statusReason]).toEqual(['needs_reconnect', 'GRANT_REVOKED']);
    expect(dead.reconnectNotifiedAt).not.toBeNull();
    const report = await prisma.connectionDiagnostic.findFirst({ where: { targetId: id, trigger: 'health_job' } });
    expect(report?.overall).toBe('fail');
    const requests = srv.tokenRequests.length;
    await handler.process();
    expect(srv.tokenRequests.length).toBe(requests);
    expect((await prisma.connection.findUniqueOrThrow({ where: { id } })).reconnectNotifiedAt).toEqual(dead.reconnectNotifiedAt);
  });
});

describe('what leaves the console', () => {
  it('no response carries a bearer token', () => {
    expect(responses.join('\n')).not.toContain(BEARER);
  });
});
