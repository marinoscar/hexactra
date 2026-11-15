// The goal runner against a real database, with a scripted model and an
// in-memory fabric: policy refusals, a confirmation handoff, a secret typed
// by the runner (never stored), finishing, and cancelling.
import { randomUUID } from 'node:crypto';
import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import type { AiService } from '@marinoscar/platform-api/ai';

import { createApp } from '../src/main';
import { PrismaService } from '../src/prisma/prisma.service';
import type { FabricClient } from '../src/fabric/fabric.client';
import { GoalRunnerService } from '../src/runner/goal-runner.service';
import { ExternalBrowserController } from '../src/browser/external-browser.controller';
import { HandoffAnswers } from '../src/browser/handoff-answers';
import { InboxController } from '../src/browser/inbox.controller';
import { QuestionEvents } from '../src/questions/question-events';
import { QuestionsService } from '../src/questions/questions.service';
import { TasksService } from '../src/tasks/tasks.service';

let app: NestFastifyApplication;
const stamp = `${Date.now()}`;
const SECRET = '987654';

beforeAll(async () => {
  app = await createApp();
  await app.init();
  await app.getHttpAdapter().getInstance().ready();
});
afterAll(async () => {
  await app?.close();
});

async function login(email: string): Promise<string> {
  const res = await app.inject({ method: 'POST', url: '/api/auth/test/login', payload: { email, role: 'contributor' } });
  const token = new URL(String(res.headers.location)).searchParams.get('token')!;
  const me = await app.inject({ method: 'GET', url: '/api/auth/me', headers: { authorization: `Bearer ${token}` } });
  return me.json<{ data: { id: string } }>().data.id;
}

/** An in-memory fabric: sessions, actions and handoffs. */
function fakeFabric() {
  const actions: Record<string, unknown>[] = [];
  // The fabric's real handoff view (crates/hexactra-core/src/remote.rs `HandoffView`).
  const handoffs = new Map<string, { id: string; status: string; input: string; kind: string; response?: { outcome?: string; value?: string; value_withheld: boolean; channel?: string; by?: string; answered_at?: string } }>();
  let ended = 0;
  let n = 0;
  const request = jest.fn(async (method: string, path: string, opts: { body?: Record<string, unknown> } = {}) => {
    if (method === 'POST' && path === '/v1/sessions') return { id: '00000000-0000-4000-8000-00000000000a' };
    if (method === 'DELETE' && path.startsWith('/v1/sessions/')) return void (ended += 1);
    if (method === 'POST' && path.endsWith('/actions')) {
      const action = opts.body!.action as Record<string, unknown>;
      actions.push(action);
      if (action.type === 'navigate') return { id: 'op', state: 'succeeded', result: { url: action.url, title: 'Shop' } };
      if (action.type === 'elements') return { id: 'op', state: 'succeeded', result: { elements: [{ selector: '#buy', tag: 'button', text: 'Place order' }] } };
      return { id: 'op', state: 'succeeded', result: {} };
    }
    if (method === 'POST' && path.endsWith('/handoffs')) {
      const id = `00000000-0000-4000-8000-0000000000${String(++n).padStart(2, '0')}`;
      handoffs.set(id, { id, status: 'pending', input: String(opts.body!.input), kind: String(opts.body!.kind) });
      return { handoff: { id } };
    }
    if (method === 'GET' && path.startsWith('/v1/handoffs/')) return handoffs.get(path.split('/')[3]!);
    if (method === 'POST' && path.endsWith('/claim')) return { value: SECRET };
    throw new Error(`unexpected ${method} ${path}`);
  });
  return { client: { request, config: async () => ({ url: 'http://f', token: 't' }) } as unknown as FabricClient, actions, handoffs, ended: () => ended };
}

type Call = [name: string, args: Record<string, unknown>];

/** A model that makes the scripted tool calls, one script per runTools call. */
function scriptedAi(scripts: Call[][]) {
  const outputs: string[] = [];
  const runTools = jest.fn(async (req: { tools: { tool: { name: string }; execute: (a: unknown, c: unknown) => Promise<unknown> }[]; onStep?: (s: unknown) => void; input: string }) => {
    const script = scripts.shift() ?? [];
    let step = 0;
    for (const [name, args] of script) {
      const t = req.tools.find((x) => x.tool.name === name)!;
      outputs.push(String(await t.execute(args, { userId: 'u' })));
      req.onStep?.({ step: ++step, response: { usage: { inputTokens: 10, outputTokens: 5 } }, calls: [] });
    }
    return { final: { outputText: '' }, steps: [], stopReason: 'steps_exhausted' };
  });
  return { ai: { forUser: () => ({ runTools }) } as unknown as AiService, runTools, outputs };
}

describe('the goal runner', () => {
  it('enforces policy, pauses for a confirmation and a secret, types the secret without storing it, and finishes', async () => {
    const userId = await login(`runner-${stamp}@example.test`);
    const prisma = app.get(PrismaService);
    const tasks = app.get(TasksService);
    const db = prisma.forUser({ userId });
    const task = await db.task.create({ data: { userId, name: 'Order', goal: 'Buy the item', allowedDomains: ['shop.example.test'] } });
    const run = await db.run.create({ data: { userId, taskId: task.id, goal: task.goal } });

    const fabric = fakeFabric();
    const { ai, outputs } = scriptedAi([
      [
        ['navigate', { url: 'https://shop.example.test/item?ref=abc', reason: 'open the shop' }],
        ['navigate', { url: 'https://elsewhere.example.test/', reason: 'detour' }],
        ['observe_elements', {}],
        ['click', { selector: '#buy', reason: 'buy it' }],
        ['request_human', { kind: 'confirmation', prompt: 'Place the order for 1 item?', input: 'none', choices: null }],
      ],
      [
        ['click', { selector: '#buy', reason: 'buy it' }],
        ['request_human', { kind: 'code', prompt: 'Enter the code sent to your phone', input: 'secret', choices: null }],
      ],
      [
        ['type_handoff_secret', { selector: '#otp', submit: true }],
        ['finish', { success: true, result: 'Order placed' }],
      ],
    ]);
    const told: [string, ...unknown[]][] = [];
    const notifier = {
      needsYou: async (_u: string, _r: unknown, prompt: string, kind: string) => void told.push(['needsYou', kind, prompt]),
      finished: async (_u: string, _r: unknown, status: string, result?: string | null) => void told.push(['finished', status, result]),
    };
    const runner = new GoalRunnerService(prisma, tasks, fabric.client, ai, notifier as never);

    expect(await runner.advance(run.id, userId, null)).toBe('waiting_human');
    expect(outputs[1]).toMatch(/not an allowed site/);
    expect(outputs[3]).toMatch(/Refused: this looks like a purchase/);
    // Still pending: nothing happens.
    expect(await runner.advance(run.id, userId, null)).toBe('waiting_human');

    // A fabric from before the typed contract reports no outcome: the status says it.
    const [confirm] = [...fabric.handoffs.values()];
    Object.assign(confirm!, { status: 'completed', response: { value_withheld: false } });
    expect(await runner.advance(run.id, userId, null)).toBe('waiting_human');
    expect(fabric.actions.filter((a) => a.type === 'click')).toHaveLength(1);

    const code = [...fabric.handoffs.values()][1]!;
    Object.assign(code, { status: 'completed', response: { outcome: 'completed', value_withheld: true, channel: 'web', by: `user:${userId}`, answered_at: new Date().toISOString() } });
    expect(await runner.advance(run.id, userId, null)).toBe('succeeded');

    expect(fabric.actions).toContainEqual(expect.objectContaining({ type: 'type', selector: '#otp', text: SECRET }));
    expect(fabric.ended()).toBe(1);
    const done = await db.run.findFirstOrThrow({ where: { id: run.id }, include: { steps: true } });
    expect(done).toMatchObject({ status: 'succeeded', result: 'Order placed', inputTokens: 90, outputTokens: 45 });
    // Nothing secret, and no URL query, reached the database.
    const stored = JSON.stringify(done);
    expect(stored).not.toContain(SECRET);
    expect(stored).not.toContain('ref=abc');
    expect(done.steps.map((s) => s.kind)).toEqual(expect.arrayContaining(['action', 'handoff', 'finish']));
    expect(told).toEqual([
      ['needsYou', 'confirmation', 'Place the order for 1 item?'],
      ['needsYou', 'code', 'Enter the code sent to your phone'],
      ['finished', 'succeeded', 'Order placed'],
    ]);
  });

  it('stops between steps when cancelled', async () => {
    const userId = await login(`runner-cancel-${stamp}@example.test`);
    const prisma = app.get(PrismaService);
    const tasks = app.get(TasksService);
    const db = prisma.forUser({ userId });
    const run = await db.run.create({ data: { userId, goal: 'Browse' } });
    const fabric = fakeFabric();
    const { ai } = scriptedAi([
      [
        ['navigate', { url: 'https://example.test/', reason: 'start' }],
      ],
    ]);
    const runner = new GoalRunnerService(prisma, tasks, fabric.client, {
      forUser: () => ({
        runTools: async (req: Parameters<ReturnType<AiService['forUser']>['runTools']>[0]) => {
          await db.run.updateMany({ where: { id: run.id }, data: { cancelRequested: true } });
          return (ai.forUser('x') as unknown as { runTools: (r: unknown) => Promise<unknown> }).runTools(req);
        },
      }),
    } as unknown as AiService);
    expect(await runner.advance(run.id, userId, null)).toBe('cancelled');
    expect(fabric.ended()).toBe(1);
  });
});

describe('the inbox', () => {
  function inboxWith(fabric: FabricClient) {
    const prisma = app.get(PrismaService);
    const enqueued: unknown[] = [];
    const jobs = { enqueue: async (j: unknown) => void enqueued.push(j) };
    const questions = new QuestionsService(prisma, fabric, jobs as never, new QuestionEvents());
    return { inbox: new InboxController(questions, new HandoffAnswers(questions)), questions, enqueued };
  }

  it('lists the questions runs wait for from the database and answers the fabric, then resumes the run', async () => {
    const userId = await login(`inbox-${stamp}@example.test`);
    const prisma = app.get(PrismaService);
    const db = prisma.forUser({ userId });
    const hid = randomUUID();
    const waiting = await db.run.create({ data: { userId, goal: 'Pay the bill', status: 'waiting_human', handoffId: hid } });
    const fabricCalls: [string, string, unknown][] = [];
    const fabric = {
      request: async (method: string, path: string, opts?: { body?: unknown }) => {
        fabricCalls.push([method, path, opts?.body]);
        return {};
      },
    } as unknown as FabricClient;
    const { inbox, questions, enqueued } = inboxWith(fabric);
    const spec = questions.parseSpec({ kind: 'code', prompt: 'Enter the code', input: 'secret' });
    await questions.mirrorHandoff({ id: userId }, spec, { id: hid, viewerUrl: 'https://viewer.example.test/h', pageTitle: 'Bank', expiresAt: new Date(Date.now() + 600_000) }, { askedBy: `run:${waiting.id}`, runId: waiting.id, fabricSessionId: null });

    const items = await inbox.list(userId);
    expect(items).toEqual([expect.objectContaining({ runId: waiting.id, goal: 'Pay the bill', kind: 'code', input: 'secret', prompt: 'Enter the code', viewerUrl: 'https://viewer.example.test/h', pageTitle: 'Bank' })]);
    // No fabric round trip to list.
    expect(fabricCalls).toEqual([]);

    await inbox.respond({ id: userId }, waiting.id, { outcome: 'completed', value: SECRET });
    expect(fabricCalls.at(-1)).toEqual(['POST', `/v1/handoffs/${hid}/respond`, { outcome: 'completed', value: SECRET, channel: 'inbox', answered_by: `user:${userId}` }]);
    expect(enqueued).toEqual([expect.objectContaining({ type: 'browser.goal.run', subjectId: waiting.id })]);
    // The secret went to the fabric only.
    expect(JSON.stringify(await db.run.findFirstOrThrow({ where: { id: waiting.id } }))).not.toContain(SECRET);
    const q = await db.question.findFirstOrThrow({ where: { handoffId: hid } });
    expect(q).toMatchObject({ status: 'answered', answeredChannel: 'inbox', response: expect.objectContaining({ outcome: 'completed', valueWithheld: true }) });
    expect(JSON.stringify(q)).not.toContain(SECRET);
    expect(await inbox.list(userId)).toEqual([]);

    const other = await login(`inbox-other-${stamp}@example.test`);
    await expect(inbox.respond({ id: other }, waiting.id, { outcome: 'completed' })).rejects.toThrow(/Run not found/);
  });

  it('mirrors a handoff opened before the broker on its first answer', async () => {
    const userId = await login(`inbox-legacy-${stamp}@example.test`);
    const db = app.get(PrismaService).forUser({ userId });
    const hid = randomUUID();
    const run = await db.run.create({ data: { userId, goal: 'Pick a seat', status: 'waiting_human', handoffId: hid } });
    const fabric = {
      request: async (method: string) =>
        method === 'GET' ? { id: hid, kind: 'other', prompt: 'Which seat?', input: 'choice', choices: ['Aisle', 'Window'], status: 'pending', created_at: new Date().toISOString(), expires_at: new Date(Date.now() + 60_000).toISOString() } : {},
    } as unknown as FabricClient;
    const { inbox } = inboxWith(fabric);
    await expect(inbox.respond({ id: userId }, run.id, { outcome: 'completed', value: 'Middle' })).rejects.toThrow(/Not one of the options/);
    await inbox.respond({ id: userId }, run.id, { outcome: 'completed', value: 'Window' });
    expect(await db.question.findFirstOrThrow({ where: { handoffId: hid } })).toMatchObject({ status: 'answered', askedBy: `run:${run.id}`, response: expect.objectContaining({ value: 'Window' }) });
  });
});

describe('external agents driving a browser through the console', () => {
  it('records every action as a redacted step, enforces sites, answers handoffs, types secrets unseen, and stops on cancel', async () => {
    const userId = await login(`ext-${stamp}@example.test`);
    const prisma = app.get(PrismaService);
    const tasks = app.get(TasksService);
    const fabric = fakeFabric();
    const ctl = new ExternalBrowserController(prisma, fabric.client, tasks);

    const { runId } = await ctl.open(userId, { profile: 'default', actor: 'agent-x', goal: 'Check my order', allowedDomains: ['shop.example.test'], hostId: null });
    await ctl.act(userId, runId, { action: { type: 'navigate', url: 'https://shop.example.test/orders?session=s3cr3t' } });
    await expect(ctl.act(userId, runId, { action: { type: 'navigate', url: 'https://other.example.test/' } })).rejects.toThrow(/may not open/);

    const { handoffId } = await ctl.handoff(userId, runId, { kind: 'code', prompt: 'Enter the code', input: 'secret', choices: [] });
    await expect(ctl.act(userId, runId, { action: { type: 'click', selector: '#x' } })).rejects.toThrow(/Waiting for the person/);
    fabric.handoffs.get(handoffId)!.status = 'completed';
    fabric.handoffs.get(handoffId)!.response = { outcome: 'completed', value_withheld: true, by: `user:${userId}`, answered_at: new Date().toISOString() };
    expect(await ctl.handoffStatus(userId, runId, handoffId)).toMatchObject({ status: 'completed', secretAvailable: true, value: null });
    await ctl.act(userId, runId, { action: { type: 'type_handoff_secret', handoffId, selector: '#otp', submit: true } });
    expect(fabric.actions).toContainEqual(expect.objectContaining({ type: 'type', selector: '#otp', text: SECRET }));

    const db = prisma.forUser({ userId });
    const row = await db.run.findFirstOrThrow({ where: { id: runId }, include: { steps: true } });
    expect(row).toMatchObject({ trigger: 'external', actor: 'agent-x', status: 'running' });
    expect(row.steps.length).toBe(4);
    const stored = JSON.stringify(row);
    expect(stored).not.toContain(SECRET);
    expect(stored).not.toContain('s3cr3t');

    // The user stops it: the next action is refused and the session ends.
    await tasks.cancel(userId, runId);
    await expect(ctl.act(userId, runId, { action: { type: 'tabs' } })).rejects.toThrow(/stopped this session/);
    expect((await db.run.findFirstOrThrow({ where: { id: runId } })).status).toBe('cancelled');
    expect(fabric.ended()).toBe(1);
  });
});
