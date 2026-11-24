// A scripted OAuth MCP client in CI (E33.10, #468, Part A), against a real
// database and a mocked fabric. Hosted assistants cannot run in CI, so a
// client that knows only `<APP_URL>/api/mcp` behaves the way they are
// documented to, in five profiles (test/helpers/hosted-mcp-client.ts):
//
//   hosted-cimd       Client ID Metadata Document, fixed HTTPS callback, 2025-11-25, appends offline_access
//   hosted-dcr        Dynamic Client Registration on every connection, 2025-06-18
//   native-loopback   CIMD, loopback redirect on a random port (127.0.0.1, then localhost), 2025-11-25
//   stateless         CIMD, 2026-07-28: no initialize, server/discover, Mcp-Method/Mcp-Name, elicitation
//   tool-level-auth   a predefined client that reads per-tool securitySchemes, 2025-06-18; acts as ChatGPT
//                     (redirect URI on chatgpt.com): its step-up is a tool error with _meta["mcp/www_authenticate"] (#531)
//
// Every profile runs the same eight-step journey:
//   1 the 401 and both discovery documents   5 browser_open: step-up (403, or ChatGPT's tool error), re-authorize, the same call works
//   2 authorize, consent, code exchange       6 the access token expires (faked clock): 401, refresh, continue;
//   3 tools/list                                a replayed refresh token past the grace window revokes the grant
//   4 a run with a question and a screenshot  7 disconnect in the console: 401 with the challenge
//                                             8 every OAuth endpoint under 2 s, every tool call under the deadline
//
// The clock: the platform reads `new Date()` / `Date.now()` for token expiry,
// so step 6 fakes only `Date` (jest's modern timers with every timer API left
// real) and moves it past the access token's life; nothing is written to the
// database to age a token.
import { randomUUID } from 'node:crypto';
import { ConsoleLogger, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import { CimdFetcher, OAuthServerSettingsReader } from '@marinoscar/platform-api/identity';
import { checkOAuthSecretEgress, createOAuthTestClient, type OAuthTestClient } from '@marinoscar/platform-api/identity/testing';
import { SystemSettingsService } from '@marinoscar/platform-api/settings';

import { FabricClient } from '../src/fabric/fabric.client';
import { createApp } from '../src/main';
import { STEP_UP_NOTE } from '../src/mcp/mcp.dispatcher';
import { META } from '../src/mcp/mcp.protocol';
import { MAX_IMAGE_BASE64_OAUTH, TOOL_DEADLINE_MS_OAUTH } from '../src/mcp/mcp.results';
import { MCP_SCOPES } from '../src/mcp/mcp.scopes';
import { MCP_TOOLS } from '../src/mcp/mcp.tools';
import { PrismaService } from '../src/prisma/prisma.service';
import { QuestionsService } from '../src/questions/questions.service';
import { TasksService } from '../src/tasks/tasks.service';
import { CHATGPT_REDIRECT_URI, HOSTED_CLIENT_PROFILES, HostedMcpClient, StubCimdTransport, parseChallenge, type Approver, type HostedClientProfile, type McpAnswer } from './helpers/hosted-mcp-client';

/** What the issue asks of every OAuth endpoint in the test. */
const OAUTH_BUDGET_MS = 2_000;
/** The refresh grace window of the platform (OAUTH_REFRESH_GRACE_MS, 10 s). */
const REFRESH_GRACE_MS = 10_000;
const DEFAULT_SCOPES: string[] = MCP_SCOPES.filter((s) => s.default).map((s) => s.id);

let app: NestFastifyApplication;
let prisma: PrismaService;
let appUrl: string;
let mcpUrl: string;
let session: string;
let userId: string;
let predefined: OAuthTestClient;
const cimd = new StubCimdTransport();
const suiteStart = new Date();
const stamp = randomUUID().slice(0, 8);
const workerMode = process.env.JOBS_WORKER_MODE;

// The secret-egress check (the platform's conformance check, reused): nothing the clients held reaches a log line.
const logLines: string[] = [];
const secrets: string[] = [];

/** A JPEG-sized screenshot the mocked browser machine returns. */
const SHOT = Buffer.alloc(48_000, 7);

async function setOAuthSettings(patch: Record<string, unknown>) {
  await app.get(SystemSettingsService).patchSettings({ oauthServer: patch } as never, userId);
  app.get(OAuthServerSettingsReader).invalidate();
}

beforeAll(async () => {
  // No job worker: the mocked runner below moves the runs, nothing else drives them.
  process.env.JOBS_WORKER_MODE = 'off';
  app = await createApp();
  await app.init();
  await app.getHttpAdapter().getInstance().ready();
  if (workerMode === undefined) delete process.env.JOBS_WORKER_MODE;
  else process.env.JOBS_WORKER_MODE = workerMode;

  prisma = app.get(PrismaService);
  appUrl = app.get(ConfigService).get<string>('appUrl')!.replace(/\/+$/, '');
  mcpUrl = `${appUrl}/api/mcp`;
  const email = `mcp-hosted-${stamp}@example.test`;
  const login = await app.inject({ method: 'POST', url: '/api/auth/test/login', payload: { email, role: 'contributor' } });
  session = new URL(String(login.headers.location)).searchParams.get('token')!;
  secrets.push(session);
  userId = (await prisma.user.findUniqueOrThrow({ where: { email }, select: { id: true } })).id;
  // The test-only login logs its own redirect (session included): the evidence starts after it.
  const record = (level: string) => (...args: unknown[]) => void logLines.push(`${level} ${args.map((a) => (typeof a === 'string' ? a : JSON.stringify(a))).join(' ')}`);
  Logger.overrideLogger({ log: record('log'), error: record('error'), warn: record('warn'), debug: record('debug'), verbose: record('verbose'), fatal: record('fatal') });

  // The CIMD fetcher reads the stub instead of the network; every host resolves to a public address.
  const fetcher = app.get(CimdFetcher) as unknown as { transport: StubCimdTransport; resolver: { resolveAll(): Promise<Array<{ address: string; family: number }>> } };
  fetcher.transport = cimd;
  fetcher.resolver = { resolveAll: async () => [{ address: '93.184.216.34', family: 4 }] };

  const tla = HOSTED_CLIENT_PROFILES.find((p) => p.registration === 'predefined')!;
  // Its redirect URI is ChatGPT's (#531): the console's ChatGPT detection reads the client's redirect URI hosts.
  predefined = await createOAuthTestClient(prisma as never, { name: 'Scripted tool-level-auth', redirectUris: [tla.chatGptRedirect ? CHATGPT_REDIRECT_URI : `https://${tla.host}/oauth/callback`], host: tla.host, tokenEndpointAuthMethod: 'none' });
  await setOAuthSettings({
    enabled: true,
    allowedClientHosts: HOSTED_CLIENT_PROFILES.map((p) => p.host),
    allowAnyClientHost: false,
    allowLoopbackClients: true,
    clientIdMetadataDocuments: true,
    dynamicClientRegistration: true,
  });

  // The browser machine (fabric): sessions open, actions succeed, a screenshot comes back.
  const fabric = app.get(FabricClient);
  jest.spyOn(fabric, 'request').mockImplementation((async (method: string, path: string) => {
    if (method === 'POST' && path === '/v1/sessions') return { id: randomUUID() };
    if (method === 'POST' && path.endsWith('/actions')) return { id: randomUUID(), state: 'succeeded', result: { artifact_id: 'art-1', value: 42 } };
    if (method === 'DELETE') return undefined;
    if (method === 'GET') return {};
    return undefined;
  }) as never);
  jest.spyOn(fabric, 'raw').mockImplementation((async () => new Response(SHOT, { headers: { 'content-type': 'image/jpeg' } })) as never);
}, 120_000);

afterAll(async () => {
  jest.useRealTimers();
  try {
    if (app) {
      await prisma.run.updateMany({ where: { userId, status: { in: ['queued', 'running', 'waiting_human'] } }, data: { status: 'cancelled', remindAt: null, finishedAt: new Date() } });
      await setOAuthSettings({ enabled: false, allowedClientHosts: [] });
    }
  } finally {
    Logger.overrideLogger(new ConsoleLogger());
    jest.restoreAllMocks();
    await prisma?.oAuthClient.deleteMany({ where: { OR: [{ id: predefined?.id }, { host: { in: HOSTED_CLIENT_PROFILES.map((p) => p.host) } }, { host: 'loopback', createdAt: { gte: suiteStart } }] } });
    await app?.close();
  }
});

// --- the person and the runner ------------------------------------------------------------

/** The person approves the boxes ticked by default (the low-risk, default scopes), never more. */
const approveDefaults: Approver = (consent) => consent.scopes.filter((s) => s.alreadyGranted || (s.grantable && DEFAULT_SCOPES.includes(s.id))).map((s) => s.id);
/** The person approves everything the app asked for (a step-up). */
const approveAll: Approver = () => undefined;

const tasks = () => app.get(TasksService);
const questions = () => app.get(QuestionsService);

async function until<T>(what: string, probe: () => Promise<T | null | undefined | false>, ms = 15_000): Promise<T> {
  const end = Date.now() + ms;
  for (;;) {
    const v = await probe();
    if (v) return v;
    if (Date.now() > end) throw new Error(`timed out waiting for ${what}`);
    await new Promise((r) => setTimeout(r, 50));
  }
}

/**
 * The agent, mocked: it picks the run up, takes a step, asks the person a
 * choice, waits for the answer, takes another step, then finishes when the
 * test releases it (so a screenshot of the live browser can be taken first).
 */
function mockRunner(goal: string) {
  let release!: () => void;
  const released = new Promise<void>((r) => (release = r));
  const state: { runId?: string; questionId?: string } = {};
  const done = (async () => {
    const run = await until('the run', () => prisma.forUser({ userId }).run.findFirst({ where: { goal }, select: { id: true } }));
    state.runId = run.id;
    await tasks().transition(userId, run.id, 'running', { sessionId: randomUUID() });
    await prisma.forUser({ userId }).run.updateMany({ where: { id: run.id }, data: { stepCount: 1 } });
    await tasks().stepRecorded(userId, run.id, 1);
    const q = await questions().create({ id: userId }, questions().parseSpec({ input: 'choice', prompt: 'Which branch of the library?', options: ['Central', 'Riverside'] }), { askedBy: `run:${run.id}`, runId: run.id });
    state.questionId = q.id;
    await tasks().transition(userId, run.id, 'waiting_human');
    await until('the answer', async () => (await questions().get(userId, q.id)).status === 'answered', 60_000);
    await tasks().transition(userId, run.id, 'running');
    await prisma.forUser({ userId }).run.updateMany({ where: { id: run.id }, data: { stepCount: 2 } });
    await tasks().stepRecorded(userId, run.id, 2);
    await released;
    await tasks().transition(userId, run.id, 'succeeded', { result: 'The Riverside branch opens at 09:00', stopReason: 'finished' });
  })();
  return { state, release, done };
}

// --- the journey ----------------------------------------------------------------------------

type Result = { content: Array<{ type: string; text?: string; data?: string }>; structuredContent?: Record<string, any>; isError?: boolean; resultType?: string; inputRequests?: Record<string, any>; requestState?: string }; // eslint-disable-line @typescript-eslint/no-explicit-any

function ok(r: McpAnswer): Result {
  if (r.status !== 200 || r.json?.error) throw new Error(`expected a result, got ${r.status} ${JSON.stringify(r.json)}`);
  return r.json.result as Result;
}

function grantedOf(scope: string): string[] {
  return scope.split(' ').filter(Boolean);
}

/** Step 1, as the profile checks it: every field the client depends on. */
function checkDiscovery(client: HostedMcpClient) {
  const { challenge, prm, as, issuer } = client.found!;
  const p = client.profile;
  expect(challenge.resource_metadata).toBe(`${appUrl}/.well-known/oauth-protected-resource/api/mcp`);
  expect(challenge.error).toBeUndefined();
  expect(prm.resource).toBe(mcpUrl);
  expect(prm.authorization_servers[0]).toBe(issuer);
  expect(prm.bearer_methods_supported).toEqual(['header']);
  // A feature-gated scope (the Knowledge Graph's) is offered only while its feature is on, and it is off here (#916).
  const offered = MCP_SCOPES.filter((s) => !s.feature).map((s) => s.id);
  expect([...prm.scopes_supported].sort()).toEqual([...offered, 'offline_access'].sort());
  expect(as.issuer).toBe(issuer);
  expect(as.response_types_supported).toEqual(['code']);
  expect(as.grant_types_supported).toEqual(expect.arrayContaining(['authorization_code', 'refresh_token']));
  expect(as.code_challenge_methods_supported).toEqual(['S256']);
  expect(as.authorization_response_iss_parameter_supported).toBe(true);
  // A public client authenticates with `none`; a client that uses CIMD needs both values advertised.
  expect(as.token_endpoint_auth_methods_supported).toContain('none');
  if (p.registration === 'cimd') expect(as.client_id_metadata_document_supported).toBe(true);
  if (p.registration === 'dcr') expect(as.registration_endpoint).toMatch(/^https?:\/\//);
  if (p.appendsOfflineAccess) expect(as.scopes_supported).toContain('offline_access');
  for (const url of [as.authorization_endpoint, as.token_endpoint]) expect(new URL(url).origin).toBe(new URL(issuer).origin);
}

/** Steps 4: run_goal, follow until the question, answer it (inbox_answer, or the client's own form), screenshot, finish. */
async function delegate(client: HostedMcpClient) {
  const goal = `Find the opening hours of the public library (${client.profile.name}, ${stamp})`;
  const runner = mockRunner(goal);
  // A hosted client sends no wait_s: an OAuth caller waits by default, and returns at the first change.
  let last: [string, Record<string, unknown>] = ['run_goal', { goal }];
  let r = ok(await client.callTool(...last));
  let cursor: string | undefined;
  for (let i = 0; i < 10; i += 1) {
    if (r.resultType === 'input_required') break;
    expect(r.isError).toBeFalsy();
    const progress = (r.structuredContent?.progress ?? r.structuredContent) as Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any
    cursor = progress.cursor;
    if (progress.needs_human) break;
    last = ['run_wait', { run_id: runner.state.runId ?? r.structuredContent?.id, wait_s: 10, ...(cursor ? { since: cursor } : {}) }];
    r = ok(await client.callTool(...last));
  }
  const runId = await until('the run id', async () => runner.state.runId);
  const questionId = await until('the question id', async () => runner.state.questionId);

  if (client.profile.elicitation) {
    // 2026-07-28 with elicitation: the question comes as the client's own form; the retry carries the answer.
    expect(r).toMatchObject({ resultType: 'input_required', inputRequests: { hexactra_question: { method: 'elicitation/create', params: { mode: 'form' } } } });
    // The retry is the same call (run_goal or run_wait) with the answer and the state it was given.
    const answered = ok(await client.callTool(last[0], last[1], { inputResponses: { hexactra_question: { action: 'accept', content: { answer: 'Riverside' } } }, requestState: r.requestState }));
    expect(answered.resultType).toBe('complete');
    expect(answered.isError).toBeFalsy();
  } else {
    const progress = (r.structuredContent?.progress ?? r.structuredContent) as Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any
    expect(progress).toMatchObject({ needs_human: true, question: { id: questionId, input: 'choice', answerable_here: true } });
    const answer = ok(await client.callTool('inbox_answer', { run_id: runId, outcome: 'completed', value: 'Riverside' }));
    expect(answer.isError).toBeFalsy();
    expect(answer.structuredContent).toMatchObject({ status: 'answered', value: 'Riverside' });
  }
  const q = await questions().get(userId, questionId);
  expect(q).toMatchObject({ status: 'answered', response: { outcome: 'completed', value: 'Riverside', channel: expect.stringMatching(client.profile.elicitation ? /^mcp-elicitation\./ : /^mcp-oauth\./) } });

  // The runner took the answer and is working: a picture of its browser, within the OAuth image limit.
  await until('the runner to resume', async () => (await prisma.forUser({ userId }).run.findFirst({ where: { id: runId }, select: { stepCount: true } }))?.stepCount === 2);
  const live = ok(await client.callTool('run_wait', { run_id: runId, wait_s: 0, screenshot: true }));
  const image = live.content.find((c) => c.type === 'image');
  expect(image).toBeDefined();
  expect(image!.data!.length).toBeLessThanOrEqual(MAX_IMAGE_BASE64_OAUTH);
  expect(Buffer.from(image!.data!, 'base64').length).toBe(SHOT.length);
  expect(live.structuredContent).toMatchObject({ status: 'running', screenshot: 'included' });

  runner.release();
  await runner.done;
  let finished = live;
  for (let i = 0; i < 5 && finished.structuredContent?.status !== 'succeeded'; i += 1) {
    finished = ok(await client.callTool('run_wait', { run_id: runId, wait_s: 10, since: finished.structuredContent?.cursor }));
  }
  expect(finished.structuredContent).toMatchObject({ run_id: runId, status: 'succeeded', result: 'The Riverside branch opens at 09:00' });
  // The run records which app started it (attribution, E33.6).
  const row = await prisma.forUser({ userId }).run.findFirstOrThrow({ where: { id: runId }, select: { clientId: true } });
  expect(row.clientId).toBeTruthy();
}

/** Step 5: browser_open is a step-up; re-authorize with the challenge's scopes; the same call works. */
async function stepUp(client: HostedMcpClient, granted: string[]) {
  const goal = `Open a page (${client.profile.name}, ${stamp})`;
  if (client.profile.readsSecuritySchemes) {
    // It reads what the tool needs before calling it: not granted yet. It still calls once: the refusal (for
    // ChatGPT a tool error with _meta["mcp/www_authenticate"], #531) carries the challenge naming the scopes to ask for.
    const listed = ok(await client.rpc('tools/list')) as unknown as { tools: Array<{ name: string; securitySchemes: Array<{ type: string; scopes: string[] }> }> };
    const schemes = listed.tools.find((t) => t.name === 'browser_open')!.securitySchemes;
    expect(schemes).toEqual([{ type: 'oauth2', scopes: ['browser:drive'] }]);
    expect(schemes[0]!.scopes.every((s) => granted.includes(s))).toBe(false);
  }
  const refused = await client.callTool('browser_open', { goal });
  let challengeValue: unknown;
  if (client.profile.chatGptRedirect) {
    // ChatGPT (#531): a 200 with a tool error result; the challenge is in _meta["mcp/www_authenticate"], not a header.
    expect(refused.status).toBe(200);
    expect(refused.headers['www-authenticate']).toBeUndefined();
    const result = refused.json.result as Result & { _meta?: Record<string, unknown> };
    expect(result.isError).toBe(true);
    expect(result.structuredContent).toBeUndefined();
    expect(result.content).toEqual([{ type: 'text', text: 'This tool needs permission the user has not given this app yet (browser:drive). Ask the user to allow it.' }]);
    const values = result._meta?.['mcp/www_authenticate'] as string[];
    expect(values).toHaveLength(1);
    expect(values[0]).toMatch(/^Bearer /);
    challengeValue = values[0];
  } else {
    expect(refused.status).toBe(403);
    expect(refused.json).toMatchObject({ error: 'insufficient_scope' });
    challengeValue = refused.headers['www-authenticate'];
  }
  const challenge = parseChallenge(challengeValue);
  expect(challenge).toMatchObject({ error: 'insufficient_scope', error_description: expect.any(String), resource_metadata: `${appUrl}/.well-known/oauth-protected-resource/api/mcp` });
  // The refusal is recorded the same way in both forms.
  expect(await prisma.mcpActivity.count({ where: { userId, event: 'step_up', outcome: 'refused', tool: 'browser_open', createdAt: { gte: suiteStart } } })).toBeGreaterThanOrEqual(1);
  const asked = grantedOf(challenge.scope!);
  expect(asked).toEqual(expect.arrayContaining([...granted.filter((s) => s !== 'offline_access'), 'browser:drive']));
  expect(await prisma.run.count({ where: { userId, goal } })).toBe(0);

  const before = client.clientId;
  const { tokens, consent } = await client.authorize(client.requestedScopes(challenge.scope), approveAll, { loopbackName: 'localhost' });
  // Only the new scope is new on the consent page; the client host is named.
  expect(consent.scopes.filter((s) => !s.alreadyGranted).map((s) => s.id)).toEqual(['browser:drive']);
  expect(consent.isLoopbackRedirect).toBe(client.profile.redirect === 'loopback');
  if (client.profile.registration === 'dcr') expect(client.clientId).toBe(before);
  expect(grantedOf(tokens.scope)).toEqual(expect.arrayContaining(['browser:drive', ...DEFAULT_SCOPES]));

  const opened = ok(await client.callTool('browser_open', { goal }));
  expect(opened.isError).toBeFalsy();
  expect(opened.structuredContent).toMatchObject({ session_id: expect.any(String) });
  ok(await client.callTool('browser_close', { session_id: opened.structuredContent!.session_id }));
}

/** Step 6: the access token expires (faked clock) → 401 → refresh → continue; a replayed refresh token kills the grant. */
async function expiry(client: HostedMcpClient) {
  const lifeS = client.tokens!.expires_in;
  const old = { ...client.tokens! };
  expect(old.refresh_token).toMatch(/^ort_/);
  jest.useFakeTimers({
    doNotFake: ['hrtime', 'nextTick', 'performance', 'queueMicrotask', 'setImmediate', 'clearImmediate', 'setInterval', 'clearInterval', 'setTimeout', 'clearTimeout'],
    now: Date.now() + lifeS * 1000 + 60_000,
  });
  try {
    const expired = await client.rpc('tools/list');
    expect(expired.status).toBe(401);
    expect(parseChallenge(expired.headers['www-authenticate'])).toMatchObject({ error: 'invalid_token', resource_metadata: `${appUrl}/.well-known/oauth-protected-resource/api/mcp` });
    const refreshed = await client.refresh();
    expect(refreshed.status).toBe(200);
    expect(client.tokens!.refresh_token).not.toBe(old.refresh_token);
    expect(grantedOf(client.tokens!.scope).sort()).toEqual(grantedOf(old.scope).sort());
    expect(ok(await client.rpc('tools/list'))).toMatchObject({ tools: expect.any(Array) });

    // Past the grace window, the old refresh token again: reuse. The whole grant is revoked.
    jest.setSystemTime(Date.now() + REFRESH_GRACE_MS + 1_000);
    const replay = await client.refresh(old.refresh_token);
    expect(replay.status).toBe(400);
    expect(replay.body).toMatchObject({ error: 'invalid_grant' });
    const dead = await client.rpc('tools/list');
    expect(dead.status).toBe(401);
    expect((await client.refresh()).status).toBe(400);
  } finally {
    jest.useRealTimers();
  }
}

/** Step 7: the person disconnects the app in the console; the next call is a 401 with the challenge. */
async function disconnect(client: HostedMcpClient) {
  // The client reconnects after the revocation (a fresh sign-in), then the person disconnects it.
  await client.discover();
  await client.authorize(client.requestedScopes(), approveDefaults);
  ok(await client.open());
  const grants = await app.inject({ method: 'GET', url: '/api/oauth/grants', headers: { authorization: `Bearer ${session}` } });
  expect(grants.statusCode).toBe(200);
  const grant = (grants.json().data as Array<{ id: string; client: { host: string } }>).find((g) => g.client.host === client.profile.host);
  expect(grant).toBeDefined();
  const revoked = await app.inject({ method: 'DELETE', url: `/api/oauth/grants/${grant!.id}`, headers: { authorization: `Bearer ${session}` } });
  expect(revoked.statusCode).toBe(204);
  const after = await client.rpc('tools/list');
  expect(after.status).toBe(401);
  expect(parseChallenge(after.headers['www-authenticate'])).toMatchObject({ error: 'invalid_token', resource_metadata: `${appUrl}/.well-known/oauth-protected-resource/api/mcp` });
}

/** Step 8: OAuth endpoints under 2 s; every tool call under the OAuth deadline. */
function timings(client: HostedMcpClient) {
  const oauth = client.timings.filter((t) => t.kind === 'oauth');
  expect(oauth.length).toBeGreaterThanOrEqual(8);
  expect(oauth.filter((t) => t.ms >= OAUTH_BUDGET_MS).map((t) => `${t.what} ${Math.round(t.ms)} ms`)).toEqual([]);
  const tools = client.timings.filter((t) => t.kind === 'tool');
  expect(tools.length).toBeGreaterThanOrEqual(6);
  expect(tools.filter((t) => t.ms >= TOOL_DEADLINE_MS_OAUTH).map((t) => t.what)).toEqual([]);
}

describe.each(HOSTED_CLIENT_PROFILES.map((p) => [p.name, p] as [string, HostedClientProfile]))('a scripted hosted client, profile %s', (_name, profile) => {
  it(`(${profile.imitates}) connects, delegates, steps up, refreshes and is disconnected`, async () => {
    const client = new HostedMcpClient(profile, { app, mcpUrl, cimd, session: () => session, meta: META, predefined: { clientId: predefined.clientId, redirectUri: predefined.redirectUri }, secrets });

    // 1. The 401 and both discovery documents.
    await client.discover();
    checkDiscovery(client);

    // 2. Authorize with PKCE and resource; the person approves the default boxes; state and iss checked; form-body exchange.
    const requested = client.requestedScopes();
    if (profile.appendsOfflineAccess) expect(grantedOf(requested)).toContain('offline_access');
    const { tokens, consent } = await client.authorize(requested, approveDefaults);
    expect(consent.client.host).toBe(profile.host);
    // The consent page names where the code goes: the client's host, or the loopback address and port it sent.
    expect(consent.redirectHost).toBe(new URL(client.redirectsSent[0]!).host);
    if (profile.redirect === 'fixed') expect(consent.redirectHost).toBe(profile.chatGptRedirect ? 'chatgpt.com' : profile.host);
    expect(consent.isLoopbackRedirect).toBe(profile.redirect === 'loopback');
    expect(tokens.access_token).toMatch(/^oat_/);
    expect(tokens.refresh_token).toMatch(/^ort_/);
    const granted = grantedOf(tokens.scope);
    expect(granted.filter((s) => s !== 'offline_access').sort()).toEqual([...DEFAULT_SCOPES].sort());
    if (profile.registration === 'cimd') expect(cimd.fetched).toContain(client.metadataUrl);
    if (profile.redirect === 'loopback') {
      // The port it sent differs from the registered (port-less) one.
      expect(client.redirectsSent[0]).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/callback$/);
    }

    // 3. tools/list: only default-scope tools callable; titles, every hint, outputSchema where promised.
    const opened = ok(await client.open());
    if (profile.protocol === '2026-07-28') expect(opened).toMatchObject({ resultType: 'complete', supportedVersions: expect.arrayContaining(['2026-07-28']) });
    else expect(opened).toMatchObject({ protocolVersion: profile.protocol, serverInfo: { name: 'hexactra-console' } });
    const tools = (ok(await client.rpc('tools/list')) as unknown as { tools: Array<Record<string, any>> }).tools; // eslint-disable-line @typescript-eslint/no-explicit-any
    expect(tools.length).toBeGreaterThan(10);
    for (const t of tools) {
      const def = MCP_TOOLS.find((x) => x.name === t.name)!;
      expect(def).toBeDefined();
      const callable = (t.securitySchemes[0].scopes as string[]).every((s) => granted.includes(s));
      expect([t.name, String(t.description).endsWith(STEP_UP_NOTE)]).toEqual([t.name, !callable]);
      expect(t.title).toBe(def.title);
      expect(Object.keys(t.annotations).sort()).toEqual(['destructiveHint', 'idempotentHint', 'openWorldHint', 'readOnlyHint', 'title']);
      if (def.output) expect(t.outputSchema).toMatchObject({ type: 'object' });
      else expect(t.outputSchema).toBeUndefined();
    }
    const callable = tools.filter((t) => !String(t.description).endsWith(STEP_UP_NOTE)).map((t) => t.name);
    expect(callable).toEqual(expect.arrayContaining(['run_goal', 'run_wait', 'inbox_answer', 'tasks_list']));
    expect(callable.filter((n) => n.startsWith('browser_'))).toEqual([]);

    // 4. A delegated run with a question and a screenshot.
    await delegate(client);

    // 5. Step-up.
    await stepUp(client, granted);

    // 6. Expiry, refresh, reuse.
    await expiry(client);

    // 7. Disconnect from the console side.
    await disconnect(client);

    // DCR: registered on every connection, and the server answered with the same client each time.
    if (profile.registration === 'dcr') {
      expect(client.registeredIds.length).toBeGreaterThanOrEqual(3);
      expect(new Set(client.registeredIds).size).toBe(1);
    }

    // 8. Timings.
    timings(client);
  }, 180_000);
});

describe('what the hosted clients leave behind', () => {
  it('no token, code or verifier in the log (secret egress)', async () => {
    expect(logLines.length).toBeGreaterThan(0);
    const auditRows = await prisma.auditEvent.findMany({ where: { createdAt: { gte: suiteStart }, action: { startsWith: 'oauth:' } } });
    expect(auditRows.map((r) => r.action)).toEqual(expect.arrayContaining(['oauth:grant.create', 'oauth:grant.revoke', 'oauth:token.reuse_detected']));
    expect(checkOAuthSecretEgress({ secrets, responses: [], auditRows, logLines })).toEqual([]);
  });
});
