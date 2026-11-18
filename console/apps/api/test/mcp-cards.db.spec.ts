// The question and tasks cards (#467) against a real database: the app-only
// question_card_answer records channel `mcp-app.<client>`; a forged card
// answer to a secret, a high-risk confirm or a takeover is refused (by the
// tool and, past it, by the questions service); the first answer wins
// against the console; an expired question answers its state; the question
// tools carry the typed question, the console URL and the scopes; tasks_list
// carries the summary fields the tasks card needs, small, paged and matching
// its published outputSchema.
import { randomUUID } from 'node:crypto';

import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import Ajv2020 from 'ajv/dist/2020';

import { createApp } from '../src/main';
import { McpDispatcher } from '../src/mcp/mcp.dispatcher';
import { MCP_VERSIONS, type McpRequestContext } from '../src/mcp/mcp.protocol';
import { MCP_SCOPE_IDS } from '../src/mcp/mcp.scopes';
import { TASKS_LIST_GOAL_CHARS } from '../src/mcp/mcp.tools';
import { PrismaService } from '../src/prisma/prisma.service';
import type { QuestionSpec } from '../src/questions/questions.contract';
import { QuestionsService } from '../src/questions/questions.service';
import { TasksService } from '../src/tasks/tasks.service';

let app: NestFastifyApplication;
const stamp = `${Date.now()}`;
const APP_URL = 'https://console.example.test';
const workerMode = process.env.JOBS_WORKER_MODE;
const appUrl = process.env.APP_URL;
const users = new Set<string>();

beforeAll(async () => {
  process.env.JOBS_WORKER_MODE = 'off';
  process.env.APP_URL = APP_URL;
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
  if (appUrl === undefined) delete process.env.APP_URL;
  else process.env.APP_URL = appUrl;
  await app?.close();
});

type Who = { t: string; userId: string };
type Json = any; // eslint-disable-line @typescript-eslint/no-explicit-any
type ToolResult = { content: { type: string; text?: string }[]; structuredContent?: Record<string, Json>; isError?: boolean };

async function login(email: string): Promise<Who> {
  const res = await app.inject({ method: 'POST', url: '/api/auth/test/login', payload: { email, role: 'contributor' } });
  const t = new URL(String(res.headers.location)).searchParams.get('token')!;
  const me = await app.inject({ method: 'GET', url: '/api/auth/me', headers: { authorization: `Bearer ${t}` } });
  const userId = (JSON.parse(me.body) as { data: { id: string } }).data.id;
  users.add(userId);
  return { t, userId };
}

/** A tools/call through the dispatcher as a client (`claude-ai`: bucket `claude`), signed in with OAuth or a personal access token. */
async function call(who: Who, name: string, args: Record<string, unknown>, kind: 'oauth' | 'pat' = 'oauth'): Promise<ToolResult> {
  const rctx: McpRequestContext = { version: '2025-06-18', flags: MCP_VERSIONS['2025-06-18'], clientInfo: { name: 'claude-ai' }, credential: { kind } as never };
  const out = await app.get(McpDispatcher).dispatch({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args } }, rctx, `Bearer ${who.t}`, undefined, { userId: who.userId });
  return out!.body.result as ToolResult;
}

async function toolsList(who: Who): Promise<Json[]> {
  const rctx: McpRequestContext = { version: '2025-06-18', flags: MCP_VERSIONS['2025-06-18'], clientInfo: { name: 'claude-ai' }, credential: { kind: 'oauth' } as never };
  const out = await app.get(McpDispatcher).dispatch({ jsonrpc: '2.0', id: 1, method: 'tools/list', params: {} }, rctx, `Bearer ${who.t}`, undefined, { userId: who.userId });
  return (out!.body.result as { tools: Json[] }).tools;
}

const questions = () => app.get(QuestionsService);
const tasks = () => app.get(TasksService);

/** A free-standing question, or one a waiting run asks (a secret is tied to a browser session id). */
async function ask(who: Who, spec: { input: QuestionSpec['input'] } & Record<string, unknown>, opts: { run?: boolean } = {}): Promise<{ questionId: string; runId: string | null }> {
  let runId: string | null = null;
  if (opts.run) {
    const r = await call(who, 'run_goal', { goal: `Card ${randomUUID()}`, wait_s: 0 }, 'pat');
    runId = r.structuredContent!.id as string;
    await tasks().transition(who.userId, runId, 'running');
  }
  const q = await questions().create(
    { id: who.userId },
    questions().parseSpec({ prompt: 'Which size should I pick?', ...spec }),
    { askedBy: runId ? `run:${runId}` : 'agent:packer', ...(runId ? { runId } : {}), ...(spec.input === 'secret' ? { fabricSessionId: randomUUID() } : {}) },
  );
  if (runId) await tasks().transition(who.userId, runId, 'waiting_human');
  return { questionId: q.id, runId };
}

describe('question_card_answer (the question card, channel mcp-app)', () => {
  it('records a choice under mcp-app.<client> for OAuth and for a personal access token, and returns the run progress', async () => {
    const who = await login(`mcp-cards-answer-${stamp}@example.test`);
    const w = await ask(who, { input: 'choice', options: ['Small', 'Large'] }, { run: true });
    const r = await call(who, 'question_card_answer', { question_id: w.questionId, outcome: 'completed', value: 'Large' });
    expect(r.isError).toBeFalsy();
    expect(r.structuredContent).toMatchObject({ status: 'answered', value: 'Large', channel: 'mcp-app.claude', progress: { run_id: w.runId }, app_url: APP_URL });
    expect(await questions().get(who.userId, w.questionId)).toMatchObject({ status: 'answered', response: { channel: 'mcp-app.claude', value: 'Large' } });
    const row = await app.get(PrismaService).question.findUnique({ where: { id: w.questionId } });
    expect(row?.answeredChannel).toBe('mcp-app.claude');

    // A personal access token's card answer is still a card answer (not channel mcp).
    const n = await ask(who, { input: 'number', constraints: { max: 5 } });
    const pat = await call(who, 'question_card_answer', { question_id: n.questionId, outcome: 'completed', value: 3 }, 'pat');
    expect(pat.structuredContent).toMatchObject({ status: 'answered', value: '3', channel: 'mcp-app.claude' });
    // A low-risk confirm and an acknowledgement are allowed; validation still applies.
    const low = await ask(who, { input: 'confirm', risk: 'low' });
    expect((await call(who, 'question_card_answer', { question_id: low.questionId, outcome: 'completed', value: 'approve' })).structuredContent).toMatchObject({ status: 'answered', value: 'approve' });
    const ack = await ask(who, { input: 'none' });
    expect((await call(who, 'question_card_answer', { question_id: ack.questionId, outcome: 'completed' })).structuredContent).toMatchObject({ status: 'answered', channel: 'mcp-app.claude' });
    const bad = await ask(who, { input: 'number', constraints: { max: 5 } });
    const invalid = await call(who, 'question_card_answer', { question_id: bad.questionId, outcome: 'completed', value: 9 });
    expect(invalid.isError).toBe(true);
    expect((await questions().get(who.userId, bad.questionId)).status).toBe('pending');
  });

  it('refuses a forged answer to a secret, a high-risk confirm (also over a personal access token) or a takeover; the service refuses the channel past the tool; declining is allowed', async () => {
    const who = await login(`mcp-cards-forged-${stamp}@example.test`);
    const secret = await ask(who, { input: 'secret', kind: 'code' }, { run: true });
    const s = await call(who, 'question_card_answer', { question_id: secret.questionId, outcome: 'completed', value: 's3cr3t-value-123' });
    expect(s.isError).toBe(true);
    expect(s.content[0]!.text).toMatch(/NOT_ANSWERABLE_HERE/);
    expect(s.content[0]!.text).toContain(`${APP_URL}/inbox/q/${secret.questionId}`);
    expect(JSON.stringify(s)).not.toContain('s3cr3t');

    for (const kind of ['oauth', 'pat'] as const) {
      const high = await ask(who, { input: 'confirm', risk: 'high' });
      const h = await call(who, 'question_card_answer', { question_id: high.questionId, outcome: 'completed', value: 'approve' }, kind);
      expect([kind, h.isError]).toEqual([kind, true]);
      expect((await questions().get(who.userId, high.questionId)).status).toBe('pending');
    }
    const takeover = await ask(who, { input: 'takeover' });
    expect((await call(who, 'question_card_answer', { question_id: takeover.questionId, outcome: 'completed' })).isError).toBe(true);

    // The questions service is the authority: the mcp-app channel never records a secret or approves a high-risk confirm.
    for (const [id, payload] of [
      [secret.questionId, { outcome: 'completed', value: 's3cr3t-value-123', channel: 'mcp-app.claude' }],
      [(await ask(who, { input: 'confirm', risk: 'high' })).questionId, { outcome: 'completed', value: 'approve', channel: 'mcp-app.chatgpt' }],
    ] as const) {
      const direct = await app.inject({ method: 'POST', url: `/api/questions/${id}/answer`, headers: { authorization: `Bearer ${who.t}`, 'content-type': 'application/json' }, payload });
      expect([direct.statusCode, JSON.parse(direct.body).message]).toEqual([403, expect.stringMatching(/question card \(MCP Apps\)/)]);
      expect(direct.body).not.toContain('s3cr3t');
    }

    // Declining is allowed from anywhere.
    expect((await call(who, 'question_card_answer', { question_id: secret.questionId, outcome: 'cancelled' })).structuredContent).toMatchObject({ status: 'cancelled', channel: 'mcp-app.claude' });
  });

  it('first answer wins against the console racing it; a later card answer learns the winner; an expired question says so', async () => {
    const who = await login(`mcp-cards-race-${stamp}@example.test`);
    for (let i = 0; i < 3; i += 1) {
      const q = await ask(who, { input: 'choice', options: ['Small', 'Large'] });
      const [card, web] = await Promise.all([
        call(who, 'question_card_answer', { question_id: q.questionId, outcome: 'completed', value: 'Large' }),
        app.inject({ method: 'POST', url: `/api/questions/${q.questionId}/answer`, headers: { authorization: `Bearer ${who.t}`, 'content-type': 'application/json' }, payload: { outcome: 'completed', value: 'Small', channel: 'web' } }),
      ]);
      const stored = await questions().get(who.userId, q.questionId);
      expect(stored.status).toBe('answered');
      if (web.statusCode === 200) {
        // The console won: the card reports the console's answer.
        expect(stored.response).toMatchObject({ channel: 'web', value: 'Small' });
        expect(card.structuredContent).toMatchObject({ already_answered: true, value: 'Small', channel: 'web' });
      } else {
        expect(web.statusCode).toBe(409);
        expect(stored.response).toMatchObject({ channel: 'mcp-app.claude', value: 'Large' });
        expect(card.structuredContent).toMatchObject({ status: 'answered', value: 'Large' });
        expect(card.structuredContent!.already_answered).toBeUndefined();
      }
    }

    const late = await ask(who, { input: 'text' });
    await app.get(PrismaService).question.update({ where: { id: late.questionId }, data: { expiresAt: new Date(Date.now() - 1000) } });
    const expired = await call(who, 'question_card_answer', { question_id: late.questionId, outcome: 'completed', value: 'too late' });
    expect(expired.isError).toBeFalsy();
    expect(expired.structuredContent).toMatchObject({ question_id: late.questionId, status: 'expired' });
    expect(expired.content[0]!.text).toMatch(/expired/);
  });
});

describe('the question tools carry what the card needs', () => {
  it('inbox_list: the items with the console URL and the scopes; question_status and ask_human: the typed question', async () => {
    const who = await login(`mcp-cards-tools-${stamp}@example.test`);
    const q = await ask(who, { input: 'number', constraints: { min: 1, max: 5, unit: 'bags' } });
    const list = await call(who, 'inbox_list', {});
    expect(list.structuredContent).toMatchObject({ app_url: APP_URL, granted_scopes: [...MCP_SCOPE_IDS] });
    expect(list.structuredContent!.items.find((x: Json) => x.questionId === q.questionId)).toMatchObject({ input: 'number', constraints: { min: 1, max: 5, unit: 'bags' } });
    // The text is still the bare list (clients without structured content).
    expect(list.content[0]!.text).toContain(q.questionId);

    const st = await call(who, 'question_status', { question_id: q.questionId });
    expect(st.structuredContent).toMatchObject({
      status: 'pending',
      question: { id: q.questionId, input: 'number', prompt: 'Which size should I pick?', constraints: { min: 1, max: 5, unit: 'bags' }, run_id: null, asked_by: 'agent:packer', answerable_here: true },
      app_url: APP_URL,
    });
    const asked = await call(who, 'ask_human', { prompt: 'Ship now?', input: 'confirm', risk: 'low', confirm_label: 'Ship it', deny_label: 'Hold' });
    expect(asked.structuredContent).toMatchObject({ status: 'pending', question: { input: 'confirm', risk: 'low', confirm_label: 'Ship it', deny_label: 'Hold' } });

    // Each structured result matches the outputSchema the tool publishes.
    const tools = await toolsList(who);
    const ajv = new Ajv2020({ strict: false, allErrors: true });
    for (const [name, r] of [['inbox_list', list], ['question_status', st], ['ask_human', asked]] as const) {
      const validate = ajv.compile(tools.find((x) => x.name === name).outputSchema);
      expect([name, validate(r.structuredContent) ? [] : validate.errors]).toEqual([name, []]);
    }
  });
});

describe('tasks_list (the tasks card)', () => {
  it('carries the summary fields, cuts the goal to 200 characters, pages, and matches its outputSchema', async () => {
    const who = await login(`mcp-cards-tasks-${stamp}@example.test`);
    const long = 'Find the cheapest fare and report it. '.repeat(20);
    const scheduled = await call(who, 'task_create', { name: `Fares ${stamp}`, goal: long, schedules: [{ cron: '0 9 * * 1-5', timezone: 'UTC' }] }, 'pat');
    const plain = await call(who, 'task_create', { name: `Plain ${stamp}`, goal: 'Check the weather' }, 'pat');
    await call(who, 'task_pause', { task_id: scheduled.structuredContent!.id }, 'pat');
    const run = await call(who, 'task_run', { task_id: plain.structuredContent!.id, wait_s: 0 }, 'pat');

    const r = await call(who, 'tasks_list', {});
    expect(r.isError).toBeFalsy();
    const s = r.structuredContent!;
    expect(s).toMatchObject({ total: 2, next_cursor: null, app_url: APP_URL, granted_scopes: [...MCP_SCOPE_IDS] });
    const fares = s.items.find((x: Json) => x.id === scheduled.structuredContent!.id);
    expect(fares).toMatchObject({ scheduleState: 'paused', paused: true, scheduleText: 'Paused', nextRunAt: null, lastRun: null, liveRunId: null, goalTruncated: true });
    expect(fares.goal.length).toBeLessThanOrEqual(TASKS_LIST_GOAL_CHARS);
    expect(fares).not.toHaveProperty('summary');
    const weather = s.items.find((x: Json) => x.id === plain.structuredContent!.id);
    expect(weather).toMatchObject({ scheduleState: 'none', paused: false, scheduleText: null, liveRunId: run.structuredContent!.id, lastRun: { id: run.structuredContent!.id, status: 'queued', finishedAt: null } });
    // No transcript and no long goal anywhere in the payload.
    expect(JSON.stringify(s)).not.toContain(long.slice(0, 300));

    await call(who, 'task_resume', { task_id: scheduled.structuredContent!.id }, 'pat');
    const resumed = (await call(who, 'tasks_list', {})).structuredContent!.items.find((x: Json) => x.id === scheduled.structuredContent!.id);
    expect(resumed).toMatchObject({ scheduleState: 'active', paused: false, scheduleText: 'Monday to Friday at 09:00', nextRunAt: expect.any(String) });

    const first = await call(who, 'tasks_list', { limit: 1 });
    expect(first.structuredContent).toMatchObject({ total: 2, next_cursor: expect.any(String) });
    expect(first.structuredContent!.items).toHaveLength(1);
    const second = await call(who, 'tasks_list', { limit: 1, cursor: first.structuredContent!.next_cursor });
    expect(second.structuredContent!.items).toHaveLength(1);
    expect(second.structuredContent!.items[0].id).not.toBe(first.structuredContent!.items[0].id);
    expect(second.structuredContent!.next_cursor).toBeNull();

    const tools = await toolsList(who);
    const validate = new Ajv2020({ strict: false, allErrors: true }).compile(tools.find((x) => x.name === 'tasks_list').outputSchema);
    expect(validate(s) ? [] : validate.errors).toEqual([]);
  });
});
