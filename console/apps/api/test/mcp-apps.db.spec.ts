// MCP Apps (#466) against a real database: the run card as a `ui://`
// resource (resources/list, resources/read with its MIME type, CSP and the
// per-host `domain`), the four tools that link it, the app-only
// `run_card_poll`, the supersession key, and that a missing widget changes
// nothing else. Personal access token clients see only additive `_meta`.
import { createHash, randomUUID } from 'node:crypto';
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import Ajv2020 from 'ajv/dist/2020';

import { createApp } from '../src/main';
import { MCP_APP_MIME, MCP_APPS_EXTENSION_ID, MCP_UI_RESOURCES, QUESTION_CARD_URI, RUN_CARD_URI, TASKS_CARD_URI, mcpUiDistDir, setMcpUiDistDir } from '../src/mcp/mcp.apps';
import { McpDispatcher, toolListEntry } from '../src/mcp/mcp.dispatcher';
import { MCP_VERSIONS, META, type McpRequestContext } from '../src/mcp/mcp.protocol';
import { MCP_TOOLS } from '../src/mcp/mcp.tools';
import { builtinPolicy } from '../src/policies/builtin-policies';
import { PrismaService } from '../src/prisma/prisma.service';
import { computeEffectiveBudget } from '../src/runner/budget';
import { TasksService } from '../src/tasks/tasks.service';
import { MCP_SCOPE_IDS } from '../src/mcp/mcp.scopes';

let app: NestFastifyApplication;
const stamp = `${Date.now()}`;
const APP_URL = 'https://console.example.test';
const workerMode = process.env.JOBS_WORKER_MODE;
const appUrl = process.env.APP_URL;
const UI_TOOLS = ['run_goal', 'run_status', 'run_wait', 'task_run'];
/** The tools linked to the question and tasks cards (#467). */
const CARD_TOOLS: Record<string, string> = { inbox_list: QUESTION_CARD_URI, question_status: QUESTION_CARD_URI, ask_human: QUESTION_CARD_URI, tasks_list: TASKS_CARD_URI, schedules_list: TASKS_CARD_URI };
/** Claude's documented rule, computed here from the formula: first 32 hex of SHA-256 of the server URL + `.claudemcpcontent.com`. */

/** The real build (`npm run build` runs before the db tier in CI), or a stand-in so the spec runs without one. */
const built = MCP_UI_RESOURCES.every((r) => existsSync(join(mcpUiDistDir(), r.file)));
let fixtureDir: string | null = null;
const users = new Set<string>();

beforeAll(async () => {
  process.env.JOBS_WORKER_MODE = 'off';
  process.env.APP_URL = APP_URL;
  if (!built) {
    fixtureDir = mkdtempSync(join(tmpdir(), 'mcp-ui-'));
    for (const r of MCP_UI_RESOURCES) writeFileSync(join(fixtureDir, r.file), `<!doctype html><html><head><title>${r.title}</title></head><body><div id="root"></div><script type="module">/* stand-in */</script></body></html>`);
    setMcpUiDistDir(fixtureDir);
  }
  app = await createApp();
  await app.init();
  await app.getHttpAdapter().getInstance().ready();
  if (workerMode === undefined) delete process.env.JOBS_WORKER_MODE;
  else process.env.JOBS_WORKER_MODE = workerMode;
});

afterAll(async () => {
  if (app && users.size) {
    await app.get(PrismaService).run.updateMany({ where: { userId: { in: [...users] }, status: { in: ['queued', 'running', 'waiting_human'] } }, data: { status: 'cancelled', remindAt: null, finishedAt: new Date() } });
  }
  setMcpUiDistDir(null);
  if (fixtureDir) rmSync(fixtureDir, { recursive: true, force: true });
  if (appUrl === undefined) delete process.env.APP_URL;
  else process.env.APP_URL = appUrl;
  await app?.close();
});

async function login(email: string): Promise<{ t: string; userId: string }> {
  const res = await app.inject({ method: 'POST', url: '/api/auth/test/login', payload: { email, role: 'contributor' } });
  const t = new URL(String(res.headers.location)).searchParams.get('token')!;
  const me = await app.inject({ method: 'GET', url: '/api/auth/me', headers: { authorization: `Bearer ${t}` } });
  const userId = (JSON.parse(me.body) as { data: { id: string } }).data.id;
  users.add(userId);
  return { t, userId };
}

type Json = any; // eslint-disable-line @typescript-eslint/no-explicit-any

/** A request over HTTP on a handshake revision (a personal access token or session). */
async function legacy(t: string | null, method: string, params: Record<string, unknown> = {}, headers: Record<string, string> = {}): Promise<{ status: number; json: Json }> {
  const res = await app.inject({
    method: 'POST',
    url: '/api/mcp',
    headers: { ...(t ? { authorization: `Bearer ${t}` } : {}), 'content-type': 'application/json', 'mcp-protocol-version': '2025-06-18', ...headers },
    payload: JSON.stringify({ jsonrpc: '2.0', id: randomUUID(), method, params }),
  });
  return { status: res.statusCode, json: res.body ? JSON.parse(res.body) : null };
}

/** A 2026-07-28 request naming its client and capabilities. */
async function modern(t: string, method: string, params: Record<string, unknown> = {}, opts: { client?: string; caps?: Record<string, unknown> } = {}): Promise<Json> {
  const headers: Record<string, string> = { authorization: `Bearer ${t}`, 'content-type': 'application/json', 'mcp-protocol-version': '2026-07-28', 'mcp-method': method };
  if (typeof params.name === 'string') headers['mcp-name'] = params.name;
  if (typeof params.uri === 'string') headers['mcp-name'] = params.uri;
  const body = {
    jsonrpc: '2.0',
    id: randomUUID(),
    method,
    params: { ...params, _meta: { [META.protocolVersion]: '2026-07-28', [META.clientInfo]: { name: opts.client ?? 'test-client', version: '1' }, [META.clientCapabilities]: opts.caps ?? {} } },
  };
  const res = await app.inject({ method: 'POST', url: '/api/mcp', headers, payload: JSON.stringify(body) });
  return JSON.parse(res.body);
}

/** The same request as an app signed in with OAuth (the credential kind E33.1 brings; the token here is a session). */
async function oauth(who: { t: string; userId: string }, method: string, params: Record<string, unknown> = {}): Promise<Json> {
  const rctx: McpRequestContext = { version: '2025-06-18', flags: MCP_VERSIONS['2025-06-18'], clientInfo: { name: 'claude-ai' }, credential: { kind: 'oauth', scopes: [...MCP_SCOPE_IDS] } as never };
  const out = await app.get(McpDispatcher).dispatch({ jsonrpc: '2.0', id: 1, method, params }, rctx, `Bearer ${who.t}`, undefined, { userId: who.userId });
  return out!.body;
}

describe('the server advertises MCP Apps', () => {
  it('initialize and server/discover carry the resources capability and the extension', async () => {
    const who = await login(`mcp-apps-init-${stamp}@example.test`);
    const init = await legacy(who.t, 'initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'test', version: '1' } });
    expect(init.json.result.capabilities).toEqual({ tools: { listChanged: false }, resources: { listChanged: false, subscribe: false }, extensions: { [MCP_APPS_EXTENSION_ID]: { mimeTypes: [MCP_APP_MIME] } } });
    const d = await modern(who.t, 'server/discover');
    expect(d.result.capabilities.extensions).toEqual({ 'io.modelcontextprotocol/ui': { mimeTypes: ['text/html;profile=mcp-app'] } });
  });
});

describe('resources', () => {
  it('resources/list lists the run, question and tasks cards, with the cache hints on 2026-07-28', async () => {
    const who = await login(`mcp-apps-list-${stamp}@example.test`);
    const list = await legacy(who.t, 'resources/list');
    expect(list.json.result.resources).toEqual([
      {
        uri: RUN_CARD_URI,
        name: 'run_card',
        title: 'Hexactra run',
        description: expect.any(String),
        mimeType: 'text/html;profile=mcp-app',
        _meta: { ui: { csp: { connectDomains: [], resourceDomains: [] }, prefersBorder: true } },
      },
      ...[
        [QUESTION_CARD_URI, 'question_card', 'Hexactra question'],
        [TASKS_CARD_URI, 'tasks_card', 'Hexactra tasks'],
      ].map(([uri, name, title]) => ({ uri, name, title, description: expect.any(String), mimeType: 'text/html;profile=mcp-app', _meta: { ui: { csp: { connectDomains: [], resourceDomains: [] }, prefersBorder: true } } })),
    ]);
    const modernList = await modern(who.t, 'resources/list');
    expect(modernList.result).toMatchObject({ resources: [{ uri: RUN_CARD_URI }, { uri: QUESTION_CARD_URI }, { uri: TASKS_CARD_URI }], ttlMs: 300000, cacheScope: 'private', resultType: 'complete' });
    // The two new cards are read like the run card: one self-contained page each (#467).
    for (const [uri, name, tool] of [
      [QUESTION_CARD_URI, 'question_card', 'question_card_answer'],
      [TASKS_CARD_URI, 'tasks_card', 'task_pause'],
    ]) {
      const c = (await legacy(who.t, 'resources/read', { uri })).json.result.contents[0];
      expect(c).toMatchObject({ uri, mimeType: 'text/html;profile=mcp-app', _meta: { ui: { csp: { connectDomains: [], resourceDomains: [] } } } });
      expect(c.text).toMatch(new RegExp(`^<!doctype html>\\n<!-- hexactra-mcp-ui ${name} sha256:[0-9a-f]{16}`, 'i'));
      if (built) {
        expect(c.text).not.toMatch(/<script[^>]*\ssrc=/i);
        expect(c.text).toContain(tool);
      }
    }
  });

  it('resources/read returns the HTML with the MCP App MIME type and an empty CSP, and no domain (not even for Claude)', async () => {
    const who = await login(`mcp-apps-read-${stamp}@example.test`);
    const r = await modern(who.t, 'resources/read', { uri: RUN_CARD_URI }, { client: 'claude-ai' });
    expect(r.result.contents).toHaveLength(1);
    const c = r.result.contents[0];
    expect(c).toMatchObject({ uri: RUN_CARD_URI, mimeType: 'text/html;profile=mcp-app', _meta: { ui: { csp: { connectDomains: [], resourceDomains: [] }, prefersBorder: true } } });
    expect(c._meta.ui.domain).toBeUndefined();
    expect(c.text).toMatch(/^<!doctype html>\n<!-- hexactra-mcp-ui run_card sha256:[0-9a-f]{16} console:\d+\.\d+\.\d+ -->/i);
    if (built) {
      // The real build: one self-contained file, nothing loaded from anywhere.
      expect(c.text).not.toMatch(/<script[^>]*\ssrc=/i);
      expect(c.text).not.toMatch(/<link[^>]*\shref=/i);
      expect(c.text).toContain('run_card_poll');
    }

    // Claude by its User-Agent or client info: still no domain (optional, and a mismatch breaks the card; #468 verifies).
    const viaUa = await legacy(who.t, 'resources/read', { uri: RUN_CARD_URI }, { 'user-agent': 'Claude-User' });
    expect(viaUa.json.result.contents[0]._meta.ui.domain).toBeUndefined();
    expect((await modern(who.t, 'resources/list', {}, { client: 'claude-ai' })).result.resources[0]._meta.ui.domain).toBeUndefined();
  });

  it('sends no domain to other hosts, Claude Code or an unknown client', async () => {
    const who = await login(`mcp-apps-nodomain-${stamp}@example.test`);
    for (const client of ['chatgpt', 'claude-code', 'some-client']) {
      const r = await modern(who.t, 'resources/read', { uri: RUN_CARD_URI }, { client });
      expect([client, r.result.contents[0]._meta.ui]).toEqual([client, { csp: { connectDomains: [], resourceDomains: [] }, prefersBorder: true }]);
    }
  });

  it('an unknown ui:// resource is not found, and the endpoint still needs a credential', async () => {
    const who = await login(`mcp-apps-unknown-${stamp}@example.test`);
    expect((await legacy(who.t, 'resources/read', { uri: 'ui://hexactra/none' })).json.error.code).toBe(-32002);
    expect((await modern(who.t, 'resources/read', { uri: 'ui://hexactra/none' })).error.code).toBe(-32602);
    expect((await legacy(null, 'resources/read', { uri: RUN_CARD_URI })).status).toBe(401);
  });
});

describe('tools', () => {
  it('the four run tools link the card with _meta.ui.resourceUri, the legacy key and the ChatGPT alias', async () => {
    const who = await login(`mcp-apps-tools-${stamp}@example.test`);
    const tools = (await legacy(who.t, 'tools/list')).json.result.tools as Json[];
    for (const name of UI_TOOLS) {
      expect([name, tools.find((x) => x.name === name)._meta]).toEqual([name, { ui: { resourceUri: RUN_CARD_URI }, 'ui/resourceUri': RUN_CARD_URI, 'openai/outputTemplate': RUN_CARD_URI }]);
    }
    for (const [name, uri] of Object.entries(CARD_TOOLS)) {
      expect([name, tools.find((x) => x.name === name)._meta]).toEqual([name, { ui: { resourceUri: uri }, 'ui/resourceUri': uri, 'openai/outputTemplate': uri }]);
    }
    expect(tools.filter((x) => x._meta).map((x) => x.name).sort()).toEqual([...UI_TOOLS, ...Object.keys(CARD_TOOLS)].sort());
  });

  it('personal access token clients: tools/list gains only additive _meta (same tools, same entries otherwise)', async () => {
    const who = await login(`mcp-apps-pat-${stamp}@example.test`);
    for (const version of ['2025-06-18', '2025-03-26'] as const) {
      const res = await legacy(who.t, 'tools/list', {}, { 'mcp-protocol-version': version });
      // The Knowledge Graph is off here: its tools (E46.22) are not listed, exactly as before them.
      const before = MCP_TOOLS.filter((t) => !t.visibility && !t.feature).map((t) => toolListEntry(t, MCP_VERSIONS[version], { uiAvailable: () => false }));
      const after = (res.json.result.tools as Json[]).map(({ _meta, ...rest }) => rest);
      expect(after).toEqual(JSON.parse(JSON.stringify(before)));
      expect(after.map((x) => x.name)).not.toContain('run_card_poll');
    }
  });

  it('run_card_poll is offered, hidden from the model, to OAuth apps and to clients that declare MCP Apps', async () => {
    const who = await login(`mcp-apps-poll-list-${stamp}@example.test`);
    const fromOauth = (await oauth(who, 'tools/list')).result.tools as Json[];
    expect(fromOauth.find((x) => x.name === 'run_card_poll')).toMatchObject({ _meta: { ui: { visibility: ['app'] } }, annotations: { readOnlyHint: true } });
    const declared = (await modern(who.t, 'tools/list', {}, { caps: { extensions: { [MCP_APPS_EXTENSION_ID]: { mimeTypes: [MCP_APP_MIME] } } } })).result.tools as Json[];
    expect(declared.map((x) => x.name)).toContain('run_card_poll');
    const plain = (await modern(who.t, 'tools/list')).result.tools as Json[];
    expect(plain.map((x) => x.name)).not.toContain('run_card_poll');
  });

  it('a result that opens the card carries its supersession key; run_card_poll follows the run (any credential may call it)', async () => {
    const who = await login(`mcp-apps-poll-${stamp}@example.test`);
    const start = (await legacy(who.t, 'tools/call', { name: 'run_goal', arguments: { goal: `Card ${randomUUID()}` } })).json.result;
    expect(start.isError).toBeFalsy();
    const runId = start.structuredContent.id as string;
    expect(start.structuredContent.card_key).toEqual({ created_at: expect.any(Number), seq: expect.any(Number) });
    // The text, which models and hosts without MCP Apps read, is unchanged: no key in it.
    expect(start.content[0].text).not.toContain('card_key');
    const second = (await legacy(who.t, 'tools/call', { name: 'run_status', arguments: { run_id: runId, steps: 0 } })).json.result;
    // A later card of the same run has a younger key: server time first, then the counter.
    expect(second.structuredContent.card_key.created_at).toBeGreaterThanOrEqual(start.structuredContent.card_key.created_at);
    expect(second.structuredContent.card_key.seq).toBeGreaterThan(start.structuredContent.card_key.seq);

    const poll = (await legacy(who.t, 'tools/call', { name: 'run_card_poll', arguments: { run_id: runId, wait_s: 0, screenshot: true } })).json.result;
    expect(poll.isError).toBeFalsy();
    expect(poll.structuredContent).toMatchObject({ id: runId, status: 'queued', progress: { run_id: runId, status: 'queued', screenshot: 'unavailable', console_url: `${APP_URL}/runs/${runId}` } });
    expect(poll.structuredContent.card_key).toBeUndefined();

    // It waits like run_wait: a change after `since` wakes it.
    await app.get(TasksService).transition(who.userId, runId, 'running');
    const waiting = legacy(who.t, 'tools/call', { name: 'run_card_poll', arguments: { run_id: runId, wait_s: 10, since: poll.structuredContent.progress.cursor } });
    await new Promise((r) => setTimeout(r, 200));
    await app.get(TasksService).transition(who.userId, runId, 'cancelled', { stopReason: 'cancelled' });
    const woke = (await waiting).json.result;
    expect(woke.structuredContent.progress).toMatchObject({ status: 'cancelled', changed: true });
    expect((await legacy(who.t, 'tools/call', { name: 'run_card_poll', arguments: { run_id: runId, wait_s: 26 } })).json.result.isError).toBe(true);
  });
});

describe('what a host checks', () => {
  it('the structured results of a running run with a budget match the published outputSchema (JSON Schema)', async () => {
    // Found with the reference host: the MCP SDK client refused run_status for any run with a budget,
    // because the budget's `effective` schema could match no value (fixed in console.responses.ts).
    const who = await login(`mcp-apps-schema-${stamp}@example.test`);
    const start = (await legacy(who.t, 'tools/call', { name: 'run_goal', arguments: { goal: `Schema ${randomUUID()}` } })).json.result;
    const runId = start.structuredContent.id as string;
    await app.get(TasksService).transition(who.userId, runId, 'running');
    const balanced = builtinPolicy('builtin:balanced')!;
    // The budget a run's first step snapshots (goal-runner.service.ts), as the runner writes it.
    await app.get(PrismaService).run.update({
      where: { id: runId },
      data: {
        policySnapshot: JSON.parse(
          JSON.stringify({ ref: balanced.id, name: balanced.name, version: balanced.version, builtin: true, source: 'system_default', spec: balanced.spec, tiers: null, takenAt: new Date().toISOString(), effectiveBudget: computeEffectiveBudget(balanced.spec.budget, null) }),
        ),
      },
    });
    expect(balanced).toBeDefined();
    const ajv = new Ajv2020({ strict: false, allErrors: true });
    const tools = (await oauth(who, 'tools/list')).result.tools as Json[];
    for (const [name, args] of [
      ['run_status', { run_id: runId, steps: 0 }],
      ['run_card_poll', { run_id: runId, wait_s: 0 }],
      ['run_wait', { run_id: runId, wait_s: 0 }],
    ] as const) {
      const r = (await legacy(who.t, 'tools/call', { name, arguments: args })).json.result;
      expect([name, r.isError ?? false]).toEqual([name, false]);
      if (name !== 'run_wait') expect(r.structuredContent.budget).toMatchObject({ effective: { warnAtPercent: expect.any(Number) } });
      const validate = ajv.compile(tools.find((x) => x.name === name).outputSchema);
      expect([name, validate(r.structuredContent) ? [] : validate.errors]).toEqual([name, []]);
    }
  });
});

describe('a missing widget', () => {
  it('is neither listed nor linked, and every tool call works as before', async () => {
    const who = await login(`mcp-apps-missing-${stamp}@example.test`);
    const empty = mkdtempSync(join(tmpdir(), 'mcp-ui-empty-'));
    const previous = fixtureDir;
    try {
      setMcpUiDistDir(empty);
      expect((await legacy(who.t, 'resources/list')).json.result.resources).toEqual([]);
      expect((await legacy(who.t, 'resources/read', { uri: RUN_CARD_URI })).json.error.code).toBe(-32002);
      const tools = (await legacy(who.t, 'tools/list')).json.result.tools as Json[];
      expect(tools.filter((x) => x._meta)).toEqual([]);
      const start = (await legacy(who.t, 'tools/call', { name: 'run_goal', arguments: { goal: `No card ${randomUUID()}` } })).json.result;
      expect(start.isError).toBeFalsy();
      expect(start.structuredContent.progress.status).toBe('queued');
    } finally {
      setMcpUiDistDir(previous);
      rmSync(empty, { recursive: true, force: true });
    }
  });
});
