// Chat-friendly runs (#463) against a real database: run_wait on the run
// event bus, run_goal and task_run with wait_s, the progress block, the
// screenshot, answering a run's question from a chat (personal access token
// and OAuth), and the 2026-07-28 multi round-trip elicitation.
import { randomUUID } from 'node:crypto';
import { Logger } from '@nestjs/common';
import type { NestFastifyApplication } from '@nestjs/platform-fastify';

import { createApp } from '../src/main';
import { FabricClient } from '../src/fabric/fabric.client';
import { McpDispatcher } from '../src/mcp/mcp.dispatcher';
import { MCP_VERSIONS, META, type McpRequestContext } from '../src/mcp/mcp.protocol';
import { encodeCursor } from '../src/mcp/run-progress';
import { PrismaService } from '../src/prisma/prisma.service';
import { QuestionsService } from '../src/questions/questions.service';
import type { QuestionSpec } from '../src/questions/questions.contract';
import { TasksService } from '../src/tasks/tasks.service';
import { MCP_SCOPE_IDS } from '../src/mcp/mcp.scopes';

let app: NestFastifyApplication;
const stamp = `${Date.now()}`;
const APP_URL = 'https://console.example.test';
const workerMode = process.env.JOBS_WORKER_MODE;
const appUrl = process.env.APP_URL;
/** Every log line, to prove no secret answer ever reaches one. */
const logged: string[] = [];

beforeAll(async () => {
  // No job worker: the runs here are moved by the test, never driven.
  process.env.JOBS_WORKER_MODE = 'off';
  process.env.APP_URL = APP_URL;
  app = await createApp();
  await app.init();
  await app.getHttpAdapter().getInstance().ready();
  if (workerMode === undefined) delete process.env.JOBS_WORKER_MODE;
  else process.env.JOBS_WORKER_MODE = workerMode;
  for (const level of ['log', 'warn', 'error', 'debug', 'verbose'] as const) {
    jest.spyOn(Logger.prototype, level).mockImplementation(function (this: unknown, ...args: unknown[]) {
      logged.push(args.map((a) => (typeof a === 'string' ? a : JSON.stringify(a))).join(' '));
    });
  }
});
/** Every user this file signs in: their runs are settled at the end, so no other suite sees them waiting (the reminder sweep is global). */
const users = new Set<string>();

afterAll(async () => {
  if (app && users.size) {
    await app.get(PrismaService).run.updateMany({ where: { userId: { in: [...users] }, status: { in: ['queued', 'running', 'waiting_human'] } }, data: { status: 'cancelled', remindAt: null, finishedAt: new Date() } });
  }
  if (appUrl === undefined) delete process.env.APP_URL;
  else process.env.APP_URL = appUrl;
  jest.restoreAllMocks();
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

type ToolResult = { content: { type: string; text?: string; data?: string }[]; structuredContent?: Record<string, any>; isError?: boolean }; // eslint-disable-line @typescript-eslint/no-explicit-any

/** A tools/call over HTTP on 2025-06-18 (a personal access token). */
async function call(t: string, name: string, args: Record<string, unknown>): Promise<ToolResult> {
  const res = await app.inject({
    method: 'POST',
    url: '/api/mcp',
    headers: { authorization: `Bearer ${t}`, 'content-type': 'application/json', 'mcp-protocol-version': '2025-06-18' },
    payload: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args } }),
  });
  return (JSON.parse(res.body) as { result: ToolResult }).result;
}

/** The same call as an app signed in with OAuth (the credential kind E33.1 brings; the token here is a session). */
async function callOauth(who: { t: string; userId: string }, name: string, args: Record<string, unknown>): Promise<ToolResult> {
  const rctx: McpRequestContext = { version: '2025-06-18', flags: MCP_VERSIONS['2025-06-18'], clientInfo: { name: 'claude-ai' }, credential: { kind: 'oauth', scopes: [...MCP_SCOPE_IDS] } as never };
  const out = await app.get(McpDispatcher).dispatch({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args } }, rctx, `Bearer ${who.t}`, undefined, { userId: who.userId });
  return out!.body.result as ToolResult;
}

/** A 2026-07-28 tools/call over HTTP, with `elicitation` declared or not. */
async function modern(t: string, name: string, args: Record<string, unknown>, opts: { elicitation?: boolean; inputResponses?: unknown; requestState?: string; version?: string } = {}) {
  const version = opts.version ?? '2026-07-28';
  const caps = opts.elicitation === false ? {} : { elicitation: {} };
  const params: Record<string, unknown> = {
    name,
    arguments: args,
    ...(opts.inputResponses !== undefined ? { inputResponses: opts.inputResponses } : {}),
    ...(opts.requestState !== undefined ? { requestState: opts.requestState } : {}),
    _meta: { [META.protocolVersion]: version, [META.clientInfo]: { name: 'test-client', version: '1' }, [META.clientCapabilities]: caps },
  };
  const headers: Record<string, string> = { authorization: `Bearer ${t}`, 'content-type': 'application/json', 'mcp-protocol-version': version, 'mcp-method': 'tools/call', 'mcp-name': name };
  const res = await app.inject({ method: 'POST', url: '/api/mcp', headers, payload: JSON.stringify({ jsonrpc: '2.0', id: randomUUID(), method: 'tools/call', params }) });
  return JSON.parse(res.body) as { result?: Record<string, any>; error?: { code: number; message: string } }; // eslint-disable-line @typescript-eslint/no-explicit-any
}

async function newRun(t: string, goal = `Goal ${randomUUID()}`): Promise<string> {
  const r = await call(t, 'run_goal', { goal });
  expect(r.isError).toBeFalsy();
  return r.structuredContent!.id as string;
}

/** A question as the REST API takes it (options as bare labels, constraints by input). */
type RawSpec = { input: QuestionSpec['input'] } & Record<string, unknown>;

const tasks = () => app.get(TasksService);
const questions = () => app.get(QuestionsService);

/** A run waiting on a question of the given kind (a free-standing question tied to the run; a secret is tied to a browser session id). */
async function waitingOn(who: { t: string; userId: string }, spec: RawSpec): Promise<{ runId: string; questionId: string }> {
  const runId = await newRun(who.t);
  await tasks().transition(who.userId, runId, 'running');
  const q = await questions().create(
    { id: who.userId },
    questions().parseSpec({ prompt: 'Which size should I pick?', ...spec }),
    { askedBy: `run:${runId}`, runId, ...(spec.input === 'secret' ? { fabricSessionId: randomUUID() } : {}) },
  );
  await tasks().transition(who.userId, runId, 'waiting_human');
  return { runId, questionId: q.id };
}

describe('run_wait', () => {
  it('returns at once for a finished run, within a second of a status change, and changed: false at wait_s', async () => {
    const who = await login(`mcp-runs-wait-${stamp}@example.test`);
    const done = await newRun(who.t);
    await tasks().transition(who.userId, done, 'running');
    await tasks().transition(who.userId, done, 'succeeded', { result: 'Three items in the cart', stopReason: 'finished' });
    let t0 = Date.now();
    const finished = await call(who.t, 'run_wait', { run_id: done, wait_s: 30 });
    expect(Date.now() - t0).toBeLessThan(2_000);
    expect(finished.structuredContent).toMatchObject({ run_id: done, status: 'succeeded', changed: true, result: 'Three items in the cart', console_url: `${APP_URL}/runs/${done}` });
    expect(finished.content[0].text).toMatch(/^Content from the web page .*\nFinished \(/s);

    const live = await newRun(who.t);
    // Starting is not news by itself: a quiet wait answers changed: false at wait_s.
    t0 = Date.now();
    const started = call(who.t, 'run_wait', { run_id: live, wait_s: 1 });
    await tasks().transition(who.userId, live, 'running');
    const quiet = await started;
    expect(Date.now() - t0).toBeGreaterThanOrEqual(1_000);
    expect(quiet.structuredContent).toMatchObject({ status: 'running', changed: false });

    const waiting = call(who.t, 'run_wait', { run_id: live, wait_s: 20, since: quiet.structuredContent!.cursor });
    await new Promise((r) => setTimeout(r, 300));
    const changedAt = Date.now();
    await tasks().transition(who.userId, live, 'failed', { error: 'The shop is closed', stopReason: 'error' });
    const woke = await waiting;
    expect(Date.now() - changedAt).toBeLessThan(1_000);
    expect(woke.structuredContent).toMatchObject({ status: 'failed', changed: true, stop_reason: 'Stopped by an error: The shop is closed' });

    // since: the change already reported is not reported again (a finished run answers at once).
    t0 = Date.now();
    const again = await call(who.t, 'run_wait', { run_id: live, wait_s: 5, since: woke.structuredContent!.cursor });
    expect(Date.now() - t0).toBeLessThan(2_000);
    expect(again.structuredContent).toMatchObject({ status: 'failed', changed: false });
  });

  it('throttles step progress to one wake-up per 10 s', async () => {
    const who = await login(`mcp-runs-steps-${stamp}@example.test`);
    const runId = await newRun(who.t);
    await tasks().transition(who.userId, runId, 'running');
    // The last report was 8 s ago: the next step report is due 2 s from now, however many steps come before.
    const since = encodeCursor({ s: 'running', n: 0, q: null, t: Date.now() - 8_000 });
    const prisma = app.get(PrismaService);
    const t0 = Date.now();
    const waiting = call(who.t, 'run_wait', { run_id: runId, wait_s: 20, since });
    for (let i = 1; i <= 5; i += 1) {
      await new Promise((r) => setTimeout(r, 150));
      await prisma.forUser({ userId: who.userId }).run.updateMany({ where: { id: runId }, data: { stepCount: i } });
      await tasks().stepRecorded(who.userId, runId, i);
    }
    const r = await waiting;
    const took = Date.now() - t0;
    expect(took).toBeGreaterThanOrEqual(1_800);
    expect(took).toBeLessThan(4_000);
    expect(r.structuredContent).toMatchObject({ changed: true, steps_done: 5 });
  });

  it('200 waiters on one run read nothing while idle and all return on one event', async () => {
    const who = await login(`mcp-runs-many-${stamp}@example.test`);
    const runId = await newRun(who.t);
    const getRun = jest.spyOn(tasks(), 'getRun');
    const listQuestions = jest.spyOn(questions(), 'list');
    try {
      const waiters = Array.from({ length: 200 }, () => call(who.t, 'run_wait', { run_id: runId, wait_s: 30 }));
      // Each waiter reads the run once, then waits on the bus.
      for (let i = 0; i < 100 && (getRun.mock.calls.length < 200 || listQuestions.mock.calls.length < 200); i += 1) await new Promise((r) => setTimeout(r, 50));
      expect(getRun.mock.calls.length).toBe(200);
      getRun.mockClear();
      listQuestions.mockClear();
      await new Promise((r) => setTimeout(r, 1_000));
      expect([getRun.mock.calls.length, listQuestions.mock.calls.length]).toEqual([0, 0]);
      await tasks().transition(who.userId, runId, 'cancelled', { stopReason: 'cancelled' });
      const out = await Promise.all(waiters);
      expect(out.every((r) => r.structuredContent?.status === 'cancelled' && r.structuredContent?.changed === true)).toBe(true);
      expect(getRun.mock.calls.length).toBe(200);
    } finally {
      getRun.mockRestore();
      listQuestions.mockRestore();
    }
  });

  it("another user's run is the REST 404, mapped", async () => {
    const a = await login(`mcp-runs-owner-${stamp}@example.test`);
    const b = await login(`mcp-runs-other-${stamp}@example.test`);
    const runId = await newRun(a.t);
    const r = await call(b.t, 'run_wait', { run_id: runId, wait_s: 1 });
    expect(r.isError).toBe(true);
    expect(r.content[0].text).toMatch(/^No run with that id\. Use runs_list to find it\./);
  });
});

describe('run_goal and task_run with wait_s', () => {
  it('returns the final result of a run that completes inside the wait, and the progress block otherwise; PAT default 0, OAuth default 45', async () => {
    const who = await login(`mcp-runs-start-${stamp}@example.test`);
    const prisma = app.get(PrismaService);
    const goal = `Find a fare ${randomUUID()}`;
    const finishSoon = async () => {
      for (let i = 0; i < 50; i += 1) {
        const run = await prisma.forUser({ userId: who.userId }).run.findFirst({ where: { goal } });
        if (run) {
          await tasks().transition(who.userId, run.id, 'running');
          await tasks().transition(who.userId, run.id, 'succeeded', { result: 'The cheapest fare is 120 EUR', stopReason: 'finished' });
          return;
        }
        await new Promise((r) => setTimeout(r, 50));
      }
    };
    const [done] = await Promise.all([call(who.t, 'run_goal', { goal, wait_s: 10 }), finishSoon()]);
    expect(done.structuredContent).toMatchObject({ status: 'succeeded', result: 'The cheapest fare is 120 EUR', progress: { status: 'succeeded', result: 'The cheapest fare is 120 EUR', needs_human: false } });
    expect(done.structuredContent).not.toHaveProperty('steps');

    // A run that does not finish inside the wait: the progress block, changed: false.
    const slow = await call(who.t, 'run_goal', { goal: 'Slow goal', wait_s: 1 });
    expect(slow.structuredContent).toMatchObject({ status: 'queued', progress: { status: 'queued', changed: false, activity: 'Waiting to start' } });

    // Personal access token: no wait by default (today's behaviour).
    let t0 = Date.now();
    const pat = await call(who.t, 'run_goal', { goal: 'Quick goal' });
    expect(Date.now() - t0).toBeLessThan(2_000);
    expect(pat.structuredContent).toMatchObject({ status: 'queued', progress: { status: 'queued', console_url: expect.stringMatching(/^https:\/\/console\.example\.test\/runs\//) } });

    // OAuth: 45 s by default, so a run that finishes meanwhile comes back finished.
    const goal2 = `Find a hotel ${randomUUID()}`;
    t0 = Date.now();
    const finish2 = (async () => {
      for (let i = 0; i < 50; i += 1) {
        const run = await prisma.forUser({ userId: who.userId }).run.findFirst({ where: { goal: goal2 } });
        if (run) {
          await new Promise((r) => setTimeout(r, 1_500));
          await tasks().transition(who.userId, run.id, 'running');
          await tasks().transition(who.userId, run.id, 'failed', { error: 'over budget', stopReason: 'budget_cost' });
          return;
        }
        await new Promise((r) => setTimeout(r, 50));
      }
    })();
    const [oauth] = await Promise.all([callOauth(who, 'run_goal', { goal: goal2 }), finish2]);
    expect(Date.now() - t0).toBeGreaterThanOrEqual(1_500);
    expect(oauth.structuredContent).toMatchObject({ status: 'failed', progress: { stop_reason: 'Stopped: it reached the cost limit of its policy' } });

    // task_run takes the same wait.
    const task = await call(who.t, 'task_create', { name: `Wait task ${stamp}`, goal: 'g' });
    const tr = await call(who.t, 'task_run', { task_id: task.structuredContent!.id, wait_s: 1 });
    expect(tr.structuredContent).toMatchObject({ status: 'queued', progress: { changed: false } });
  });
});

describe('the progress block of a waiting run', () => {
  it('needs_human with the typed question; answerable_here per the table; how_to_answer with the inbox link', async () => {
    const who = await login(`mcp-runs-progress-${stamp}@example.test`);
    const choice = await waitingOn(who, { input: 'choice', options: ['Small', 'Large'] });
    const s = await call(who.t, 'run_status', { run_id: choice.runId });
    expect(s.structuredContent!.progress).toMatchObject({
      status: 'waiting_human',
      needs_human: true,
      question: { id: choice.questionId, input: 'choice', prompt: 'Which size should I pick?', options: [{ id: 'Small', label: 'Small' }, { id: 'Large', label: 'Large' }], answerable_here: true, expires_at: expect.any(String) },
    });
    // run_status keeps its REST fields for clients that read them.
    expect(s.structuredContent).toMatchObject({ id: choice.runId, status: 'waiting_human', steps: [], olderSteps: 0 });

    const secret = await waitingOn(who, { input: 'secret', kind: 'code' });
    const p = (await call(who.t, 'run_wait', { run_id: secret.runId, wait_s: 0 })).structuredContent!;
    expect(p.question).toMatchObject({ input: 'secret', answerable_here: false, how_to_answer: `Open your Hexactra inbox to answer this: ${APP_URL}/inbox/q/${secret.questionId}` });

    const high = await waitingOn(who, { input: 'confirm', risk: 'high' });
    expect((await callOauth(who, 'run_wait', { run_id: high.runId, wait_s: 0 })).structuredContent!.question).toMatchObject({ answerable_here: false });
    // A personal access token is a signed-in channel: it may pass on a high-risk confirm.
    expect((await call(who.t, 'run_wait', { run_id: high.runId, wait_s: 0 })).structuredContent!.question).toMatchObject({ answerable_here: true });
    const low = await waitingOn(who, { input: 'confirm', risk: 'low' });
    expect((await callOauth(who, 'run_wait', { run_id: low.runId, wait_s: 0 })).structuredContent!.question).toMatchObject({ answerable_here: true });
  });
});

describe('screenshots', () => {
  it('adds an image within the limits, withholds it during a secret, and degrades to text', async () => {
    const who = await login(`mcp-runs-shot-${stamp}@example.test`);
    const fabric = app.get(FabricClient);
    const jpeg = Buffer.alloc(4_000, 9);
    const request = jest.spyOn(fabric, 'request').mockImplementation((async (method: string, path: string) => {
      if (method === 'POST' && path.endsWith('/actions')) return { id: randomUUID(), state: 'succeeded', result: { artifact_id: 'art-1' } };
      return undefined;
    }) as never);
    const raw = jest.spyOn(fabric, 'raw').mockImplementation((async () => new Response(jpeg, { headers: { 'content-type': 'image/jpeg' } })) as never);
    try {
      const runId = await newRun(who.t);
      await tasks().transition(who.userId, runId, 'running', { sessionId: randomUUID() });
      const r = await call(who.t, 'run_wait', { run_id: runId, wait_s: 0, screenshot: true });
      expect(r.content.map((c) => c.type)).toEqual(['text', 'image']);
      expect(Buffer.from(r.content[1].data!, 'base64').length).toBe(jpeg.length);
      expect(r.structuredContent).toMatchObject({ screenshot: 'included' });

      // A secret is being entered on the run: no picture.
      await questions().create({ id: who.userId }, questions().parseSpec({ input: 'secret', kind: 'code', prompt: 'The code from your phone' }), { askedBy: `run:${runId}`, runId, fabricSessionId: randomUUID() });
      const hidden = await call(who.t, 'run_status', { run_id: runId, screenshot: true });
      expect(hidden.content.map((c) => c.type)).toEqual(['text']);
      expect(hidden.structuredContent!.progress).toMatchObject({ screenshot: 'hidden', screenshot_note: 'Hidden while a code or password is being entered' });

      // The browser machine is gone: text only, with a note.
      raw.mockRejectedValue(new Error('offline'));
      request.mockRejectedValue(new Error('offline'));
      const other = await newRun(who.t);
      await tasks().transition(who.userId, other, 'running', { sessionId: randomUUID() });
      const none = await call(who.t, 'run_wait', { run_id: other, wait_s: 0, screenshot: true });
      expect(none.content.map((c) => c.type)).toEqual(['text']);
      expect(none.structuredContent).toMatchObject({ screenshot: 'unavailable', screenshot_note: expect.stringMatching(/^No screenshot/) });
    } finally {
      request.mockRestore();
      raw.mockRestore();
    }
  });
});

describe('answering from the chat (inbox_answer)', () => {
  it('OAuth answers a choice, refuses a secret and a high-risk confirm with the console link; a PAT is unchanged; a second answer reports the first', async () => {
    const who = await login(`mcp-runs-answer-${stamp}@example.test`);
    const choice = await waitingOn(who, { input: 'choice', options: ['Small', 'Large'] });
    const ok = await callOauth(who, 'inbox_answer', { run_id: choice.runId, outcome: 'completed', value: 'Large' });
    expect(ok.isError).toBeFalsy();
    expect(ok.structuredContent).toMatchObject({ status: 'answered', value: 'Large', channel: 'mcp-oauth.claude', progress: { run_id: choice.runId } });

    const secret = await waitingOn(who, { input: 'secret', kind: 'code' });
    const refused = await callOauth(who, 'inbox_answer', { question_id: secret.questionId, outcome: 'completed', value: 's3cr3t-value-123' });
    expect(refused.isError).toBe(true);
    expect(refused.content[0].text).toContain(`${APP_URL}/inbox/q/${secret.questionId}`);
    expect(refused.content[0].text).toMatch(/NOT_ANSWERABLE_HERE/);
    // The questions service is the authority: the OAuth channel cannot record a secret even past the tool.
    const direct = await app.inject({ method: 'POST', url: `/api/questions/${secret.questionId}/answer`, headers: { authorization: `Bearer ${who.t}`, 'content-type': 'application/json' }, payload: { outcome: 'completed', value: 's3cr3t-value-123', channel: 'mcp-oauth.claude' } });
    // 403 (the platform's error filter reports the code of every 403 as FORBIDDEN; the message says why).
    expect([direct.statusCode, JSON.parse(direct.body).message]).toEqual([403, expect.stringMatching(/^A code or password cannot be answered from an AI app connected with OAuth/)]);
    expect(direct.body).not.toContain('s3cr3t');

    const high = await waitingOn(who, { input: 'confirm', risk: 'high' });
    const highRefused = await callOauth(who, 'inbox_answer', { run_id: high.runId, outcome: 'completed', value: 'approve' });
    expect(highRefused.isError).toBe(true);
    expect(highRefused.content[0].text).toContain(`${APP_URL}/inbox/q/${high.questionId}`);
    // Declining is allowed from anywhere.
    expect((await callOauth(who, 'inbox_answer', { run_id: high.runId, outcome: 'cancelled' })).structuredContent).toMatchObject({ status: 'cancelled' });

    // A personal access token keeps today's behaviour: it may approve a high-risk confirm (channel mcp).
    const high2 = await waitingOn(who, { input: 'confirm', risk: 'high' });
    const pat = await call(who.t, 'inbox_answer', { question_id: high2.questionId, outcome: 'completed', value: 'approve' });
    expect(pat.structuredContent).toMatchObject({ status: 'answered', value: 'approve', channel: 'mcp' });

    // First answer wins: the second learns what the first was.
    const second = await callOauth(who, 'inbox_answer', { question_id: choice.questionId, outcome: 'completed', value: 'Small' });
    expect(second.isError).toBeFalsy();
    expect(second.structuredContent).toMatchObject({ already_answered: true, value: 'Large' });
    expect(second.content[0].text).toMatch(/already answered on another device/);
  });
});

describe('multi round-trip elicitation (2026-07-28)', () => {
  const cases: [string, RawSpec, Record<string, unknown>, unknown, Record<string, unknown>][] = [
    ['text', { input: 'text', constraints: { maxLength: 30 } }, { type: 'string', maxLength: 30 }, 'Blue', { value: 'Blue' }],
    ['choice', { input: 'choice', options: ['Small', 'Large'] }, { type: 'string', oneOf: [{ const: 'Small', title: 'Small' }, { const: 'Large', title: 'Large' }] }, 'Small', { value: 'Small' }],
    ['multi_choice', { input: 'multi_choice', options: ['A', 'B', 'C'] }, { type: 'array', items: { anyOf: expect.any(Array) }, minItems: 1, maxItems: 3 }, ['A', 'C'], { values: ['A', 'C'] }],
    ['number', { input: 'number', constraints: { min: 1, max: 5 } }, { type: 'number', minimum: 1, maximum: 5 }, 3, { value: '3' }],
    ['low-risk confirm', { input: 'confirm', risk: 'low' }, { type: 'boolean' }, true, { value: 'approve' }],
  ];

  it.each(cases)('%s: input_required with its schema; accept records the answer (channel and client) and the call continues', async (label, spec, schema, answer, recorded) => {
    const who = await login(`mcp-runs-elicit-${label.replace(/\W/g, '')}-${stamp}@example.test`);
    const w = await waitingOn(who, spec);
    const first = await modern(who.t, 'run_wait', { run_id: w.runId, wait_s: 2 });
    expect(first.result).toMatchObject({ resultType: 'input_required', inputRequests: { hexactra_question: { method: 'elicitation/create', params: { mode: 'form', message: 'Your Hexactra agent asks: Which size should I pick?' } } } });
    expect(first.result!.inputRequests.hexactra_question.params.requestedSchema).toMatchObject({ type: 'object', properties: { answer: schema }, required: ['answer'] });
    expect(typeof first.result!.requestState).toBe('string');

    const retry = await modern(who.t, 'run_wait', { run_id: w.runId, wait_s: 2 }, { inputResponses: { hexactra_question: { action: 'accept', content: { answer } } }, requestState: first.result!.requestState });
    expect(retry.result).toMatchObject({ resultType: 'complete', structuredContent: { run_id: w.runId } });
    const q = await questions().get(who.userId, w.questionId);
    expect(q).toMatchObject({ status: 'answered', response: { outcome: 'completed', channel: 'mcp-elicitation.other', ...recorded } });
  });

  it('decline leaves the question pending; a bad or foreign requestState is refused', async () => {
    const who = await login(`mcp-runs-decline-${stamp}@example.test`);
    const w = await waitingOn(who, { input: 'choice', options: ['Small', 'Large'] });
    const first = await modern(who.t, 'run_wait', { run_id: w.runId, wait_s: 0 });
    const declined = await modern(who.t, 'run_wait', { run_id: w.runId, wait_s: 0 }, { inputResponses: { hexactra_question: { action: 'decline' } }, requestState: first.result!.requestState });
    expect(declined.result).toMatchObject({ resultType: 'complete', structuredContent: { needs_human: true, question: { id: w.questionId } } });
    expect((await questions().get(who.userId, w.questionId)).status).toBe('pending');

    const tampered = await modern(who.t, 'run_wait', { run_id: w.runId, wait_s: 0 }, { inputResponses: { hexactra_question: { action: 'accept', content: { answer: 'Small' } } }, requestState: `${first.result!.requestState}x` });
    expect(tampered.error).toMatchObject({ code: -32602 });
    const other = await login(`mcp-runs-decline-other-${stamp}@example.test`);
    const foreign = await modern(other.t, 'run_wait', { run_id: w.runId, wait_s: 0 }, { inputResponses: { hexactra_question: { action: 'accept', content: { answer: 'Small' } } }, requestState: first.result!.requestState });
    expect(foreign.error).toMatchObject({ code: -32602 });
    expect((await questions().get(who.userId, w.questionId)).status).toBe('pending');
  });

  it('run_goal retried with an answer follows the same run instead of starting another', async () => {
    const who = await login(`mcp-runs-elicit-goal-${stamp}@example.test`);
    const prisma = app.get(PrismaService);
    const goal = `Buy shoes ${randomUUID()}`;
    const ask = (async () => {
      for (let i = 0; i < 50; i += 1) {
        const run = await prisma.forUser({ userId: who.userId }).run.findFirst({ where: { goal } });
        if (run) {
          await tasks().transition(who.userId, run.id, 'running');
          await questions().create({ id: who.userId }, questions().parseSpec({ input: 'choice', prompt: 'Which size?', options: ['40', '41'] }), { askedBy: `run:${run.id}`, runId: run.id });
          await tasks().transition(who.userId, run.id, 'waiting_human');
          return run.id;
        }
        await new Promise((r) => setTimeout(r, 50));
      }
      return null;
    })();
    const [first, runId] = await Promise.all([modern(who.t, 'run_goal', { goal, wait_s: 3 }), ask]);
    expect(first.result).toMatchObject({ resultType: 'input_required' });
    const retry = await modern(who.t, 'run_goal', { goal, wait_s: 3 }, { inputResponses: { hexactra_question: { action: 'accept', content: { answer: '41' } } }, requestState: first.result!.requestState });
    expect(retry.result).toMatchObject({ resultType: 'complete', structuredContent: { id: runId } });
    expect(await prisma.forUser({ userId: who.userId }).run.count({ where: { goal } })).toBe(1);
  });

  it('never elicits a secret, a takeover or a high-risk confirm, and never on 2025-11-25 or without the capability', async () => {
    const who = await login(`mcp-runs-never-${stamp}@example.test`);
    for (const spec of [{ input: 'secret' as const, kind: 'code' as const }, { input: 'takeover' as const }, { input: 'confirm' as const, risk: 'high' as const }]) {
      const w = await waitingOn(who, spec);
      const r = await modern(who.t, 'run_wait', { run_id: w.runId, wait_s: 0 });
      expect([spec.input, r.result?.resultType, r.result?.structuredContent?.needs_human]).toEqual([spec.input, 'complete', true]);
    }
    const w = await waitingOn(who, { input: 'choice', options: ['Small', 'Large'] });
    const old = await modern(who.t, 'run_wait', { run_id: w.runId, wait_s: 0 }, { version: '2025-11-25' });
    expect(old.result).not.toHaveProperty('resultType');
    expect(old.result).not.toHaveProperty('inputRequests');
    expect(old.result!.structuredContent).toMatchObject({ needs_human: true });
    const noCap = await modern(who.t, 'run_wait', { run_id: w.runId, wait_s: 0 }, { elicitation: false });
    expect(noCap.result).toMatchObject({ resultType: 'complete' });
  });
});

describe('secrets stay out of the logs', () => {
  it('no log line holds the secret value a test tried to send', () => {
    expect(logged.length).toBeGreaterThan(0);
    expect(logged.filter((l) => l.includes('s3cr3t'))).toEqual([]);
  });
});
