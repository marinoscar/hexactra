// The MCP endpoint as an OAuth protected resource (E33.1, #459), against a
// real database: a scripted client that knows only `<APP_URL>/api/mcp`
// discovers the console's authorization server from the 401, sends a user
// through consent, gets a scoped `oat_` token and uses it on /api/mcp. Tools
// call the REST routes through the platform's in-process delegation, as the
// same NARROWED principal: what the token's scopes do not grant, the REST
// route behind the tool refuses. Revoking the grant ends it on the next call.
//
// The root `/.well-known/...` paths are nginx's (infra/nginx/app.d/locations/
// oauth-server.conf); this client applies the same rewrite to reach the API.
import { randomUUID } from 'node:crypto';
import { writeFileSync } from 'node:fs';
import { ConsoleLogger, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import { OAuthServerSettingsReader } from '@marinoscar/platform-api/identity';
import { checkOAuthSecretEgress, createOAuthTestClient, mintOAuthTestToken, pkcePair, type OAuthTestClient } from '@marinoscar/platform-api/identity/testing';
import { SystemSettingsService } from '@marinoscar/platform-api/settings';

import { FabricClient } from '../src/fabric/fabric.client';
import { createApp } from '../src/main';
import { FORBIDDEN_TOOL_TEXT, McpDispatcher, STEP_UP_NOTE } from '../src/mcp/mcp.dispatcher';
import { rpcResult } from '../src/mcp/mcp.results';
import { MCP_TOOLS } from '../src/mcp/mcp.tools';
import { MCP_DOCS_URL, MCP_SCOPES } from '../src/mcp/mcp.scopes';
import { PrismaService } from '../src/prisma/prisma.service';

let app: NestFastifyApplication;
let prisma: PrismaService;
let appUrl: string;
let session: string;
let userId: string;
let client: OAuthTestClient;
const run = randomUUID().slice(0, 8);
const suiteStart = new Date();
const CLIENT_HOST = `mcp-oauth-${run}.example.test`;

// What the secret-egress check reads (the conformance suite's tenth check).
const logLines: string[] = [];
const secrets: string[] = [];
const responses: unknown[] = [];

// No job worker: run_goal creates a run, and a worker would keep driving it after the app closes.
const workerMode = process.env.JOBS_WORKER_MODE;

async function setOAuthSettings(patch: Record<string, unknown>) {
  await app.get(SystemSettingsService).patchSettings({ oauthServer: patch } as never, userId);
  app.get(OAuthServerSettingsReader).invalidate();
}

beforeAll(async () => {
  process.env.JOBS_WORKER_MODE = 'off';
  app = await createApp();
  await app.init();
  await app.getHttpAdapter().getInstance().ready();
  if (workerMode === undefined) delete process.env.JOBS_WORKER_MODE;
  else process.env.JOBS_WORKER_MODE = workerMode;
  const record = (level: string) => (...args: unknown[]) => void logLines.push(`${level} ${args.map((a) => (typeof a === 'string' ? a : JSON.stringify(a))).join(' ')}`);
  Logger.overrideLogger({ log: record('log'), error: record('error'), warn: record('warn'), debug: record('debug'), verbose: record('verbose'), fatal: record('fatal') });

  prisma = app.get(PrismaService);
  appUrl = app.get(ConfigService).get<string>('appUrl')!.replace(/\/+$/, '');
  const email = `mcp-oauth-${run}@example.test`;
  const login = await app.inject({ method: 'POST', url: '/api/auth/test/login', payload: { email, role: 'contributor' } });
  session = new URL(String(login.headers.location)).searchParams.get('token')!;
  secrets.push(session);
  // The test-only login (never mounted in production) logs its redirect URL, session token included:
  // the evidence starts after it, and the session token stays a secret no later line may carry.
  logLines.length = 0;
  userId = (await prisma.user.findUniqueOrThrow({ where: { email }, select: { id: true } })).id;
  client = await createOAuthTestClient(prisma as never, { name: 'Scripted MCP client', redirectUris: [`https://${CLIENT_HOST}/callback`], host: CLIENT_HOST, tokenEndpointAuthMethod: 'none' });
  await setOAuthSettings({ enabled: true, allowedClientHosts: [CLIENT_HOST], allowAnyClientHost: false });
}, 120_000);

afterAll(async () => {
  try {
    if (app) await setOAuthSettings({ enabled: false, allowedClientHosts: [] });
  } finally {
    Logger.overrideLogger(new ConsoleLogger());
    await prisma?.oAuthClient.deleteMany({ where: { id: client?.id } });
    await app?.close();
  }
});

/** Parses `Bearer a="b", c="d"`. */
function challengeOf(header: unknown): Record<string, string> {
  const out: Record<string, string> = {};
  for (const m of String(header ?? '').matchAll(/([a-z_]+)="([^"]*)"/g)) out[m[1]!] = m[2]!;
  return out;
}

const pathOf = (url: string) => new URL(url).pathname;

/** What nginx does for the root well-known paths. */
function apiPathOfWellKnown(url: string): string {
  const path = pathOf(url);
  if (path.startsWith('/.well-known/oauth-protected-resource')) return `/api/oauth/.well-known/protected-resource${path.slice('/.well-known/oauth-protected-resource'.length)}`;
  if (path.startsWith('/.well-known/oauth-authorization-server')) return '/api/oauth/.well-known/authorization-server';
  throw new Error(`not a well-known path: ${path}`);
}

async function rpc(authorization: string | null, body: unknown) {
  const res = await app.inject({
    method: 'POST',
    url: '/api/mcp',
    headers: { ...(authorization ? { authorization } : {}), 'content-type': 'application/json', accept: 'application/json, text/event-stream', 'mcp-protocol-version': '2025-06-18' },
    payload: JSON.stringify(body),
  });
  return { status: res.statusCode, headers: res.headers, json: res.body ? JSON.parse(res.body) : null };
}

async function callTool(token: string, name: string, args: Record<string, unknown>) {
  const r = await rpc(`Bearer ${token}`, { jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args } });
  expect(r.status).toBe(200);
  return r.json.result as { isError?: boolean; content: Array<{ type: string; text: string }>; structuredContent?: Record<string, unknown> };
}

/** Steps 1 to 3 of a hosted client: the 401, the resource metadata, the authorization server metadata. */
async function discover() {
  const unauthorized = await rpc(null, { jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'scripted', version: '0' } } });
  expect(unauthorized.status).toBe(401);
  expect(String(unauthorized.headers['www-authenticate'])).toMatch(/^Bearer /);
  const challenge = challengeOf(unauthorized.headers['www-authenticate']);
  expect(challenge.resource_metadata).toBe(`${appUrl}/.well-known/oauth-protected-resource/api/mcp`);
  expect(challenge.error).toBeUndefined(); // no credential was presented

  const prmRes = await app.inject({ method: 'GET', url: apiPathOfWellKnown(challenge.resource_metadata!) });
  expect(prmRes.statusCode).toBe(200);
  const prm = prmRes.json();
  expect(prm).toMatchObject({ resource: `${appUrl}/api/mcp`, resource_name: 'Hexactra agent tools', resource_documentation: MCP_DOCS_URL, bearer_methods_supported: ['header'] });
  // A feature-gated scope (the Knowledge Graph's) is offered only while its feature is on, and it is off here (#916).
  const offered = MCP_SCOPES.filter((s) => !s.feature).map((s) => s.id);
  expect([...prm.scopes_supported].sort()).toEqual([...offered, 'offline_access'].sort());
  const issuer: string = prm.authorization_servers[0];

  const asRes = await app.inject({ method: 'GET', url: apiPathOfWellKnown(`${issuer}/.well-known/oauth-authorization-server`) });
  expect(asRes.statusCode).toBe(200);
  const as = asRes.json();
  expect(as.issuer).toBe(issuer);
  expect(as.code_challenge_methods_supported).toEqual(['S256']);
  return { prm, as, issuer };
}

type Discovered = Awaited<ReturnType<typeof discover>>;

/** authorize -> consent read -> approve -> code -> token, as the signed-in test user. */
async function connect(found: Discovered, scope: string | null) {
  const pkce = pkcePair();
  const state = `s-${randomUUID().slice(0, 8)}`;
  const query = new URLSearchParams({
    response_type: 'code',
    client_id: client.clientId,
    redirect_uri: client.redirectUri,
    state,
    code_challenge: pkce.challenge,
    code_challenge_method: 'S256',
    resource: found.prm.resource,
    ...(scope !== null ? { scope } : {}),
  });
  const authorized = await app.inject({ method: 'GET', url: `${pathOf(found.as.authorization_endpoint)}?${query}` });
  expect(authorized.statusCode).toBe(302);
  const consentUrl = new URL(String(authorized.headers.location));
  expect(`${consentUrl.origin}${consentUrl.pathname}`).toBe(`${appUrl}/oauth/consent`);
  const requestId = consentUrl.searchParams.get('request')!;

  const auth = { authorization: `Bearer ${session}` };
  const consent = await app.inject({ method: 'GET', url: `/api/oauth/requests/${requestId}`, headers: auth });
  expect(consent.statusCode).toBe(200);
  const decision = await app.inject({ method: 'POST', url: `/api/oauth/requests/${requestId}/decision`, headers: { ...auth, 'content-type': 'application/json' }, payload: JSON.stringify({ decision: 'approve' }) });
  expect(decision.statusCode).toBe(200);
  const back = new URL(decision.json().data.redirectTo);
  expect(back.searchParams.get('state')).toBe(state);
  expect(back.searchParams.get('iss')).toBe(found.issuer);
  const code = back.searchParams.get('code')!;

  const token = await app.inject({
    method: 'POST',
    url: pathOf(found.as.token_endpoint),
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    payload: new URLSearchParams({ grant_type: 'authorization_code', client_id: client.clientId, code, redirect_uri: client.redirectUri, code_verifier: pkce.verifier }).toString(),
  });
  expect(token.statusCode).toBe(200);
  const body = token.json() as { access_token: string; refresh_token?: string; scope: string; token_type: string };
  expect(body.token_type).toBe('Bearer');
  expect(body.access_token).toMatch(/^oat_/);
  secrets.push(code, pkce.verifier, body.access_token, ...(body.refresh_token ? [body.refresh_token] : []));
  return { consent: consent.json().data, token: body };
}

describe('the MCP endpoint as an OAuth protected resource (#459)', () => {
  it('a client that knows only /api/mcp discovers, gets consent, and calls the tools with its oat_ token', async () => {
    const found = await discover();
    // No scope requested: the resource's default scopes (the low-risk five) and the consent page shows the console's titles.
    const { consent, token } = await connect(found, null);
    const defaults = MCP_SCOPES.filter((s) => s.default).map((s) => s.id);
    expect(token.scope.split(' ').filter((s) => s !== 'offline_access').sort()).toEqual([...defaults].sort());
    const shown = JSON.stringify(consent);
    for (const s of MCP_SCOPES.filter((x) => x.default)) expect(shown).toContain(s.title);

    const auth = `Bearer ${token.access_token}`;
    const init = await rpc(auth, { jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'scripted', version: '0' } } });
    expect(init.status).toBe(200);
    expect(init.json.result).toMatchObject({ serverInfo: { name: 'hexactra-console' } });
    const list = await rpc(auth, { jsonrpc: '2.0', id: 2, method: 'tools/list' });
    expect(list.status).toBe(200);
    expect(list.json.result.tools.map((t: { name: string }) => t.name)).toEqual(expect.arrayContaining(['run_goal', 'tasks_list', 'inbox_list']));

    // A tool's REST sub-request runs as the caller through the delegation (never the oat_ header):
    // tasks_list calls GET /api/tasks (tasks:read, granted by runs:read) and succeeds.
    const tasks = await callTool(token.access_token, 'tasks_list', {});
    expect(tasks.isError).toBeFalsy();
    // The granted scopes reach the tools (the tasks card hides what the connection cannot do).
    expect(tasks.structuredContent?.granted_scopes).toEqual(defaults);

    // The same token outside its resource: confined to /api/mcp.
    const outside = await app.inject({ method: 'GET', url: '/api/tasks', headers: { authorization: auth } });
    expect(outside.statusCode).toBe(403);

    // A bad token on the resource: 401 with the challenge and invalid_token.
    const bad = await rpc('Bearer oat_not-a-real-token', { jsonrpc: '2.0', id: 3, method: 'tools/list' });
    expect(bad.status).toBe(401);
    expect(challengeOf(bad.headers['www-authenticate'])).toMatchObject({ error: 'invalid_token', resource_metadata: `${appUrl}/.well-known/oauth-protected-resource/api/mcp` });

    // Connected apps lists the grant; disconnecting it ends the token on its next call.
    const grants = await app.inject({ method: 'GET', url: '/api/oauth/grants', headers: { authorization: `Bearer ${session}` } });
    expect(grants.statusCode).toBe(200);
    responses.push(grants.json());
    const grant = await prisma.oAuthGrant.findFirstOrThrow({ where: { userId, clientId: client.id, revokedAt: null } });
    const revoked = await app.inject({ method: 'DELETE', url: `/api/oauth/grants/${grant.id}`, headers: { authorization: `Bearer ${session}` } });
    expect(revoked.statusCode).toBe(204);
    const after = await rpc(auth, { jsonrpc: '2.0', id: 4, method: 'tools/list' });
    expect(after.status).toBe(401);
    expect(challengeOf(after.headers['www-authenticate'])).toMatchObject({ error: 'invalid_token', resource_metadata: `${appUrl}/.well-known/oauth-protected-resource/api/mcp` });
  }, 60_000);

  it('carries the narrowing into the tools: with runs:read runs:write, run_goal works and task_create is refused', async () => {
    const found = await discover();
    const { token } = await connect(found, 'runs:read runs:write');
    expect(token.scope.split(' ').filter((s) => s !== 'offline_access').sort()).toEqual(['runs:read', 'runs:write']);

    const goal = `OAuth run ${run}`;
    const started = await callTool(token.access_token, 'run_goal', { goal, wait_s: 0 });
    expect(started.isError).toBeFalsy();
    const created = await prisma.run.findFirst({ where: { userId, goal } });
    expect(created).not.toBeNull();

    // task_create needs tasks:write: the user holds the permission, the token's scopes do not grant it,
    // so the call is a step-up (#460): HTTP 403 insufficient_scope, and nothing is created.
    const refused = await rpc(`Bearer ${token.access_token}`, { jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'task_create', arguments: { name: `OAuth ${run}`, goal: 'Not allowed' } } });
    expect(refused.status).toBe(403);
    expect(challengeOf(refused.headers['www-authenticate'])).toMatchObject({ error: 'insufficient_scope' });
    expect(challengeOf(refused.headers['www-authenticate']).scope!.split(' ')).toEqual(expect.arrayContaining(['runs:read', 'runs:write', 'tasks:write']));
    expect(await prisma.task.count({ where: { userId, name: `OAuth ${run}` } })).toBe(0);

    // The same user's session still may (the narrowing is the token's, not the user's).
    const own = await app.inject({ method: 'POST', url: '/api/tasks', headers: { authorization: `Bearer ${session}`, 'content-type': 'application/json' }, payload: JSON.stringify({ name: `Session ${run}`, goal: 'Allowed' }) });
    expect(own.statusCode).toBe(201);

    const grant = await prisma.oAuthGrant.findFirstOrThrow({ where: { userId, clientId: client.id, revokedAt: null } });
    await app.inject({ method: 'DELETE', url: `/api/oauth/grants/${grant.id}`, headers: { authorization: `Bearer ${session}` } });
  }, 60_000);

  // --- E33.2 (#460): scope-gated tools, step-up and the finer line inside runs:write ---------------

  /** A minted `oat_` token for `user` with exactly `scopes` (the platform test kit). */
  async function mint(scopes: readonly string[], user = userId): Promise<string> {
    // One active grant per user and client (oauth_grants_active_uniq_idx): end the previous one first.
    await prisma.oAuthGrant.updateMany({ where: { userId: user, clientId: client.id, revokedAt: null }, data: { revokedAt: new Date() } });
    const minted = await mintOAuthTestToken(prisma as never, { userId: user, resourceId: 'mcp', scopes, appUrl, client: { id: client.id } });
    secrets.push(minted.token);
    return minted.token;
  }

  const DEFAULTS = MCP_SCOPES.filter((s) => s.default).map((s) => s.id);
  const toolsOf = async (token: string) => {
    const r = await rpc(`Bearer ${token}`, { jsonrpc: '2.0', id: 1, method: 'tools/list' });
    expect(r.status).toBe(200);
    return r.json.result.tools as Array<{ name: string; description: string; securitySchemes: Array<{ type: string; scopes: string[] }> }>;
  };
  const callRaw = (token: string, name: string, args: Record<string, unknown> = {}) => rpc(`Bearer ${token}`, { jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args } });

  /** A fabric that opens sessions and runs every action (no browser machine in CI). */
  function mockFabric() {
    return jest.spyOn(app.get(FabricClient), 'request').mockImplementation((async (method: string, path: string) => {
      if (method === 'POST' && path === '/v1/sessions') return { id: randomUUID() };
      if (method === 'POST' && path.endsWith('/actions')) return { id: randomUUID(), state: 'succeeded', result: { value: 42 } };
      if (method === 'DELETE') return undefined;
      throw new Error(`unexpected ${method} ${path}`);
    }) as never);
  }

  it('default consent: tools/list offers the delegate tools, lists browser, JavaScript, desktop and policy writes as step-up, in a stable order', async () => {
    const token = await mint(DEFAULTS);
    const tools = await toolsOf(token);
    const stepUp = tools.filter((t) => t.description.endsWith(STEP_UP_NOTE)).map((t) => t.name);
    const callable = tools.filter((t) => !t.description.endsWith(STEP_UP_NOTE)).map((t) => t.name);
    expect(callable).toEqual(expect.arrayContaining(['run_goal', 'run_wait', 'run_status', 'runs_list', 'task_create', 'task_run', 'tasks_list', 'inbox_list', 'inbox_answer', 'ask_human', 'policies_list', 'hosts_list']));
    expect(callable.filter((n) => n.startsWith('browser_'))).toEqual([]);
    expect(stepUp).toEqual(expect.arrayContaining(['browser_open', 'browser_click', 'browser_evaluate', 'browser_desktop_click', 'policy_create', 'policy_update', 'policy_set_default', 'policies_import']));
    // Every tool says which scopes it needs (ChatGPT's per-tool securitySchemes), from the registry.
    for (const t of tools) expect([t.name, t.securitySchemes]).toEqual([t.name, [{ type: 'oauth2', scopes: expect.arrayContaining([MCP_TOOLS.find((x) => x.name === t.name)!.scope]) }]]);
    expect(tools.find((t) => t.name === 'browser_evaluate')!.securitySchemes[0]!.scopes).toEqual(['browser:evaluate', 'browser:drive']);
    // The registry's order, and the same list on the next call.
    const order = MCP_TOOLS.map((t) => t.name);
    expect(tools.map((t) => t.name)).toEqual(order.filter((n) => tools.some((t) => t.name === n)));
    expect((await toolsOf(token)).map((t) => t.name)).toEqual(tools.map((t) => t.name));
    // The instructions say nothing about driving a browser.
    const init = await rpc(`Bearer ${token}`, { jsonrpc: '2.0', id: 2, method: 'initialize', params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'scripted', version: '0' } } });
    expect(init.json.result.instructions).not.toMatch(/browser_|full authority/);

    // mcp.advertiseStepUpTools off: the step-up tools are not listed at all.
    await app.get(SystemSettingsService).patchSettings({ mcp: { advertiseStepUpTools: false } } as never, userId);
    try {
      const only = await toolsOf(token);
      expect(only.map((t) => t.name).filter((n) => n.startsWith('browser_') || ['policy_create', 'policy_update', 'policy_set_default', 'policies_import'].includes(n))).toEqual([]);
      expect(only.some((t) => t.description.endsWith(STEP_UP_NOTE))).toBe(false);
    } finally {
      await app.get(SystemSettingsService).patchSettings({ mcp: { advertiseStepUpTools: true } } as never, userId);
    }
  }, 60_000);

  it('browser_open with the default consent: HTTP 403 insufficient_scope naming every granted scope plus browser:drive; nothing reaches the fabric', async () => {
    const found = await discover();
    const { token } = await connect(found, null);
    const granted = token.scope.split(' ');
    const fabric = mockFabric();
    try {
      const goal = `Step-up ${run}`;
      const res = await app.inject({
        method: 'POST',
        url: '/api/mcp',
        headers: { authorization: `Bearer ${token.access_token}`, 'content-type': 'application/json', accept: 'application/json, text/event-stream', 'mcp-protocol-version': '2025-06-18' },
        payload: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'browser_open', arguments: { goal } } }),
      });
      if (process.env.MCP_STEP_UP_EVIDENCE) {
        const headers = Object.entries(res.headers).map(([k, v]) => `${k}: ${String(v)}`).join('\n');
        writeFileSync(process.env.MCP_STEP_UP_EVIDENCE, `HTTP/1.1 ${res.statusCode} ${res.statusMessage}\n${headers}\n\n${res.body}\n`);
      }
      expect(res.statusCode).toBe(403);
      const challenge = challengeOf(res.headers['www-authenticate']);
      expect(challenge).toMatchObject({ error: 'insufficient_scope', resource_metadata: `${appUrl}/.well-known/oauth-protected-resource/api/mcp` });
      expect(challenge.scope!.split(' ').sort()).toEqual([...new Set([...granted, 'browser:drive'])].sort());
      expect(res.json()).toMatchObject({ error: 'insufficient_scope', error_description: expect.stringContaining('browser:drive') });
      expect(fabric).not.toHaveBeenCalled();
      expect(await prisma.run.count({ where: { userId, goal } })).toBe(0);

      // A batch (2025-03-26) mixing an allowed call and the step-up call is refused as a whole.
      const batch = await app.inject({
        method: 'POST',
        url: '/api/mcp',
        headers: { authorization: `Bearer ${token.access_token}`, 'content-type': 'application/json', accept: 'application/json', 'mcp-protocol-version': '2025-03-26' },
        payload: JSON.stringify([
          { jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'runs_list', arguments: {} } },
          { jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'browser_open', arguments: { goal } } },
        ]),
      });
      expect(batch.statusCode).toBe(403);
      expect(challengeOf(batch.headers['www-authenticate']).error).toBe('insufficient_scope');

      // Step-up: the client re-authorizes with the challenge's scopes; the consent shows only browser:drive as new.
      const pkce = pkcePair();
      const query = new URLSearchParams({ response_type: 'code', client_id: client.clientId, redirect_uri: client.redirectUri, state: 'up', code_challenge: pkce.challenge, code_challenge_method: 'S256', resource: found.prm.resource, scope: challenge.scope! });
      const authorized = await app.inject({ method: 'GET', url: `${pathOf(found.as.authorization_endpoint)}?${query}` });
      const requestId = new URL(String(authorized.headers.location)).searchParams.get('request')!;
      const consent = (await app.inject({ method: 'GET', url: `/api/oauth/requests/${requestId}`, headers: { authorization: `Bearer ${session}` } })).json().data as { scopes: Array<{ id: string; alreadyGranted: boolean }> };
      expect(consent.scopes.filter((s) => !s.alreadyGranted).map((s) => s.id)).toEqual(['browser:drive']);
      expect(consent.scopes.filter((s) => s.alreadyGranted).map((s) => s.id).sort()).toEqual(granted.filter((s) => s !== 'offline_access').sort());
      const decision = await app.inject({ method: 'POST', url: `/api/oauth/requests/${requestId}/decision`, headers: { authorization: `Bearer ${session}`, 'content-type': 'application/json' }, payload: JSON.stringify({ decision: 'approve' }) });
      const code = new URL(decision.json().data.redirectTo).searchParams.get('code')!;
      const exchanged = await app.inject({
        method: 'POST',
        url: pathOf(found.as.token_endpoint),
        headers: { 'content-type': 'application/x-www-form-urlencoded' },
        payload: new URLSearchParams({ grant_type: 'authorization_code', client_id: client.clientId, code, redirect_uri: client.redirectUri, code_verifier: pkce.verifier }).toString(),
      });
      expect(exchanged.statusCode).toBe(200);
      const wider = exchanged.json() as { access_token: string; refresh_token?: string; scope: string };
      secrets.push(code, pkce.verifier, wider.access_token, ...(wider.refresh_token ? [wider.refresh_token] : []));
      expect(wider.scope.split(' ').sort()).toEqual([...new Set([...granted, 'browser:drive'])].sort());
      const grant = await prisma.oAuthGrant.findFirstOrThrow({ where: { userId, clientId: client.id, revokedAt: null } });
      expect([...grant.scopes].sort()).toEqual([...new Set([...granted, 'browser:drive'])].sort());

      // The same call now works.
      const opened = await callTool(wider.access_token, 'browser_open', { goal });
      expect(opened.isError).toBeFalsy();
      expect(opened.structuredContent).toMatchObject({ session_id: expect.any(String) });
      expect(fabric).toHaveBeenCalledWith('POST', '/v1/sessions', expect.anything());
      await callTool(wider.access_token, 'browser_close', { session_id: opened.structuredContent!.session_id });
      await app.inject({ method: 'DELETE', url: `/api/oauth/grants/${grant.id}`, headers: { authorization: `Bearer ${session}` } });
    } finally {
      fabric.mockRestore();
    }
  }, 60_000);

  it('browser_evaluate with browser:drive only: step-up for browser:evaluate, and the REST action of kind evaluate refuses the same delegation', async () => {
    const token = await mint(['runs:read', 'browser:drive']);
    const fabric = mockFabric();
    try {
      const opened = await callTool(token, 'browser_open', { goal: `Evaluate ${run}` });
      expect(opened.isError).toBeFalsy();
      const sessionId = String(opened.structuredContent!.session_id);

      const tool = await callRaw(token, 'browser_evaluate', { session_id: sessionId, script: '1 + 1' });
      expect(tool.status).toBe(403);
      expect(challengeOf(tool.headers['www-authenticate']).scope!.split(' ').sort()).toEqual(['browser:drive', 'browser:evaluate', 'runs:read']);

      // The REST layer draws the same line: the route itself refuses the evaluate kind for this token's
      // in-process delegation (the principal's credential kind is oauth), and allows a drive kind.
      const viaDelegation = async (action: Record<string, unknown>) => {
        let answer: { statusCode: number; headers: Record<string, unknown>; body: string } | undefined;
        const spy = jest.spyOn(app.get(McpDispatcher), 'dispatch').mockImplementationOnce(async (_msg, _rctx, caller) => {
          if (typeof caller === 'string') throw new Error('expected the delegation');
          answer = await caller({ method: 'POST', url: `/api/browser/sessions/${sessionId}/actions`, headers: { 'content-type': 'application/json' }, payload: JSON.stringify({ action }) });
          return { status: 200, body: rpcResult(1, {}) };
        });
        try {
          expect((await callRaw(token, 'runs_list')).status).toBe(200);
        } finally {
          spy.mockRestore();
        }
        return answer!;
      };
      const evaluate = await viaDelegation({ type: 'evaluate', script: '1 + 1' });
      expect(evaluate.statusCode).toBe(403);
      expect(challengeOf(evaluate.headers['www-authenticate'])).toMatchObject({ error: 'insufficient_scope', scope: expect.stringContaining('browser:evaluate') });
      const desktop = await viaDelegation({ type: 'desktop_key', key: 'Escape' });
      expect(desktop.statusCode).toBe(403);
      const click = await viaDelegation({ type: 'click', selector: '#ok' });
      expect(click.statusCode).toBe(200);
      expect(fabric.mock.calls.filter(([m, p]) => m === 'POST' && String(p).endsWith('/actions')).map(([, , o]) => (o as { body: { action: { type: string } } }).body.action.type)).toEqual(['click']);
      await callTool(token, 'browser_close', { session_id: sessionId });
    } finally {
      fabric.mockRestore();
    }
  }, 60_000);

  it('desktop:control without browser:drive is not enough', async () => {
    const token = await mint([...DEFAULTS, 'desktop:control']);
    const tools = await toolsOf(token);
    expect(tools.find((t) => t.name === 'browser_desktop_screenshot')!.description.endsWith(STEP_UP_NOTE)).toBe(true);
    const res = await callRaw(token, 'browser_desktop_screenshot', { session_id: randomUUID() });
    expect(res.status).toBe(403);
    const scope = challengeOf(res.headers['www-authenticate']).scope!.split(' ');
    expect(scope).toEqual(expect.arrayContaining(['desktop:control', 'browser:drive']));
  }, 60_000);

  it('a viewer: write tools are forbidden (a tool error, HTTP 200, no challenge) and never listed', async () => {
    const email = `mcp-oauth-viewer-${run}@example.test`;
    // The test-only login logs its own redirect (session token included), so this session is not a tracked secret.
    await app.inject({ method: 'POST', url: '/api/auth/test/login', payload: { email, role: 'viewer' } });
    const viewerId = (await prisma.user.findUniqueOrThrow({ where: { email }, select: { id: true } })).id;
    const token = await mint(DEFAULTS, viewerId);
    const names = (await toolsOf(token)).map((t) => t.name);
    const writes = MCP_TOOLS.filter((t) => t.effect !== 'read').map((t) => t.name);
    expect(names.filter((n) => writes.includes(n))).toEqual([]);
    expect(names).toEqual(expect.arrayContaining(['runs_list', 'tasks_list', 'inbox_list']));
    const res = await callRaw(token, 'task_create', { name: `Viewer ${run}`, goal: 'Not allowed' });
    expect(res.status).toBe(200);
    expect(res.headers['www-authenticate']).toBeUndefined();
    expect(res.json.result).toMatchObject({ isError: true, content: [{ type: 'text', text: expect.stringContaining(FORBIDDEN_TOOL_TEXT) }] });
    expect(await prisma.task.count({ where: { userId: viewerId } })).toBe(0);
    // A viewer's read tools still work.
    expect((await callTool(token, 'runs_list', {})).isError).toBeFalsy();
  }, 60_000);

  it('leaks no token, code or verifier into the grants routes, the audit log or the log (secret-egress)', async () => {
    const auditRows = await prisma.auditEvent.findMany({ where: { createdAt: { gte: suiteStart }, action: { startsWith: 'oauth:' } } });
    expect(auditRows.map((r) => r.action)).toEqual(expect.arrayContaining(['oauth:grant.create', 'oauth:grant.revoke']));
    expect(logLines.length).toBeGreaterThan(0);
    expect(checkOAuthSecretEgress({ secrets, responses, auditRows, logLines })).toEqual([]);
  });
});
