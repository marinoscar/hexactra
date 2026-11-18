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
import { ConsoleLogger, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import { OAuthServerSettingsReader } from '@marinoscar/platform-api/identity';
import { checkOAuthSecretEgress, createOAuthTestClient, pkcePair, type OAuthTestClient } from '@marinoscar/platform-api/identity/testing';
import { SystemSettingsService } from '@marinoscar/platform-api/settings';

import { createApp } from '../src/main';
import { MCP_DOCS_URL, MCP_SCOPES, MCP_SCOPE_IDS } from '../src/mcp/mcp.scopes';
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
  expect([...prm.scopes_supported].sort()).toEqual([...MCP_SCOPE_IDS, 'offline_access'].sort());
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

    // task_create calls POST /api/tasks (tasks:write): the user holds it, the token's scopes do not grant it.
    // For now a tool error; E33.2 turns it into a step-up.
    const refused = await callTool(token.access_token, 'task_create', { name: `OAuth ${run}`, goal: 'Not allowed' });
    expect(refused.isError).toBe(true);
    expect(refused.content[0]!.text).toMatch(/not allowed/i);
    expect(await prisma.task.count({ where: { userId, name: `OAuth ${run}` } })).toBe(0);

    // The same user's session still may (the narrowing is the token's, not the user's).
    const own = await app.inject({ method: 'POST', url: '/api/tasks', headers: { authorization: `Bearer ${session}`, 'content-type': 'application/json' }, payload: JSON.stringify({ name: `Session ${run}`, goal: 'Allowed' }) });
    expect(own.statusCode).toBe(201);

    const grant = await prisma.oAuthGrant.findFirstOrThrow({ where: { userId, clientId: client.id, revokedAt: null } });
    await app.inject({ method: 'DELETE', url: `/api/oauth/grants/${grant.id}`, headers: { authorization: `Bearer ${session}` } });
  }, 60_000);

  it('leaks no token, code or verifier into the grants routes, the audit log or the log (secret-egress)', async () => {
    const auditRows = await prisma.auditEvent.findMany({ where: { createdAt: { gte: suiteStart }, action: { startsWith: 'oauth:' } } });
    expect(auditRows.map((r) => r.action)).toEqual(expect.arrayContaining(['oauth:grant.create', 'oauth:grant.revoke']));
    expect(logLines.length).toBeGreaterThan(0);
    expect(checkOAuthSecretEgress({ secrets, responses, auditRows, logLines })).toEqual([]);
  });
});
