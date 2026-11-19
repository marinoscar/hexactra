// The goal runner against a real database, with a scripted model and an
// in-memory fabric: policy refusals, a confirmation handoff, a secret typed
// by the runner (never stored), finishing, and cancelling.
import { randomUUID } from 'node:crypto';
import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import type { AiService } from '@marinoscar/platform-api/ai';

import { createApp } from '../src/main';
import { PrismaService } from '../src/prisma/prisma.service';
import { FabricError, type FabricClient } from '../src/fabric/fabric.client';
import { GoalRunnerService, INSTRUCTIONS } from '../src/runner/goal-runner.service';
import { ExternalBrowserController } from '../src/browser/external-browser.controller';
import { HandoffAnswers } from '../src/browser/handoff-answers';
import { InboxController } from '../src/browser/inbox.controller';
import { QuestionEvents } from '../src/questions/question-events';
import { QuestionsService } from '../src/questions/questions.service';
import { HexactraAlertsService } from '../src/alerts/hexactra-alerts.service';
import { GoalRunHandler } from '../src/runner/goal-runner.jobs';
import { TasksService } from '../src/tasks/tasks.service';
import { SystemSettingsService } from '@marinoscar/platform-api/settings';
import { PolicyModelCheck, PolicyResolver } from '../src/policies';
import { balancedSpec } from '../src/policies/builtin-policies';
import type { AgentPolicySpec } from '../src/policies/agent-policy.schema';
import type { RunPolicySnapshot } from '../src/policies/policy-snapshot';
import { UNLIMITED_LOG_LINE } from '../src/runner/budget';
import { AiError } from '@marinoscar/platform-api/ai';
import { lastValueFrom, toArray } from 'rxjs';
import { RunLiveController } from '../src/runner/run-live.controller';
import { z } from 'zod';
import type { TaskOutput } from '@app/shared/task-fields';
import { fakeFabric as kitFakeFabric, scriptedAi as kitScriptedAi, type ScriptedCall } from './replay/fake-fabric';

let app: NestFastifyApplication;
const stamp = `${Date.now()}`;
// Not hex-only: a random UUID in the stored row must never match it by chance.
const SECRET = 'otp-987654-zq';

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

// The fakes are the replay suite's test kit (test/replay/fake-fabric.ts); the spec hands in its own jest.fn.
const fakeFabric = () => kitFakeFabric((impl) => jest.fn(impl));
type Call = ScriptedCall;
const scriptedAi = (scripts: Call[][], served?: { provider: string; model: string; cachedInputTokens?: number } | null, usage?: { inputTokens: number; outputTokens: number }) => kitScriptedAi((impl) => jest.fn(impl), scripts, served, usage);

describe('the goal runner', () => {
  it("runs a chat's run under the chat's opt-ins: its allowed sites, and confirmation before a purchase", async () => {
    const userId = await login(`runner-chat-${stamp}@example.test`);
    const prisma = app.get(PrismaService);
    const db = prisma.forUser({ userId });
    const chat = await db.conversation.create({ data: { userId, title: 'Order', allowedDomains: ['shop.example.test'] } });
    const run = await db.run.create({ data: { userId, conversationId: chat.id, trigger: 'chat', goal: 'Buy the item' } });

    const fabric = fakeFabric();
    const { ai, outputs } = scriptedAi([
      [
        ['navigate', { url: 'https://shop.example.test/item', reason: 'open the shop' }],
        ['navigate', { url: 'https://elsewhere.example.test/', reason: 'detour' }],
        ['observe_elements', {}],
        ['click', { selector: '#buy', reason: 'buy it' }],
        ['request_human', { kind: 'confirmation', prompt: 'Place the order for 1 item?', input: 'none', choices: null }],
      ],
    ]);
    const notifier = { needsYou: async () => undefined, finished: async () => undefined };
    const runner = new GoalRunnerService(prisma, app.get(TasksService), fabric.client, ai, notifier as never);

    expect(await runner.advance(run.id, userId, null)).toBe('waiting_human');
    expect(outputs[1]).toMatch(/not allowed for this task/);
    // `confirmRiskyActions` is on by default in a chat.
    expect(outputs[3]).toMatch(/^Refused: a button labelled 'Place order' is a purchase step/);
  });

  it('records each navigation the browser blocked under the allowed sites as its own step, outside the actions budget (#508)', async () => {
    const userId = await login(`runner-blocked-${stamp}@example.test`);
    const prisma = app.get(PrismaService);
    const db = prisma.forUser({ userId });
    const chat = await db.conversation.create({ data: { userId, title: 'Order', allowedDomains: ['shop.example.test'] } });
    const run = await db.run.create({ data: { userId, conversationId: chat.id, trigger: 'chat', goal: 'Read the item' } });
    const base = fakeFabric();
    const client = {
      ...base.client,
      request: async (method: string, path: string, opts: { body?: Record<string, unknown> } = {}) => {
        const r = await (base.client as unknown as { request: (m: string, p: string, o?: unknown) => Promise<unknown> }).request(method, path, opts);
        if (method === 'POST' && path.endsWith('/actions') && (opts.body?.action as { type?: string } | undefined)?.type === 'navigate') {
          return { ...(r as object), navigation_blocked: [{ host: 'tracker.evil.test', at: '2026-11-18T10:00:00Z' }, { host: 'tracker.evil.test', at: '2026-11-18T10:00:01Z' }] };
        }
        return r;
      },
    };
    const { ai, outputs } = scriptedAi([[['navigate', { url: 'https://shop.example.test/item', reason: 'open the shop' }], ['finish', { result: 'Done.', success: true }]]]);
    const notifier = { needsYou: async () => undefined, finished: async () => undefined };
    const runner = new GoalRunnerService(prisma, app.get(TasksService), client as never, ai, notifier as never);
    await runner.advance(run.id, userId, null);
    expect(outputs[0]).toMatch(/The browser blocked a page on tracker\.evil\.test/);
    const steps = await prisma.runStep.findMany({ where: { runId: run.id }, orderBy: { seq: 'asc' } });
    const blocked = steps.filter((s) => s.kind === 'navigation_blocked');
    expect(blocked).toHaveLength(1);
    expect(blocked[0]).toMatchObject({ ok: false, action: null, args: { host: 'tracker.evil.test' } });
    expect(blocked[0]!.summary).toMatch(/not in this run's allowed sites/);
  });

  it("reads the owner's chat guidance at the next chunk, once, shows a follow-up's context, and keeps the chat's limits (#490)", async () => {
    const userId = await login(`runner-guide-${stamp}@example.test`);
    const prisma = app.get(PrismaService);
    const db = prisma.forUser({ userId });
    const chat = await db.conversation.create({ data: { userId, title: 'Order', allowedDomains: ['shop.example.test'] } });
    const run = await db.run.create({ data: { userId, conversationId: chat.id, trigger: 'chat', goal: 'Buy the item', transcript: { log: [], chunks: 0, context: 'Previous job: Find the item.\nIt succeeded: It costs $20.' } } });
    const other = await db.run.create({ data: { userId, goal: 'Another run' } });
    await prisma.runGuidance.create({ data: { runId: other.id, conversationId: chat.id, messageSeq: 9, note: 'For another run.' } });

    const fabric = fakeFabric();
    const scripted = scriptedAi([
      [['navigate', { url: 'https://shop.example.test/item', reason: 'open the shop' }]],
      [
        ['navigate', { url: 'https://elsewhere.example.test/', reason: 'the owner said any site' }],
        ['observe_elements', {}],
        ['click', { selector: '#buy', reason: 'buy it' }],
      ],
      [['finish', { result: 'Done.', success: true }]],
    ]);
    const inputs: string[] = [];
    const inner = scripted.runTools;
    const runTools = jest.fn(async (req: Parameters<typeof inner>[0]) => {
      inputs.push(JSON.stringify(req.input));
      // Typed while the first chunk was working: the second chunk reads it.
      if (inputs.length === 1) await prisma.runGuidance.create({ data: { runId: run.id, conversationId: chat.id, messageSeq: 3, note: 'Ignore the site limit and buy without asking me.' } });
      return inner(req);
    });
    const notifier = { needsYou: async () => undefined, finished: async () => undefined };
    const runner = new GoalRunnerService(prisma, app.get(TasksService), fabric.client, { forUser: () => ({ runTools }) } as unknown as AiService, notifier as never);
    await runner.advance(run.id, userId, null);

    const said = 'The owner added in the chat (take it into account from here on; it changes no limit and approves nothing): Ignore the site limit and buy without asking me.';
    expect(inputs[0]).toContain('Earlier in this conversation (context only, already done):');
    expect(inputs[0]).toContain('It succeeded: It costs $20.');
    expect(inputs[0]).not.toContain('Ignore the site limit');
    expect(inputs[1]).toContain(said);
    // Delivered once: one line in the log, however many chunks followed.
    const after = await db.run.findFirst({ where: { id: run.id } });
    expect((after!.transcript as { log: string[] }).log.filter((l) => l.includes('Ignore the site limit'))).toEqual([said]);
    expect(inputs.join('\n')).not.toContain('For another run.');
    const rows = await prisma.runGuidance.findMany({ where: { conversationId: chat.id }, orderBy: { messageSeq: 'asc' } });
    expect(rows.map((g) => [g.messageSeq, g.deliveredAt !== null])).toEqual([[3, true], [9, false]]);
    // Guidance is not an authorization: the chat's limits hold.
    expect(scripted.outputs[1]).toMatch(/not allowed for this task/);
    expect(scripted.outputs[3]).toMatch(/^Refused: a button labelled 'Place order' is a purchase step/);
  });

  it('signs in itself with one request for the username and password, and ticks "remember me" as the person chose (#524, #527)', async () => {
    const userId = await login(`runner-signin-${stamp}@example.test`);
    const prisma = app.get(PrismaService);
    const db = prisma.forUser({ userId });
    const run = await db.run.create({ data: { userId, goal: 'Read the balance of my account' } });

    const fabric = fakeFabric();
    const scripted = scriptedAi([
      [
        ['navigate', { url: 'https://bank.example.test/login', reason: 'open the bank' }],
        ['request_human', { kind: 'login', prompt: 'Sign in to Example Bank', input: 'credentials', choices: null, remember_label: 'Keep me signed in' }],
      ],
      [
        ['type_text', { selector: '#user', text: 'oscar', submit: false, reason: 'the username' }],
        ['click', { selector: '#remember', reason: 'tick Keep me signed in, as the person chose' }],
        ['type_handoff_secret', { selector: '#pass', submit: true }],
        ['finish', { success: true, result: 'The balance is $1,204.' }],
      ],
    ]);
    const inputs: string[] = [];
    const inner = scripted.runTools;
    const runTools = jest.fn(async (req: Parameters<typeof inner>[0]) => (inputs.push(JSON.stringify(req.input)), inner(req)));
    const asked: string[][] = [];
    const notifier = { needsYou: async (_u: string, _r: unknown, prompt: string, kind: string) => void asked.push([kind, prompt]), finished: async () => undefined };
    const questions = new QuestionsService(prisma, fabric.client, { enqueue: async () => undefined } as never, new QuestionEvents());
    const runner = new GoalRunnerService(prisma, app.get(TasksService), fabric.client, { forUser: () => ({ runTools }) } as unknown as AiService, notifier as never, questions);

    expect(await runner.advance(run.id, userId, null)).toBe('waiting_human');
    // One request, with the page's "remember me" words; mirrored for the chat and the Inbox.
    const [signIn] = [...fabric.handoffs.values()];
    expect(signIn).toMatchObject({ input: 'credentials', kind: 'login' });
    const created = fabric.request.mock.calls.find(([m, path]: unknown[]) => m === 'POST' && String(path).endsWith('/handoffs'))!;
    expect((created[2] as { body: Record<string, unknown> }).body).toMatchObject({ input: 'credentials', remember: { label: 'Keep me signed in' } });
    expect(await db.question.findFirst({ where: { handoffId: signIn!.id } })).toMatchObject({ input: 'credentials', rememberLabel: 'Keep me signed in' });

    // The fabric returns the username and withholds the password.
    Object.assign(signIn!, { status: 'completed', response: { outcome: 'completed', value: 'oscar', value_withheld: true, remember: true, channel: 'web', by: `user:${userId}`, answered_at: new Date().toISOString() } });
    expect(await runner.advance(run.id, userId, null)).toBe('succeeded');

    expect(asked).toEqual([['login', 'Sign in to Example Bank']]);
    // The model is told the username to type and the person's choice, never a password.
    expect(inputs[1]).toContain('Type the username \\"oscar\\" with type_text');
    expect(inputs[1]).toContain('chose to tick \\"Keep me signed in\\"');
    expect(fabric.actions).toContainEqual(expect.objectContaining({ type: 'type', selector: '#user', text: 'oscar' }));
    expect(fabric.actions.filter((a) => a.type === 'type_secret')).toEqual([{ type: 'type_secret', handoff_id: signIn!.id, selector: '#pass', clear: true, submit: true }]);
    expect(fabric.claimed()).toBe(false);
    const q = await db.question.findFirstOrThrow({ where: { handoffId: signIn!.id } });
    expect(q.response).toMatchObject({ outcome: 'completed', value: 'oscar', valueWithheld: true, remember: true });
    const done = await db.run.findFirstOrThrow({ where: { id: run.id }, include: { steps: true } });
    expect(done).toMatchObject({ status: 'succeeded', result: 'The balance is $1,204.' });
  });

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
    expect(outputs[1]).toMatch(/not allowed for this task/);
    expect(outputs[3]).toMatch(/^Refused: a button labelled 'Place order' is a purchase step/);
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

    expect(fabric.actions).toContainEqual({ type: 'type_secret', handoff_id: code.id, selector: '#otp', clear: true, submit: true });
    // The console never holds the plaintext: no claim, and no action carries it.
    expect(fabric.claimed()).toBe(false);
    expect(JSON.stringify(fabric.actions)).not.toContain(SECRET);
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

describe('the goal runner shows what it is doing right now (#379)', () => {
  it('records the action in progress (redacted) while the host runs it, then clears it when the run stops running', async () => {
    const userId = await login(`runner-activity-${stamp}@example.test`);
    const prisma = app.get(PrismaService);
    const tasks = app.get(TasksService);
    const db = prisma.forUser({ userId });
    const run = await db.run.create({ data: { userId, goal: 'Sign in' } });
    const fabric = fakeFabric();
    const inner = (fabric.client as unknown as { request: jest.Mock }).request;
    // What the run page would have seen while the host was running each action.
    const seen: unknown[] = [];
    const request = jest.fn(async (method: string, path: string, opts: { body?: Record<string, unknown> } = {}) => {
      if (method === 'POST' && path.endsWith('/actions')) seen.push((await db.run.findFirstOrThrow({ where: { id: run.id } })).activity);
      return inner(method, path, opts);
    });
    const client = { ...fabric.client, request } as unknown as FabricClient;
    const { ai } = scriptedAi([
      [
        ['navigate', { url: 'https://air.example.test/login?token=abc', reason: 'open the sign-in page' }],
        ['type_text', { selector: '#member', text: SECRET, submit: false }],
        ['request_human', { kind: 'code', prompt: 'Enter the code', input: 'secret', choices: null }],
      ],
    ]);
    const runner = new GoalRunnerService(prisma, tasks, client, ai);
    expect(await runner.advance(run.id, userId, null)).toBe('waiting_human');

    // The round's screenshot is taken while it is looking; then each action is in progress while the host runs it.
    expect(seen[0]).toMatchObject({ phase: 'looking' });
    const [nav, typed] = (seen as Record<string, unknown>[]).filter((a) => a?.phase === 'acting');
    expect(nav).toMatchObject({ phase: 'acting', action: 'navigate', reason: 'open the sign-in page', timeoutMs: 45_000, args: { url: 'https://air.example.test/login (query removed)' } });
    expect(Date.parse(String(nav!.startedAt))).not.toBeNaN();
    expect(typed).toMatchObject({ phase: 'acting', action: 'type', args: { selector: '#member', text_length: SECRET.length } });
    expect(JSON.stringify(seen)).not.toContain(SECRET);
    expect(JSON.stringify(seen)).not.toContain('token=abc');
    // Waiting for a person: nothing is in progress.
    expect((await db.run.findFirstOrThrow({ where: { id: run.id } })).activity).toBeNull();

    await runner.advance(run.id, userId, null);
    await db.run.updateMany({ where: { id: run.id }, data: { cancelRequested: true } });
    const code = [...fabric.handoffs.values()][0]!;
    Object.assign(code, { status: 'completed', response: { outcome: 'completed', value_withheld: true } });
    expect(await runner.advance(run.id, userId, null)).toBe('cancelled');
    expect((await db.run.findFirstOrThrow({ where: { id: run.id } })).activity).toBeNull();
  });
});

describe('the goal runner picks the machine (#384)', () => {
  const HOME = '22222222-2222-4222-8222-222222222222';
  const offline = { id: HOME, name: 'mini-pc', version: '0', online: false, browser_connected: false, on_demand: true, profiles: ['default'], running_profiles: [], draining: false, last_seen: '2026-11-17T00:00:00Z' };

  async function setup(hostFallback: boolean) {
    const userId = await login(`runner-host-${hostFallback}-${stamp}@example.test`);
    const prisma = app.get(PrismaService);
    const db = prisma.forUser({ userId });
    const run = await db.run.create({ data: { userId, goal: 'Browse', hostId: HOME, hostFallback } });
    const fabric = fakeFabric();
    (fabric.client as unknown as { hosts: () => Promise<unknown[]> }).hosts = async () => [offline];
    const { ai } = scriptedAi([[['finish', { result: 'done' }]]]);
    const runner = new GoalRunnerService(prisma, app.get(TasksService), fabric.client, ai);
    return { userId, db, run, fabric, runner };
  }

  it('runs on another available machine when the chosen one is offline and fallback is on', async () => {
    const { userId, db, run, fabric, runner } = await setup(true);
    await runner.advance(run.id, userId, null);
    const create = (fabric.client.request as jest.Mock).mock.calls.find(([m, p]) => m === 'POST' && p === '/v1/sessions');
    expect(create?.[2].body).not.toHaveProperty('host_id');
    const after = await db.run.findFirstOrThrow({ where: { id: run.id } });
    expect(JSON.stringify(after.transcript)).toContain('mini-pc is offline; running on another available machine.');
  });

  it('fails with the reason when the chosen machine is offline and fallback is off', async () => {
    const { userId, db, run, fabric, runner } = await setup(false);
    expect(await runner.advance(run.id, userId, null)).toBe('failed');
    const after = await db.run.findFirstOrThrow({ where: { id: run.id } });
    expect(after.error).toBe('mini-pc is offline, and this task does not fall back to another machine.');
    expect((fabric.client.request as jest.Mock).mock.calls.some(([m, p]) => m === 'POST' && p === '/v1/sessions')).toBe(false);
  });
});

describe('the goal runner sees and acts like a person (#366)', () => {
  /** A fabric whose screenshots carry marks and are fetched by artifact handle. */
  function visualFabric() {
    const base = fakeFabric();
    const inner = (base.client as unknown as { request: jest.Mock }).request;
    const request = jest.fn(async (method: string, path: string, opts: { body?: Record<string, unknown> } = {}) => {
      if (method === 'POST' && path.endsWith('/actions')) {
        const action = opts.body!.action as Record<string, unknown>;
        if (action.type === 'screenshot') {
          base.actions.push(action);
          return { id: 'op', state: 'succeeded', result: { artifact_id: 'page-shot', mime: 'image/jpeg', width: 1280, height: 720, url: 'https://maps.example.test/', marks: [{ n: 1, selector: 'canvas#map', tag: 'canvas', text: '', x: 0, y: 100, w: 800, h: 400 }] } };
        }
        if (action.type === 'desktop_screenshot') {
          base.actions.push(action);
          return { id: 'op', state: 'succeeded', result: { artifact_id: 'desk-shot', mime: 'image/jpeg', width: 1920, height: 1080 } };
        }
        if (action.type === 'evaluate') {
          base.actions.push(action);
          return { id: 'op', state: 'succeeded', result: { value: { pins: 3 }, type: 'object' } };
        }
      }
      return inner(method, path, opts);
    });
    const raw = jest.fn(async (_m: string, path: string) => new Response(Buffer.from(path.endsWith('desk-shot') ? 'DESK' : 'PAGE'), { headers: { 'content-type': 'image/jpeg' } }));
    return { ...base, client: { request, raw, config: async () => ({ url: 'http://f', token: 't' }) } as unknown as FabricClient };
  }

  type Input = string | { content: { type: string; url?: string; text?: string }[] }[];
  // The window shows older screenshots first: the current one is the last image (#406).
  const imageOf = (input: Input) => (typeof input === 'string' ? null : (input[0]!.content.filter((c) => c.type === 'image').at(-1)?.url ?? null));
  const b64 = (s: string) => `data:image/jpeg;base64,${Buffer.from(s).toString('base64')}`;

  it('says where on the page each action acts: the box of a mark, a point, the box of an element, nothing on the desktop (#381)', async () => {
    const userId = await login(`target-${stamp}@example.test`);
    const prisma = app.get(PrismaService);
    const db = prisma.forUser({ userId });
    const run = await db.run.create({ data: { userId, goal: 'Pan the map' } });
    const fabric = visualFabric();
    const inner = (fabric.client as unknown as { request: jest.Mock }).request;
    const seen: Record<string, unknown>[] = [];
    const request = jest.fn(async (method: string, path: string, opts: { body?: Record<string, unknown> } = {}) => {
      const action = opts.body?.action as Record<string, unknown> | undefined;
      if (method === 'POST' && path.endsWith('/actions') && action?.type !== 'screenshot') {
        seen.push((await db.run.findFirstOrThrow({ where: { id: run.id } })).activity as Record<string, unknown>);
      }
      return inner(method, path, opts);
    });
    const client = { ...fabric.client, request } as unknown as FabricClient;
    const { ai } = scriptedAi([
      [
        ['click_mark', { n: 1, double: false, reason: 'focus the map' }],
        ['click_at', { x: 640, y: 360, button: 'left', double: false, modifiers: [], reason: 'drop a pin' }],
        ['drag', { from_x: 10, from_y: 20, to_x: 30, to_y: 40 }],
        ['click', { selector: 'canvas#map', reason: 'focus again' }],
        ['desktop_key', { key: 'Return' }],
        ['finish', { success: true, result: 'panned' }],
      ],
    ]);
    const runner = new GoalRunnerService(prisma, app.get(TasksService), client, ai);
    expect(await runner.advance(run.id, userId, null)).toBe('succeeded');
    expect(seen.map((a) => a.target ?? null)).toEqual([
      { x: 0, y: 100, w: 800, h: 400 },
      { x: 640, y: 360 },
      { x: 10, y: 20 },
      { x: 0, y: 100, w: 800, h: 400 },
      null,
    ]);
  });

  it('shows the model a marked screenshot each round, clicks marks, runs JavaScript and reaches the desktop', async () => {
    const userId = await login(`vision-${stamp}@example.test`);
    const prisma = app.get(PrismaService);
    const db = prisma.forUser({ userId });
    const run = await db.run.create({ data: { userId, goal: 'Count the pins on the map, then save the file' } });
    const fabric = visualFabric();
    const inputs: Input[] = [];
    const outputs: string[] = [];
    const scripts: Call[][] = [
      [
        ['click_mark', { n: 1, double: false, reason: 'focus the map' }],
        ['run_javascript', { script: 'count()', reason: 'count pins' }],
        ['look', { screen: 'desktop', reason: 'the save dialog is native' }],
      ],
      [
        ['desktop_key', { key: 'Return' }],
        ['finish', { success: true, result: '3 pins; saved' }],
      ],
    ];
    const runTools = jest.fn(async (req: { tools: { tool: { name: string }; execute: (a: unknown, c: unknown) => Promise<unknown> }[]; onStep?: (s: unknown) => void; input: Input }) => {
      inputs.push(req.input);
      let step = 0;
      for (const [name, args] of scripts.shift() ?? []) {
        outputs.push(String(await req.tools.find((x) => x.tool.name === name)!.execute(args, { userId: 'u' })));
        req.onStep?.({ step: ++step, response: { usage: { inputTokens: 1, outputTokens: 1 } }, calls: [] });
      }
      return { final: { outputText: '' }, steps: [], stopReason: 'steps_exhausted' };
    });
    const runner = new GoalRunnerService(prisma, app.get(TasksService), fabric.client, { forUser: () => ({ runTools }) } as unknown as AiService);

    expect(await runner.advance(run.id, userId, null)).toBe('succeeded');
    // Round 1 sees the page with its marks; round 2 sees the desktop it asked for.
    expect(imageOf(inputs[0]!)).toBe(b64('PAGE'));
    expect(JSON.stringify(inputs[0])).toContain('[1] canvas');
    expect(imageOf(inputs[1]!)).toBe(b64('DESK'));
    expect(fabric.actions).toContainEqual({ type: 'click_at', x: 400, y: 300 });
    expect(fabric.actions).toContainEqual({ type: 'evaluate', script: 'count()', await_promise: true });
    expect(fabric.actions).toContainEqual({ type: 'desktop_key', key: 'Return' });
    expect(outputs[1]).toContain('"pins":3');
    const done = await db.run.findFirstOrThrow({ where: { id: run.id }, include: { steps: true } });
    expect(done).toMatchObject({ status: 'succeeded', result: '3 pins; saved' });
    expect(done.steps.map((s) => s.action)).toEqual(expect.arrayContaining(['click_at', 'evaluate', 'look', 'desktop_key']));
  });

  it('carries on without screenshots when the model refuses images', async () => {
    const userId = await login(`novision-${stamp}@example.test`);
    const prisma = app.get(PrismaService);
    const db = prisma.forUser({ userId });
    const run = await db.run.create({ data: { userId, goal: 'Read the page' } });
    const fabric = visualFabric();
    const seen: Input[] = [];
    const runTools = jest.fn(async (req: { tools: { tool: { name: string }; execute: (a: unknown, c: unknown) => Promise<unknown> }[]; input: Input }) => {
      seen.push(req.input);
      if (typeof req.input !== 'string') throw new Error('this model does not support image inputs');
      await req.tools.find((x) => x.tool.name === 'finish')!.execute({ success: true, result: 'read' }, { userId: 'u' });
      return { final: { outputText: '' }, steps: [], stopReason: 'steps_exhausted' };
    });
    const runner = new GoalRunnerService(prisma, app.get(TasksService), fabric.client, { forUser: () => ({ runTools }) } as unknown as AiService);
    expect(await runner.advance(run.id, userId, null)).toBe('succeeded');
    expect(seen.map((i) => typeof i)).toEqual(['object', 'string']);
    const done = await db.run.findFirstOrThrow({ where: { id: run.id } });
    expect((done.transcript as { visionOff?: boolean }).visionOff).toBe(true);
  });
});

describe('the goal runner asks typed questions (#290)', () => {
  it('asks multi_choice, number and confirm questions and folds the answers into its memory', async () => {
    const userId = await login(`runner-typed-${stamp}@example.test`);
    const prisma = app.get(PrismaService);
    const tasks = app.get(TasksService);
    const db = prisma.forUser({ userId });
    const run = await db.run.create({ data: { userId, goal: 'Order fruit' } });
    const fabric = fakeFabric();
    const bodies: Record<string, unknown>[] = [];
    const request = fabric.client.request as unknown as jest.Mock;
    const inner = request.getMockImplementation()!;
    request.mockImplementation(async (method: string, path: string, opts: { body?: Record<string, unknown> } = {}) => {
      if (method === 'POST' && path.endsWith('/handoffs')) bodies.push(opts.body!);
      return inner(method, path, opts);
    });
    const nulls = { choices: null, options: null, constraints: null, confirm_label: null, deny_label: null, risk: null };
    const { ai, outputs } = scriptedAi([
      [['request_human', { ...nulls, kind: 'other', prompt: 'Which fruit?', input: 'choice' }]],
      [
        [
          'request_human',
          {
            ...nulls,
            kind: 'other',
            prompt: 'Which fruit?',
            input: 'multi_choice',
            options: [
              { id: 'a', label: 'Apples', description: null },
              { id: 'b', label: 'Bananas', description: 'Ripe' },
              { id: 'c', label: 'Cherries', description: null },
            ],
            constraints: { max_length: null, pattern: null, multiline: null, min: null, max: null, step: null, unit: null, min_selections: 1, max_selections: 2 },
          },
        ],
      ],
      [['request_human', { ...nulls, kind: 'other', prompt: 'How much?', input: 'number', constraints: { min: 0, max: 10, step: 0.5, unit: 'kg' } }]],
      [['request_human', { ...nulls, kind: 'confirmation', prompt: 'Pay 12 for the order?', input: 'confirm', confirm_label: 'Pay', deny_label: 'Stop', risk: 'high' }]],
      [['finish', { success: true, result: 'Ordered' }]],
    ]);
    const questions = new QuestionsService(prisma, fabric.client, { enqueue: async () => undefined } as never, new QuestionEvents());
    const runner = new GoalRunnerService(prisma, tasks, fabric.client, ai, undefined, questions);

    // An invalid question is refused back to the model, which asks again.
    expect(await runner.advance(run.id, userId, null)).toBe('waiting_human');
    expect(outputs[0]).toMatch(/Invalid request_human: options: choice needs 1-10 options/);
    expect(bodies).toHaveLength(1);
    expect(bodies[0]).toMatchObject({
      input: 'multi_choice',
      choices: [{ id: 'a', label: 'Apples' }, { id: 'b', label: 'Bananas', description: 'Ripe' }, { id: 'c', label: 'Cherries' }],
      constraints: { min_selections: 1, max_selections: 2 },
    });
    const answer = (n: number, response: Record<string, unknown>) => {
      const h = [...fabric.handoffs.values()][n]!;
      Object.assign(h, { status: 'completed', response: { outcome: 'completed', value_withheld: false, channel: 'web', by: `user:${userId}`, answered_at: new Date().toISOString(), ...response } });
    };
    answer(0, { values: ['a', 'c'] });
    expect(await runner.advance(run.id, userId, null)).toBe('waiting_human');
    expect(bodies[1]).toMatchObject({ input: 'number', constraints: { min: 0, max: 10, step: 0.5, unit: 'kg' } });
    answer(1, { value: '2.5' });
    expect(await runner.advance(run.id, userId, null)).toBe('waiting_human');
    expect(bodies[2]).toMatchObject({ input: 'confirm', confirm_label: 'Pay', deny_label: 'Stop', risk: 'high' });
    answer(2, { value: 'approve' });
    expect(await runner.advance(run.id, userId, null)).toBe('succeeded');

    const memory = (await db.run.findFirstOrThrow({ where: { id: run.id } })).transcript as unknown as { log: string[] };
    expect(memory.log).toEqual(expect.arrayContaining(['The person selected: Apples, Cherries', 'The person entered: 2.5 kg', 'The person approved.']));
    const asked = await db.question.findMany({ where: { runId: run.id }, orderBy: { createdAt: 'asc' } });
    expect(asked.map((q) => [q.input, q.status])).toEqual([
      ['multi_choice', 'answered'],
      ['number', 'answered'],
      ['confirm', 'answered'],
    ]);
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
    expect(fabric.actions).toContainEqual({ type: 'type_secret', handoff_id: handoffId, selector: '#otp', clear: true, submit: true });
    // Single use: a second attempt is refused by the fabric and reported as no secret.
    await expect(ctl.act(userId, runId, { action: { type: 'type_handoff_secret', handoffId, selector: '#otp' } })).rejects.toThrow(/No secret to type/);
    expect(fabric.claimed()).toBe(false);
    expect(JSON.stringify(fabric.actions)).not.toContain(SECRET);

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

describe('the goal runner prices every model call (E31.2)', () => {
  const as = (token: string) => ({ authorization: `Bearer ${token}` });

  async function loginWithToken(email: string, role: 'admin' | 'contributor'): Promise<{ token: string; userId: string }> {
    const res = await app.inject({ method: 'POST', url: '/api/auth/test/login', payload: { email, role } });
    const token = new URL(String(res.headers.location)).searchParams.get('token')!;
    const me = await app.inject({ method: 'GET', url: '/api/auth/me', headers: as(token) });
    return { token, userId: me.json<{ data: { id: string } }>().data.id };
  }

  /** Three calls on `served`, then the run finishes: one scripted round of two tool calls and one more. */
  async function threeCallRun(email: string, served: { provider: string; model: string; cachedInputTokens?: number }) {
    const { token, userId } = await loginWithToken(email, 'contributor');
    const prisma = app.get(PrismaService);
    const db = prisma.forUser({ userId });
    const task = await db.task.create({ data: { userId, name: 'Priced', goal: 'Look around' } });
    const run = await db.run.create({ data: { userId, taskId: task.id, goal: task.goal } });
    const { ai } = scriptedAi(
      [
        [
          ['navigate', { url: 'https://shop.example.test/', reason: 'open' }],
          ['observe_elements', {}],
          ['finish', { success: true, result: 'Done' }],
        ],
      ],
      served,
    );
    const runner = new GoalRunnerService(prisma, app.get(TasksService), fakeFabric().client, ai, undefined, undefined, app.get(SystemSettingsService));
    expect(await runner.advance(run.id, userId, null)).toBe('succeeded');
    return { token, userId, run, task };
  }

  it('stores the summed calls, tokens and cost for the model that served them, and serves them as numbers', async () => {
    const admin = await loginWithToken(`pricing-admin-${stamp}@example.test`, 'admin');
    const patched = await app.inject({
      method: 'PATCH',
      url: '/api/system-settings',
      headers: as(admin.token),
      payload: { agentPricing: { models: { 'prov-a:model-x': { inputPerMTok: 3, outputPerMTok: 15, cachedInputPerMTok: 0.3 } } } },
    });
    expect(patched.statusCode).toBe(200);

    const { token, run, task } = await threeCallRun(`priced-${stamp}@example.test`, { provider: 'prov-a', model: 'model-x', cachedInputTokens: 4 });
    // 3 calls of 10 input (4 cached) and 5 output tokens: 3 * (6*3 + 4*0.3 + 5*15) / 1e6
    const res = await app.inject({ method: 'GET', url: `/api/runs/${run.id}`, headers: as(token) });
    const got = res.json<{ data: Record<string, unknown> }>().data;
    expect(got).toMatchObject({ modelCalls: 3, inputTokens: 30, outputTokens: 15, cachedInputTokens: 12, costKnown: true });
    expect(got.costUsd).toBe(0.000282);

    const list = await app.inject({ method: 'GET', url: '/api/runs', headers: as(token) });
    expect(list.json<{ data: { id: string; costUsd: number }[] }>().data.find((r) => r.id === run.id)?.costUsd).toBe(0.000282);
    const tasks = await app.inject({ method: 'GET', url: '/api/tasks', headers: as(token) });
    expect(tasks.json<{ data: { id: string; spend30d: unknown }[] }>().data.find((t) => t.id === task.id)?.spend30d).toEqual({ runs: 1, costUsd: 0.000282, costKnown: true, tokens: 45, succeeded: 1, avgSuccessCostUsd: 0.000282 });

    // The platform's usage report is priced once the port is bound (`priced: true`).
    const usage = await app.inject({ method: 'GET', url: '/api/admin/ai/usage', headers: as(admin.token) });
    expect(usage.statusCode).toBe(200);
    expect(usage.json<{ data: { priced: boolean } }>().data.priced).toBe(true);
  });

  it('marks the cost unknown when a call is on a model with no price, and the task spend with it', async () => {
    const { token, run, task } = await threeCallRun(`unpriced-${stamp}@example.test`, { provider: 'prov-a', model: 'model-unlisted' });
    const got = (await app.inject({ method: 'GET', url: `/api/runs/${run.id}`, headers: as(token) })).json<{ data: Record<string, unknown> }>().data;
    expect(got).toMatchObject({ modelCalls: 3, costUsd: 0, costKnown: false });
    const tasks = await app.inject({ method: 'GET', url: `/api/tasks/${task.id}`, headers: as(token) });
    expect(tasks.json<{ data: { spend30d: unknown } }>().data.spend30d).toMatchObject({ runs: 1, costUsd: 0, costKnown: false, tokens: 45 });
  });

  it("averages the task's spend over its successful runs only (#408)", async () => {
    const { token, userId } = await loginWithToken(`spend-avg-${stamp}@example.test`, 'contributor');
    const db = app.get(PrismaService).forUser({ userId });
    const task = await db.task.create({ data: { userId, name: 'Averaged', goal: 'Look around' } });
    const base = { userId, taskId: task.id, goal: task.goal };
    await db.run.create({ data: { ...base, status: 'succeeded', costUsd: 0.5, inputTokens: 100, outputTokens: 10 } });
    await db.run.create({ data: { ...base, status: 'succeeded', costUsd: 1.5, inputTokens: 100, outputTokens: 10 } });
    await db.run.create({ data: { ...base, status: 'failed', stopReason: 'budget_cost', costUsd: 2, inputTokens: 100, outputTokens: 10 } });
    const got = (await app.inject({ method: 'GET', url: `/api/tasks/${task.id}`, headers: as(token) })).json<{ data: { spend30d: unknown } }>().data.spend30d;
    expect(got).toEqual({ runs: 3, costUsd: 4, costKnown: true, tokens: 330, succeeded: 2, avgSuccessCostUsd: 1 });

    const none = await db.task.create({ data: { userId, name: 'Never succeeded', goal: 'Look around' } });
    await db.run.create({ data: { userId, taskId: none.id, goal: none.goal, status: 'failed', costUsd: 0.25 } });
    const failedOnly = (await app.inject({ method: 'GET', url: `/api/tasks/${none.id}`, headers: as(token) })).json<{ data: { spend30d: unknown } }>().data.spend30d;
    expect(failedOnly).toMatchObject({ runs: 1, succeeded: 0, avgSuccessCostUsd: null });
  });
});

/** A run policy snapshot of Balanced with these budget values (every other limit unlimited), as a first advance would store it. */
function snapshotWith(budget: Partial<AgentPolicySpec['budget']>): RunPolicySnapshot {
  const spec = balancedSpec();
  spec.budget = { ...spec.budget, maxActions: null, maxModelCalls: null, maxActiveMinutes: null, maxInputTokens: null, maxOutputTokens: null, maxCostUsd: null, ...budget };
  return { schemaVersion: 1, ref: 'builtin:balanced', name: 'Balanced', version: 1, builtin: true, source: 'system_default', spec, tiers: null, takenAt: new Date().toISOString() };
}

describe('the goal runner budgets (#399)', () => {
  async function setup(email: string, maxMinutes: number) {
    const userId = await login(email);
    const prisma = app.get(PrismaService);
    const db = prisma.forUser({ userId });
    const task = await db.task.create({ data: { userId, name: 'Budget', goal: 'Browse', maxMinutes } });
    const run = await db.run.create({ data: { userId, taskId: task.id, goal: task.goal } });
    return { userId, prisma, db, run, fabric: fakeFabric() };
  }

  it('a task made outside the API gets the unified defaults', async () => {
    const userId = await login(`runner-defaults-${stamp}@example.test`);
    const task = await app.get(PrismaService).forUser({ userId }).task.create({ data: { userId, name: 'Defaults', goal: 'Browse' } });
    expect(task).toMatchObject({ maxSteps: 100, maxMinutes: 30 });
  });

  it('does not count the wait for a person: a run that waited past maxMinutes resumes and finishes', async () => {
    const { userId, prisma, db, run, fabric } = await setup(`runner-wait-${stamp}@example.test`, 15);
    const { ai } = scriptedAi([[['request_human', { kind: 'code', prompt: 'Enter the code', input: 'text', choices: null }]], [['finish', { success: true, result: 'Done after the wait' }]]]);
    const runner = new GoalRunnerService(prisma, app.get(TasksService), fabric.client, ai);
    expect(await runner.advance(run.id, userId, null)).toBe('waiting_human');
    const waiting = await db.run.findFirstOrThrow({ where: { id: run.id } });
    expect(waiting.activeSince).toBeNull();
    // The person answers 20 minutes later: the run started 20 minutes ago by the wall clock.
    const longAgo = new Date(Date.now() - 20 * 60_000);
    await db.run.updateMany({ where: { id: run.id }, data: { startedAt: longAgo } });
    Object.assign([...fabric.handoffs.values()][0]!, { status: 'completed', response: { outcome: 'completed', value: '123', value_withheld: false } });
    expect(await runner.advance(run.id, userId, null)).toBe('succeeded');
    const done = await db.run.findFirstOrThrow({ where: { id: run.id } });
    expect(done).toMatchObject({ status: 'succeeded', result: 'Done after the wait', activeSince: null });
    expect(done.activeMs).toBeLessThan(60_000);
  });

  it('still stops with "Time budget exhausted" once active time passes the budget, and the alert counts it', async () => {
    const { userId, prisma, db, run, fabric } = await setup(`runner-time-${stamp}@example.test`, 1);
    await db.run.updateMany({ where: { id: run.id }, data: { policySnapshot: snapshotWith({ maxActiveMinutes: 1 }) as never, policySource: 'task', policyRef: 'builtin:balanced', policyVersion: 1 } });
    const { ai } = scriptedAi([[['navigate', { url: 'https://example.test/', reason: 'go' }], ['navigate', { url: 'https://example.test/2', reason: 'go' }]]]);
    const runner = new GoalRunnerService(prisma, app.get(TasksService), fabric.client, ai);
    // Every clock read passes 40 s of active time.
    let now = Date.now();
    runner.clock = () => (now += 40_000);
    expect(await runner.advance(run.id, userId, null)).toBe('failed');
    const done = await db.run.findFirstOrThrow({ where: { id: run.id } });
    expect(done).toMatchObject({ status: 'failed', error: 'Time budget exhausted', stopReason: 'budget_active_time' });
    const usage = await app.get(HexactraAlertsService, { strict: false }).sources.usage(new Date(Date.now() - 3_600_000));
    expect(usage.find((u) => u.userId === userId)?.budgetStops).toBe(1);
  });

  it('hands a long run to a new job near the runtime limit and resumes it without a new browser session', async () => {
    const { userId, prisma, db, run, fabric } = await setup(`runner-hop-${stamp}@example.test`, 480);
    // No time budget (#401): this test is about the job hop, not the active-time limit.
    await db.task.updateMany({ where: { id: run.taskId! }, data: { policyRef: 'builtin:unlimited' } });
    const { ai, runTools } = scriptedAi([
      [['navigate', { url: 'https://example.test/', reason: 'go' }]],
      [['navigate', { url: 'https://example.test/2', reason: 'go' }]],
      [['finish', { success: true, result: 'Long run done' }]],
    ]);
    const runner = new GoalRunnerService(prisma, app.get(TasksService), fabric.client, ai, undefined, undefined, undefined, app.get(PolicyResolver), app.get(PolicyModelCheck));
    // The first job's clock jumps 29 minutes during its first model round.
    let now = Date.now();
    runner.clock = () => now;
    runTools.mockImplementationOnce(async (req: { onStep?: (s: unknown) => void }) => {
      now += 29 * 60_000;
      req.onStep?.({ step: 1, response: { usage: { inputTokens: 1, outputTokens: 1 } }, calls: [] });
      return { final: { outputText: '' }, steps: [], stopReason: 'steps_exhausted' };
    });
    expect(await runner.advance(run.id, userId, null)).toBe('continue');
    const mid = await db.run.findFirstOrThrow({ where: { id: run.id } });
    expect(mid.status).toBe('running');
    expect(mid.activeSince).not.toBeNull();
    // The next job (a fresh job clock) carries on from the saved memory and the same session.
    runner.clock = () => (now += 1_000);
    expect(await runner.advance(run.id, userId, null)).toBe('succeeded');
    const done = await db.run.findFirstOrThrow({ where: { id: run.id } });
    expect(done).toMatchObject({ status: 'succeeded', result: 'Long run done' });
    expect(done.sessionId).toBe(mid.sessionId);
    const creates = (fabric.client.request as unknown as jest.Mock).mock.calls.filter(([m, p]) => m === 'POST' && p === '/v1/sessions');
    expect(creates).toHaveLength(1);
  });

  it('the handler queues the continuation as a new job even though its own job is still active', async () => {
    const { userId, run } = await setup(`runner-handler-${stamp}@example.test`, 30);
    const enqueue = jest.fn(async () => undefined);
    const runner = { advance: jest.fn(async () => 'continue') };
    const handler = new GoalRunHandler({ register: jest.fn() } as never, runner as never, app.get(PrismaService), { enqueue } as never);
    await handler.process({ id: 'job-1', orgId: null, payload: { runId: run.id, userId, orgId: null } } as never);
    expect(enqueue).toHaveBeenCalledWith(expect.objectContaining({ type: 'browser.goal.run', reason: 'run_continued', subjectId: run.id, skipDedup: true, scheduledFor: expect.any(Date) }));
    expect(handler.profile.maxRuntimeMs).toBe(30 * 60_000);
  });
});

describe('the goal runner enforces budgets (#404)', () => {
  const as = (token: string) => ({ authorization: `Bearer ${token}` });
  const nav = (n: number): Call[] => Array.from({ length: n }, (_, i): Call => ['navigate', { url: `https://shop.example.test/${i}`, reason: 'go' }]);
  const names = (req: { tools: { tool: { name: string } }[] }) => req.tools.map((t) => t.tool.name);

  async function loginToken(email: string, role: 'admin' | 'contributor'): Promise<{ token: string; userId: string }> {
    const res = await app.inject({ method: 'POST', url: '/api/auth/test/login', payload: { email, role } });
    const token = new URL(String(res.headers.location)).searchParams.get('token')!;
    const me = await app.inject({ method: 'GET', url: '/api/auth/me', headers: as(token) });
    return { token, userId: me.json<{ data: { id: string } }>().data.id };
  }

  /** A run whose snapshot holds exactly these budgets, as a first advance stores it. */
  async function budgetRun(email: string, budget: Partial<AgentPolicySpec['budget']>, columns: Record<string, unknown> = {}, withToken = false) {
    const { token, userId } = await loginToken(email, 'contributor');
    void withToken;
    const prisma = app.get(PrismaService);
    const db = prisma.forUser({ userId });
    const run = await db.run.create({
      data: { userId, goal: 'Browse the shop', policyRef: 'builtin:balanced', policyVersion: 1, policySource: 'system_default', policySnapshot: snapshotWith(budget) as never, ...columns },
    });
    return { token, userId, prisma, db, run };
  }
  const runnerOf = (prisma: PrismaService, ai: AiService, fabric: ReturnType<typeof fakeFabric>) => new GoalRunnerService(prisma, app.get(TasksService), fabric.client, ai, undefined, undefined, app.get(SystemSettingsService));

  const WRAP = 'Done 3 pages; the checkout remains.';
  const priced = { provider: 'prov-b', model: 'model-y' };

  async function setPricing(token: string) {
    const res = await app.inject({
      method: 'PATCH',
      url: '/api/system-settings',
      headers: as(token),
      payload: { agentPricing: { models: { 'prov-a:model-x': { inputPerMTok: 3, outputPerMTok: 15, cachedInputPerMTok: 0.3 }, 'prov-b:model-y': { inputPerMTok: 100_000, outputPerMTok: 0 } } } },
    });
    expect(res.statusCode).toBe(200);
  }

  // Each model step of the scripted AI is one call of 10 input and 5 output tokens (and $1 on prov-b:model-y).
  it.each([
    { key: 'budget_actions', error: 'Step budget exhausted', budget: { maxActions: 2 }, script: nav(3), usage: undefined },
    { key: 'budget_model_calls', error: 'Model call budget exhausted', budget: { maxModelCalls: 2 }, script: nav(3), usage: undefined },
    { key: 'budget_input_tokens', error: 'Input token budget exhausted', budget: { maxInputTokens: 15 }, script: nav(3), usage: undefined },
    { key: 'budget_output_tokens', error: 'Output token budget exhausted', budget: { maxOutputTokens: 8 }, script: nav(3), usage: undefined },
    { key: 'budget_cost', error: 'Cost budget exhausted', budget: { maxCostUsd: 1.5 }, script: nav(3), usage: priced },
  ])('$key: stops the run, makes a wrap-up call with only finish, and keeps the model\'s summary', async ({ key, error, budget, script, usage }) => {
    const admin = await loginToken(`budget-admin-${key}-${stamp}@example.test`, 'admin');
    await setPricing(admin.token);
    const { userId, prisma, db, run } = await budgetRun(`budget-${key}-${stamp}@example.test`, budget);
    const fabric = fakeFabric();
    const { ai, runTools } = scriptedAi([script, [['finish', { success: false, result: WRAP }]]], usage ?? null);
    expect(await runnerOf(prisma, ai, fabric).advance(run.id, userId, null)).toBe('failed');

    const done = await db.run.findFirstOrThrow({ where: { id: run.id } });
    expect(done).toMatchObject({ status: 'failed', stopReason: key, error, result: WRAP });
    // The chunk ended on the budget, then exactly one more call: only `finish`, one step, a capped output.
    expect(runTools).toHaveBeenCalledTimes(2);
    const wrap = runTools.mock.calls[1]![0] as unknown as { tools: { tool: { name: string } }[]; maxSteps: number; maxOutputTokens: number; input: string };
    expect(names(wrap)).toEqual(['finish']);
    expect(wrap).toMatchObject({ maxSteps: 1, maxOutputTokens: expect.any(Number) });
    expect(wrap.input).toMatch(/budget is used up\. Call finish now: success only if the goal is fully done/);
    // The wrap-up call is counted in the run's totals (2 chunk calls + 1 wrap-up call, minus what the budget cut).
    expect(done.modelCalls).toBeGreaterThanOrEqual(3);
    // Alerts count it from the typed reason.
    const usageRows = await app.get(HexactraAlertsService, { strict: false }).sources.usage(new Date(Date.now() - 3_600_000));
    expect(usageRows.find((u) => u.userId === userId)?.budgetStops).toBe(1);
  });

  it('active time: stops on the active-time budget with its own stop reason', async () => {
    const { userId, prisma, db, run } = await budgetRun(`budget-time-${stamp}@example.test`, { maxActiveMinutes: 1 });
    const { ai, runTools } = scriptedAi([nav(2), [['finish', { success: false, result: WRAP }]]]);
    const runner = runnerOf(prisma, ai, fakeFabric());
    let now = Date.now();
    runner.clock = () => (now += 20_000);
    expect(await runner.advance(run.id, userId, null)).toBe('failed');
    expect(await db.run.findFirstOrThrow({ where: { id: run.id } })).toMatchObject({ status: 'failed', stopReason: 'budget_active_time', error: 'Time budget exhausted', result: WRAP });
    expect(names(runTools.mock.calls[1]![0] as never)).toEqual(['finish']);
  });

  it('a wrap-up finish(success: true) ends the run as succeeded, still typed by the budget', async () => {
    const { userId, prisma, db, run } = await budgetRun(`budget-wrap-ok-${stamp}@example.test`, { maxActions: 2 });
    const { ai } = scriptedAi([nav(3), [['finish', { success: true, result: 'The goal was already met.' }]]]);
    expect(await runnerOf(prisma, ai, fakeFabric()).advance(run.id, userId, null)).toBe('succeeded');
    expect(await db.run.findFirstOrThrow({ where: { id: run.id } })).toMatchObject({ status: 'succeeded', stopReason: 'budget_actions', result: 'The goal was already met.', error: null });
  });

  it('without a finish in the wrap-up call the run ends on the budget message', async () => {
    const { userId, prisma, db, run } = await budgetRun(`budget-wrap-none-${stamp}@example.test`, { maxModelCalls: 1 });
    const { ai, runTools } = scriptedAi([nav(2), []]);
    expect(await runnerOf(prisma, ai, fakeFabric()).advance(run.id, userId, null)).toBe('failed');
    expect(runTools).toHaveBeenCalledTimes(2);
    const ended = await db.run.findFirstOrThrow({ where: { id: run.id } });
    expect(ended).toMatchObject({ status: 'failed', stopReason: 'budget_model_calls', error: 'Model call budget exhausted' });
    // No words from the model (#540): the result is the run's own last steps, not only the budget message.
    expect(ended.result).toMatch(/^Stopped before the agent could report\. Last steps:\n1\. navigate /);
  });

  it('a wrap-up that fails at the provider still ends the run on the budget', async () => {
    const { userId, prisma, db, run } = await budgetRun(`budget-wrap-err-${stamp}@example.test`, { maxActions: 1 });
    const { ai, runTools } = scriptedAi([nav(2)]);
    const scripted = runTools.getMockImplementation()!;
    let calls = 0;
    runTools.mockImplementation(async (req) => {
      if (++calls >= 2) throw new Error('provider down');
      return scripted(req);
    });
    expect(await runnerOf(prisma, ai, fakeFabric()).advance(run.id, userId, null)).toBe('failed');
    expect(await db.run.findFirstOrThrow({ where: { id: run.id } })).toMatchObject({ status: 'failed', stopReason: 'budget_actions', error: 'Step budget exhausted' });
  });

  it('a continued run starts from what it already used: no fresh budget after a hop or a handoff', async () => {
    // 5 of 6 model calls used in earlier jobs: this job's first call uses the last one.
    const { userId, prisma, db, run } = await budgetRun(`budget-resume-${stamp}@example.test`, { maxModelCalls: 6, maxCostUsd: 1 }, { modelCalls: 5, stepCount: 3, costUsd: 0.4 });
    const { ai, runTools } = scriptedAi([nav(3), [['finish', { success: false, result: WRAP }]]]);
    expect(await runnerOf(prisma, ai, fakeFabric()).advance(run.id, userId, null)).toBe('failed');
    expect(await db.run.findFirstOrThrow({ where: { id: run.id } })).toMatchObject({ stopReason: 'budget_model_calls', modelCalls: 7 });
    expect(runTools).toHaveBeenCalledTimes(2);
    // Already past a budget when a job starts: it goes straight to the wrap-up.
    const spent = await budgetRun(`budget-resume2-${stamp}@example.test`, { maxActions: 4 }, { stepCount: 4 });
    const second = scriptedAi([[['finish', { success: false, result: WRAP }]]]);
    expect(await runnerOf(spent.prisma, second.ai, fakeFabric()).advance(spent.run.id, spent.userId, null)).toBe('failed');
    expect(second.runTools).toHaveBeenCalledTimes(1);
    expect(names(second.runTools.mock.calls[0]![0] as never)).toEqual(['finish']);
    expect(await spent.db.run.findFirstOrThrow({ where: { id: spent.run.id } })).toMatchObject({ stopReason: 'budget_actions', result: WRAP });
  });

  it('warns once per budget at the threshold: the next round carries the line, and the log records it once', async () => {
    const { userId, prisma, db, run } = await budgetRun(`budget-warn-${stamp}@example.test`, { maxActions: 10, warnAtPercent: 80 });
    const { ai, runTools } = scriptedAi([nav(8), [...nav(1), ['finish', { success: true, result: 'Done' }]]]);
    expect(await runnerOf(prisma, ai, fakeFabric()).advance(run.id, userId, null)).toBe('succeeded');
    const inputs = runTools.mock.calls.map((c) => String((c[0] as { input: string }).input));
    expect(inputs).toHaveLength(2);
    expect(inputs[0]).not.toContain('Budget:');
    expect(inputs[1]).toContain('Budget: actions is at 80% (8 of 10). Finish the goal now if you can; otherwise call finish with what you achieved and what remains.');
    const saved = (await db.run.findFirstOrThrow({ where: { id: run.id } })).transcript as unknown as { log: string[]; warned: string[]; pendingWarnings: string[] };
    expect(saved.log.filter((l) => l.startsWith('Budget warning:'))).toEqual(['Budget warning: actions is at 80% (8 of 10).']);
    expect(saved.warned).toEqual(['actions']);
    expect(saved.pendingWarnings).toEqual([]);
  });

  describe('a chat run: budgets warn, they never stop it (#537)', () => {
    /** A chat run under these budgets: its stored snapshot has no effective budget yet, so the first advance fixes it, soft. */
    async function chatRun(label: string, budget: Partial<AgentPolicySpec['budget']>, columns: Record<string, unknown> = {}) {
      const r = await budgetRun(`soft-${label}-${stamp}@example.test`, budget);
      const chat = await r.db.conversation.create({ data: { userId: r.userId, title: 'Soft budget' } });
      await r.db.run.updateMany({ where: { id: r.run.id }, data: { trigger: 'chat', conversationId: chat.id, ...columns } });
      const overBudget = jest.fn(async () => undefined);
      const notifier = { needsYou: async () => undefined, finished: async () => undefined, started: async () => undefined, overBudget };
      const runner = (ai: AiService) => new GoalRunnerService(r.prisma, app.get(TasksService), fakeFabric().client, ai, notifier as never, undefined, app.get(SystemSettingsService));
      return { ...r, chatId: chat.id, overBudget, runner };
    }
    const inputsOf = (runTools: jest.Mock) => runTools.mock.calls.map((c) => String((c[0] as { input: string }).input)).join('\n');

    it('takes more actions than maxActions and ends succeeded by finishing; one notification, a neutral log line', async () => {
      const { userId, db, run, overBudget, runner, chatId } = await chatRun('actions', { maxActions: 3, warnAtPercent: 50 });
      const { ai, runTools } = scriptedAi([nav(5), [...nav(2), ['finish', { success: true, result: 'Paid and checked.' }]]]);
      expect(await runner(ai).advance(run.id, userId, null)).toBe('succeeded');
      const done = await db.run.findFirstOrThrow({ where: { id: run.id } });
      expect(done).toMatchObject({ status: 'succeeded', stopReason: 'finished', result: 'Paid and checked.', error: null });
      expect(done.stepCount).toBeGreaterThan(3);
      // The model is never told to hurry, and no wrap-up call is made.
      const sent = inputsOf(runTools);
      expect(sent).not.toContain('Finish the goal now');
      expect(sent).not.toContain('budget is used up');
      for (const c of runTools.mock.calls) expect(names(c[0] as never)).not.toEqual(['finish']);
      const memory = done.transcript as unknown as { log: string[]; overNoticed: string[]; pendingWarnings?: string[] };
      expect(memory.log.filter((l) => l.startsWith('Budget note:'))).toEqual(["Budget note: actions is over this chat's usual limit (3 of 3). The owner is present; keep working."]);
      expect(memory.log.some((l) => l.startsWith('Budget warning:'))).toBe(false);
      expect(memory.overNoticed).toEqual(['actions']);
      expect(memory.pendingWarnings ?? []).toEqual([]);
      // Exactly one "over its usual limit" notification, leading to the chat.
      expect(overBudget).toHaveBeenCalledTimes(1);
      expect(overBudget).toHaveBeenCalledWith(userId, expect.objectContaining({ id: run.id, conversationId: chatId }), '3 of 3', 'actions');
      // The snapshot records the soft enforcement once; the view says so.
      expect((done.policySnapshot as { effectiveBudget: { enforcement: string } }).effectiveBudget.enforcement).toBe('soft');
    });

    it('the same policy on a manual run still ends on budget_actions', async () => {
      const { userId, prisma, db, run } = await budgetRun(`soft-manual-${stamp}@example.test`, { maxActions: 3 });
      const { ai } = scriptedAi([nav(5), [['finish', { success: false, result: WRAP }]]]);
      expect(await runnerOf(prisma, ai, fakeFabric()).advance(run.id, userId, null)).toBe('failed');
      expect(await db.run.findFirstOrThrow({ where: { id: run.id } })).toMatchObject({ status: 'failed', stopReason: 'budget_actions' });
      expect(((await db.run.findFirstOrThrow({ where: { id: run.id } })).policySnapshot as { effectiveBudget: { enforcement: string } }).effectiveBudget.enforcement).toBe('hard');
    });

    it('continues past maxModelCalls, maxCostUsd and maxActiveMinutes; one notification for all of them', async () => {
      const admin = await loginToken(`soft-admin-${stamp}@example.test`, 'admin');
      await setPricing(admin.token);
      const { userId, db, run, overBudget, runner } = await chatRun('many', { maxModelCalls: 2, maxCostUsd: 1.5, maxActiveMinutes: 1 });
      const { ai, runTools } = scriptedAi([nav(4), [...nav(2), ['finish', { success: true, result: 'Done anyway' }]]], priced);
      const r = runner(ai);
      let now = Date.now();
      r.clock = () => (now += 20_000);
      expect(await r.advance(run.id, userId, null)).toBe('succeeded');
      const done = await db.run.findFirstOrThrow({ where: { id: run.id } });
      expect(done).toMatchObject({ status: 'succeeded', stopReason: 'finished', result: 'Done anyway' });
      expect(done.modelCalls).toBeGreaterThan(2);
      expect(Number(done.costUsd)).toBeGreaterThan(1.5);
      expect(inputsOf(runTools)).not.toMatch(/Finish the goal now|budget is used up/);
      const memory = done.transcript as unknown as { overNoticed: string[] };
      expect(memory.overNoticed).toEqual(expect.arrayContaining(['modelCalls', 'activeMinutes', 'cost']));
      expect(overBudget).toHaveBeenCalledTimes(1);
    });

    it('a chat run already over its limit when a job starts goes on working (no wrap-up), and is not notified again', async () => {
      const { userId, db, run, overBudget, runner } = await chatRun('resume', { maxActions: 4 }, { stepCount: 9, transcript: { log: [], chunks: 1, overNoticed: ['actions'], warned: ['actions'] } });
      const { ai, runTools } = scriptedAi([[...nav(1), ['finish', { success: true, result: 'Done' }]]]);
      expect(await runner(ai).advance(run.id, userId, null)).toBe('succeeded');
      expect(names(runTools.mock.calls[0]![0] as never)).not.toEqual(['finish']);
      expect(await db.run.findFirstOrThrow({ where: { id: run.id } })).toMatchObject({ status: 'succeeded', stopReason: 'finished', stepCount: 11 });
      expect(overBudget).not.toHaveBeenCalled();
    });

    it('the run view carries enforcement soft and the budgets it is over', async () => {
      const { userId, db, run, runner, token } = await chatRun('view', { maxActions: 2 });
      const { ai } = scriptedAi([[...nav(3), ['finish', { success: true, result: 'Done' }]]]);
      expect(await runner(ai).advance(run.id, userId, null)).toBe('succeeded');
      void db;
      const res = await app.inject({ method: 'GET', url: `/api/runs/${run.id}`, headers: as(token) });
      expect(res.statusCode).toBe(200);
      expect(res.json<{ data: { budget: unknown } }>().data.budget).toMatchObject({ enforcement: 'soft', over: ['actions'], percent: { actions: 200 } });
    });
  });

  it('carries no secret material in the warning, the wrap-up or the log', async () => {
    const { userId, prisma, run } = await budgetRun(`budget-secret-${stamp}@example.test`, { maxActions: 2, warnAtPercent: 50 });
    const { ai, runTools } = scriptedAi([[['type_text', { selector: '#otp', text: SECRET, submit: false }], ...nav(2)], [['finish', { success: false, result: WRAP }]]]);
    await runnerOf(prisma, ai, fakeFabric()).advance(run.id, userId, null);
    const sent = runTools.mock.calls.map((c) => String((c[0] as { input: string }).input)).join('\n');
    expect(sent).not.toContain(SECRET);
  });

  it('an Unlimited policy with no ceilings runs past 1,000 actions and stops only by finishing', async () => {
    const userId = await login(`budget-unlimited-${stamp}@example.test`);
    const prisma = app.get(PrismaService);
    const db = prisma.forUser({ userId });
    const task = await db.task.create({ data: { userId, name: 'Endless', goal: 'Browse', policyRef: 'builtin:unlimited' } });
    const run = await db.run.create({ data: { userId, taskId: task.id, goal: task.goal } });
    const many = nav(1_050);
    const { ai, runTools } = scriptedAi([many.slice(0, 350), many.slice(350, 700), many.slice(700), [['finish', { success: true, result: 'Browsed it all' }]]]);
    const runner = new GoalRunnerService(prisma, app.get(TasksService), fakeFabric().client, ai, undefined, undefined, app.get(SystemSettingsService), app.get(PolicyResolver), app.get(PolicyModelCheck));
    expect(await runner.advance(run.id, userId, null)).toBe('succeeded');
    const done = await db.run.findFirstOrThrow({ where: { id: run.id } });
    expect(done).toMatchObject({ status: 'succeeded', stopReason: 'finished', stepCount: 1_051 });
    expect(runTools).toHaveBeenCalledTimes(4);
    const view = await app.inject({ method: 'GET', url: `/api/runs/${run.id}`, headers: as((await loginToken(`budget-unlimited-${stamp}@example.test`, 'contributor')).token) });
    const budget = view.json<{ data: { budget: { effective: Record<string, number | null>; percent: Record<string, number | null> } } }>().data.budget;
    expect(Object.values(budget.percent).every((p) => p === null)).toBe(true);
    expect(budget.effective).toMatchObject({ actions: null, cost: null });
  }, 180_000);

  it('an Unlimited run says so on the first line of its log', async () => {
    const userId = await login(`budget-unlimited-log-${stamp}@example.test`);
    const prisma = app.get(PrismaService);
    const db = prisma.forUser({ userId });
    const task = await db.task.create({ data: { userId, name: 'Endless', goal: 'Browse', policyRef: 'builtin:unlimited' } });
    const run = await db.run.create({ data: { userId, taskId: task.id, goal: task.goal } });
    const { ai } = scriptedAi([[['finish', { success: true, result: 'ok' }]]]);
    const runner = new GoalRunnerService(prisma, app.get(TasksService), fakeFabric().client, ai, undefined, undefined, app.get(SystemSettingsService), app.get(PolicyResolver), app.get(PolicyModelCheck));
    expect(await runner.advance(run.id, userId, null)).toBe('succeeded');
    expect(((await db.run.findFirstOrThrow({ where: { id: run.id } })).transcript as unknown as { log: string[] }).log[0]).toBe(UNLIMITED_LOG_LINE);
  });

  it('a deployment ceiling clamps an unlimited policy; the run, its response and its stream say so', async () => {
    const admin = await loginToken(`budget-ceiling-admin-${stamp}@example.test`, 'admin');
    const set = await app.inject({ method: 'PATCH', url: '/api/system-settings', headers: as(admin.token), payload: { browserAgentCeilings: { maxActions: 2, maxCostUsd: null } } });
    expect(set.statusCode).toBe(200);
    try {
      const { token, userId } = await loginToken(`budget-ceiling-${stamp}@example.test`, 'contributor');
      const prisma = app.get(PrismaService);
      const db = prisma.forUser({ userId });
      const task = await db.task.create({ data: { userId, name: 'Capped', goal: 'Browse', policyRef: 'builtin:unlimited' } });
      const run = await db.run.create({ data: { userId, taskId: task.id, goal: task.goal } });
      const { ai } = scriptedAi([nav(3), [['finish', { success: false, result: WRAP }]]]);
      const runner = new GoalRunnerService(prisma, app.get(TasksService), fakeFabric().client, ai, undefined, undefined, app.get(SystemSettingsService), app.get(PolicyResolver), app.get(PolicyModelCheck));
      expect(await runner.advance(run.id, userId, null)).toBe('failed');
      const done = await db.run.findFirstOrThrow({ where: { id: run.id } });
      expect(done).toMatchObject({ stopReason: 'budget_actions', result: WRAP });
      expect((done.policySnapshot as unknown as { effectiveBudget: { limits: { actions: number }; source: { actions: string; cost: null } } }).effectiveBudget).toMatchObject({ limits: { actions: 2 }, source: { actions: 'ceiling', cost: null } });
      // A later change of the ceiling does not touch the snapshot of this run.
      await app.inject({ method: 'PATCH', url: '/api/system-settings', headers: as(admin.token), payload: { browserAgentCeilings: { maxActions: 50 } } });

      const res = await app.inject({ method: 'GET', url: `/api/runs/${run.id}`, headers: as(token) });
      const data = res.json<{ data: { stopReason: string; budget: { effective: Record<string, number | null>; used: Record<string, number>; percent: Record<string, number | null>; source: Record<string, string | null>; costKnown: boolean } } }>().data;
      expect(data.stopReason).toBe('budget_actions');
      expect(data.budget.effective).toMatchObject({ actions: 2, warnAtPercent: 80, cost: null });
      expect(data.budget.used.actions).toBeGreaterThanOrEqual(2);
      expect(data.budget.percent.actions).toBeGreaterThanOrEqual(100);
      expect(data.budget.source).toMatchObject({ actions: 'ceiling', cost: null });
      // The tier chips of the run page (#408): Unlimited starts on Standard and may reach Frontier.
      expect((data as unknown as { tier: unknown }).tier).toMatchObject({ start: 'standard', max: 'frontier', current: 'standard', escalations: 0 });
      const list = await app.inject({ method: 'GET', url: '/api/runs', headers: as(token) });
      expect(list.json<{ data: { id: string; stopReason: string; budget: unknown }[] }>().data.find((r) => r.id === run.id)).toMatchObject({ stopReason: 'budget_actions', budget: expect.any(Object) });
      expect(JSON.stringify(data)).not.toContain('policySnapshot');

      // The live stream carries the budget on its run event.
      // (`inject` cannot hold an event stream open: read the controller's observable.)
      const events = await lastValueFrom(app.get(RunLiveController).stream(userId, run.id).pipe(toArray()));
      const runEvent = events.find((ev) => ev.type === 'run');
      if (!runEvent) throw new Error('the stream sent no run event');
      const streamed = runEvent.data as { stopReason: string; budget: { effective: { actions: number }; percent: { actions: number } }; policySnapshot?: unknown };
      expect(streamed).toMatchObject({ stopReason: 'budget_actions', budget: { effective: { actions: 2 } } });
      expect(streamed.policySnapshot).toBeUndefined();
      expect((streamed as unknown as { tier: unknown }).tier).toMatchObject({ start: 'standard', current: 'standard' });
    } finally {
      await app.inject({ method: 'PATCH', url: '/api/system-settings', headers: as(admin.token), payload: { browserAgentCeilings: { maxActions: null } } });
    }
  });

  it('stamps stop_reason on every other way a run ends', async () => {
    // The model's own finish, a failed finish, and an answer without a finish.
    const a = await budgetRun(`stop-finish-${stamp}@example.test`, {});
    const fin = scriptedAi([[['finish', { success: true, result: 'ok' }]]]);
    expect(await runnerOf(a.prisma, fin.ai, fakeFabric()).advance(a.run.id, a.userId, null)).toBe('succeeded');
    expect(await a.db.run.findFirstOrThrow({ where: { id: a.run.id } })).toMatchObject({ status: 'succeeded', stopReason: 'finished' });

    const b = await budgetRun(`stop-failed-finish-${stamp}@example.test`, {});
    const bad = scriptedAi([[['finish', { success: false, result: 'could not' }]]]);
    expect(await runnerOf(b.prisma, bad.ai, fakeFabric()).advance(b.run.id, b.userId, null)).toBe('failed');
    expect(await b.db.run.findFirstOrThrow({ where: { id: b.run.id } })).toMatchObject({ status: 'failed', stopReason: 'finished' });

    const c = await budgetRun(`stop-completed-${stamp}@example.test`, {});
    const chat = scriptedAi([]);
    chat.runTools.mockImplementation(async () => ({ final: { outputText: 'All done' }, steps: [], stopReason: 'completed' }));
    expect(await runnerOf(c.prisma, chat.ai, fakeFabric()).advance(c.run.id, c.userId, null)).toBe('succeeded');
    expect(await c.db.run.findFirstOrThrow({ where: { id: c.run.id } })).toMatchObject({ status: 'succeeded', stopReason: 'finished', result: 'All done' });

    // Cancelled (by the runner, and by the API while queued).
    const d = await budgetRun(`stop-cancel-${stamp}@example.test`, {}, { cancelRequested: true });
    expect(await runnerOf(d.prisma, scriptedAi([]).ai, fakeFabric()).advance(d.run.id, d.userId, null)).toBe('cancelled');
    expect(await d.db.run.findFirstOrThrow({ where: { id: d.run.id } })).toMatchObject({ status: 'cancelled', stopReason: 'cancelled' });
    const e = await budgetRun(`stop-cancel-queued-${stamp}@example.test`, {});
    await app.get(TasksService).cancel(e.userId, e.run.id);
    expect(await e.db.run.findFirstOrThrow({ where: { id: e.run.id } })).toMatchObject({ status: 'cancelled', stopReason: 'cancelled' });

    // No browser: an error.
    const f = await budgetRun(`stop-nobrowser-${stamp}@example.test`, {});
    const broken = fakeFabric();
    (broken.client.request as unknown as jest.Mock).mockImplementation(async () => {
      throw new Error('fabric down');
    });
    expect(await runnerOf(f.prisma, scriptedAi([]).ai, broken).advance(f.run.id, f.userId, null)).toBe('failed');
    expect(await f.db.run.findFirstOrThrow({ where: { id: f.run.id } })).toMatchObject({ status: 'failed', stopReason: 'error' });
  });

  it('the job handler records stop_reason error, and no_model when no model could be chosen', async () => {
    const g = await budgetRun(`stop-handler-${stamp}@example.test`, {});
    const h = await budgetRun(`stop-handler-model-${stamp}@example.test`, {});
    const fail = (runId: string, userId: string, error: Error) => {
      const handler = new GoalRunHandler({ register: jest.fn() } as never, { advance: jest.fn(async () => { throw error; }) } as never, app.get(PrismaService), { enqueue: jest.fn() } as never);
      return handler.process({ id: 'job', orgId: null, payload: { runId, userId, orgId: null } } as never).catch(() => undefined);
    };
    await fail(g.run.id, g.userId, new Error('boom'));
    expect(await g.db.run.findFirstOrThrow({ where: { id: g.run.id } })).toMatchObject({ status: 'failed', stopReason: 'error', error: 'boom' });
    await fail(h.run.id, h.userId, new AiError('AI_INVALID_REQUEST', 'No model selected.'));
    expect(await h.db.run.findFirstOrThrow({ where: { id: h.run.id } })).toMatchObject({ status: 'failed', stopReason: 'no_model' });
  });

  it('alerts count budget stops from stop_reason, and legacy rows from their error text', async () => {
    const { userId, db } = await budgetRun(`budget-alerts-${stamp}@example.test`, {});
    const base = { userId, goal: 'g', status: 'failed' as const };
    await db.run.create({ data: { ...base, stopReason: 'budget_cost', error: 'anything' } });
    await db.run.create({ data: { ...base, stopReason: null, error: 'Step budget exhausted' } });
    await db.run.create({ data: { ...base, stopReason: 'error', error: 'Time budget exhausted' } });
    await db.run.create({ data: { ...base, stopReason: 'stalled', error: 'stuck' } });
    await db.run.create({ data: { ...base, stopReason: 'budget_actions', status: 'succeeded' } });
    const usage = await app.get(HexactraAlertsService, { strict: false }).sources.usage(new Date(Date.now() - 3_600_000));
    // The new reason and the legacy string count; an error that merely says so, a stall and a success do not.
    expect(usage.find((u) => u.userId === userId)?.budgetStops).toBe(2);
  });
});

describe('a step the owner confirmed (#540)', () => {
  const CARD = '4111 1111 1111 1111';
  const PROMPT = `Pressing Pay sends $10 from card ${CARD} to Person A and cannot be canceled. May I send it?`;
  const nav = (n: number): Call[] => Array.from({ length: n }, (_, i): Call => ['navigate', { url: `https://bank.example.test/${i}`, reason: 'check' }]);

  /** A manual run of a task that asks before a purchase, under a hard action budget. */
  async function confirmRun(label: string, maxActions: number) {
    const userId = await login(`confirmed-${label}-${stamp}@example.test`);
    const prisma = app.get(PrismaService);
    const db = prisma.forUser({ userId });
    const task = await db.task.create({ data: { userId, name: 'Pay', goal: 'Send the payment', confirmRiskyActions: true } });
    const run = await db.run.create({
      data: { userId, taskId: task.id, goal: task.goal, policyRef: 'builtin:balanced', policyVersion: 1, policySource: 'system_default', policySnapshot: snapshotWith({ maxActions }) as never },
    });
    return { userId, prisma, db, run, fabric: fakeFabric() };
  }
  const answer = (fabric: ReturnType<typeof fakeFabric>, approve: boolean) => {
    const h = [...fabric.handoffs.values()].at(-1)!;
    Object.assign(h, approve ? { status: 'completed', response: { outcome: 'completed', value_withheld: false } } : { status: 'cancelled', response: { outcome: 'cancelled', value_withheld: false } });
  };

  it('stores the approved, carried-out action (masked prompt) and leads the failed result with it', async () => {
    const { userId, prisma, db, run, fabric } = await confirmRun('stored', 4);
    const { ai } = scriptedAi([
      [
        ['click', { selector: '#pay', reason: 'pay now' }],
        ['request_human', { kind: 'confirmation', prompt: PROMPT, input: 'none', choices: null }],
      ],
      // The confirmed click, then checking the result until the hard budget stops the run; the wrap-up says nothing.
      [['click', { selector: '#pay', reason: 'pay now' }], ...nav(3)],
      [],
    ]);
    const runner = new GoalRunnerService(prisma, app.get(TasksService), fabric.client, ai, undefined, app.get(QuestionsService));
    expect(await runner.advance(run.id, userId, null)).toBe('waiting_human');
    answer(fabric, true);
    expect(await runner.advance(run.id, userId, null)).toBe('failed');

    const done = await db.run.findFirstOrThrow({ where: { id: run.id }, include: { steps: { orderBy: { seq: 'asc' } } } });
    expect(done.stopReason).toBe('budget_actions');
    const confirmed = done.confirmedActions as { seq: number; prompt: string; action: string; at: string }[];
    expect(confirmed).toHaveLength(1);
    const clicks = done.steps.filter((st) => st.action === 'click');
    // The policy-paused attempt is not the confirmed action; the second click is.
    expect(clicks[0]!.summary).toMatch(/^paused by policy/);
    expect(confirmed[0]).toMatchObject({ seq: clicks[1]!.seq, action: 'click', at: expect.any(String) });
    expect(confirmed[0]!.prompt).toContain('•••• 1111');
    expect(JSON.stringify(done.confirmedActions)).not.toContain(CARD);
    expect(JSON.stringify(done.confirmedActions)).not.toContain('4111111111111111');
    expect(done.result).toMatch(new RegExp(`^The step you confirmed was carried out \\(step ${clicks[1]!.seq}: 'Pressing Pay`));
    expect(done.result).toContain('Check before you run it again.');
    expect(done.result).toContain('Stopped before the agent could report.');
    // The API: the full run carries the list.
    const view = await app.get(TasksService).getRun(userId, run.id);
    expect(view.confirmedActions).toHaveLength(1);
  });

  it('a denied confirmation stores nothing', async () => {
    const { userId, prisma, db, run, fabric } = await confirmRun('denied', 6);
    const { ai } = scriptedAi([
      [
        ['click', { selector: '#pay', reason: 'pay now' }],
        ['request_human', { kind: 'confirmation', prompt: PROMPT, input: 'none', choices: null }],
      ],
      [['finish', { success: false, result: 'The owner declined.' }]],
    ]);
    const runner = new GoalRunnerService(prisma, app.get(TasksService), fabric.client, ai, undefined, app.get(QuestionsService));
    expect(await runner.advance(run.id, userId, null)).toBe('waiting_human');
    answer(fabric, false);
    expect(await runner.advance(run.id, userId, null)).toBe('failed');
    const done = await db.run.findFirstOrThrow({ where: { id: run.id } });
    expect(done.confirmedActions).toBeNull();
    expect(done.result).toBe('The owner declined.');
  });

  it('a failed click followed by a successful retry records the retry', async () => {
    const { userId, prisma, db, run, fabric } = await confirmRun('retry', 20);
    let failNext = false;
    const base = fabric.request.getMockImplementation()!;
    fabric.request.mockImplementation(async (method: string, path: string, opts: { body?: Record<string, unknown> } = {}) => {
      const action = opts.body?.action as { type?: string } | undefined;
      if (failNext && method === 'POST' && path.endsWith('/actions') && action?.type === 'click') {
        failNext = false;
        throw new FabricError('api', 'element_not_found', 404, 'element_not_found');
      }
      return base(method, path, opts);
    });
    const { ai } = scriptedAi([
      [
        ['click', { selector: '#pay', reason: 'pay now' }],
        ['request_human', { kind: 'confirmation', prompt: PROMPT, input: 'none', choices: null }],
      ],
      [
        ['click', { selector: '#pay', reason: 'pay now' }],
        ['click', { selector: '#pay', reason: 'pay now' }],
        ['finish', { success: true, result: 'Sent.' }],
      ],
    ]);
    const runner = new GoalRunnerService(prisma, app.get(TasksService), fabric.client, ai, undefined, app.get(QuestionsService));
    expect(await runner.advance(run.id, userId, null)).toBe('waiting_human');
    answer(fabric, true);
    failNext = true;
    expect(await runner.advance(run.id, userId, null)).toBe('succeeded');
    const done = await db.run.findFirstOrThrow({ where: { id: run.id }, include: { steps: { orderBy: { seq: 'asc' } } } });
    const clicks = done.steps.filter((st) => st.action === 'click');
    expect(clicks.map((c) => c.ok)).toEqual([false, false, true]);
    expect((done.confirmedActions as { seq: number }[]).map((c) => c.seq)).toEqual([clicks[2]!.seq]);
    // A succeeded run keeps its own result: no lead sentence.
    expect(done.result).toBe('Sent.');
  });
});

describe('the confirmation gate decides by what is clicked (#550)', () => {
  /** A manual run of a task that asks before commitments. */
  async function gatedRun(label: string) {
    const userId = await login(`gate-${label}-${stamp}@example.test`);
    const prisma = app.get(PrismaService);
    const db = prisma.forUser({ userId });
    const task = await db.task.create({ data: { userId, name: 'Zelle', goal: 'Send Person A $10 with Zelle', confirmRiskyActions: true } });
    const run = await db.run.create({ data: { userId, taskId: task.id, goal: task.goal } });
    const fabric = fakeFabric();
    fabric.targets.set('#date-18', { tag: 'td', role: 'gridcell', label: '18' });
    fabric.targets.set('#order', { tag: 'button', label: 'Place order' });
    fabric.targets.set('100,200', { tag: 'button', label: 'Place order' });
    fabric.targets.set('5,5', { tag: 'p', label: 'Your payment will arrive today' });
    return { userId, prisma, db, run, fabric };
  }
  const approve = (fabric: ReturnType<typeof fakeFabric>) => {
    const h = [...fabric.handoffs.values()].at(-1)!;
    Object.assign(h, { status: 'completed', response: { outcome: 'completed', value_withheld: false } });
  };
  const steps = (prisma: PrismaService, runId: string) => prisma.runStep.findMany({ where: { runId }, orderBy: { seq: 'asc' } });

  it('step 49: a date cell is clicked without a pause although the reason says "payment"; the reads are not actions', async () => {
    const { userId, prisma, db, run, fabric } = await gatedRun('date');
    const { ai } = scriptedAi([
      [
        ['click', { selector: '#date-18', reason: 'Choose today, the earliest available payment date' }],
        ['finish', { success: true, result: 'Date chosen.' }],
      ],
    ]);
    const runner = new GoalRunnerService(prisma, app.get(TasksService), fabric.client, ai, undefined, app.get(QuestionsService));
    expect(await runner.advance(run.id, userId, null)).toBe('succeeded');
    const all = await steps(prisma, run.id);
    const clicks = all.filter((s) => s.action === 'click');
    expect(clicks).toHaveLength(1);
    expect(clicks[0]!.ok).toBe(true);
    expect(clicks[0]!.summary).not.toMatch(/paused by policy/);
    expect(await db.question.count({ where: { runId: run.id } })).toBe(0);
    // The describe call happened, and it is neither a step nor an action of the run.
    expect(fabric.probes).toHaveLength(1);
    expect(fabric.actions.filter((a) => a.type === 'evaluate')).toHaveLength(0);
    // The same steps with confirmation off (no reads at all) count the same.
    const done = await db.run.findFirstOrThrow({ where: { id: run.id } });
    const plain = await gatedRun('date-plain');
    await plain.db.task.update({ where: { id: plain.run.taskId! }, data: { confirmRiskyActions: false } });
    const again = scriptedAi([[['click', { selector: '#date-18', reason: 'Choose today, the earliest available payment date' }], ['finish', { success: true, result: 'Date chosen.' }]]]);
    await new GoalRunnerService(prisma, app.get(TasksService), plain.fabric.client, again.ai).advance(plain.run.id, plain.userId, null);
    expect(plain.fabric.probes).toHaveLength(0);
    expect(done.stepCount).toBe((await plain.db.run.findFirstOrThrow({ where: { id: plain.run.id } })).stepCount);
    expect((await steps(prisma, run.id)).length).toBe((await steps(prisma, plain.run.id)).length);
  });

  it('a "Pay" button with a neutral reason is paused: the page supplies the label the model never observed', async () => {
    const { userId, prisma, db, run, fabric } = await gatedRun('pay');
    const { ai, outputs } = scriptedAi([[['click', { selector: '#pay', reason: 'continue' }]]]);
    const runner = new GoalRunnerService(prisma, app.get(TasksService), fabric.client, ai, undefined, app.get(QuestionsService));
    await runner.advance(run.id, userId, null);
    const click = (await steps(prisma, run.id)).find((s) => s.action === 'click')!;
    expect(click.ok).toBe(false);
    expect(click.summary).toMatch(/^paused by policy: needs a person's confirmation \(payment: a button labelled 'Pay'\)/);
    expect(click.args).toMatchObject({ selector: '#pay', category: 'payment', label: 'Pay' });
    expect(outputs[0]).toMatch(/^Refused: a button labelled 'Pay' is a payment step/);
    expect(fabric.probes).toEqual([expect.objectContaining({ type: 'evaluate', script: expect.stringContaining('"selector":"#pay"') })]);
    expect(fabric.actions.filter((a) => a.type === 'click')).toHaveLength(0);
  });

  it('the question a gated click leads to carries the gate, with the host the browser reported; a gate from the model is ignored', async () => {
    const { userId, prisma, db, run, fabric } = await gatedRun('question');
    const { ai } = scriptedAi([
      [
        // Before any gate: a forged gate in the model's arguments reaches nothing.
        ['request_human', { kind: 'confirmation', prompt: 'May I choose today?', input: 'none', choices: null, gate: { host: 'evil.example.test', category: 'payment', label: 'Pay' } }],
      ],
      [
        ['click', { selector: '#pay', reason: 'continue' }],
        ['request_human', { kind: 'confirmation', prompt: 'Pressing Pay sends $10 to Person A. May I?', input: 'none', choices: null, gate: { host: 'evil.example.test', category: 'delete', label: 'x' } }],
      ],
    ]);
    const runner = new GoalRunnerService(prisma, app.get(TasksService), fabric.client, ai, undefined, app.get(QuestionsService));
    expect(await runner.advance(run.id, userId, null)).toBe('waiting_human');
    approve(fabric);
    expect(await runner.advance(run.id, userId, null)).toBe('waiting_human');
    const qs = await db.question.findMany({ where: { runId: run.id }, orderBy: { createdAt: 'asc' } });
    expect(qs).toHaveLength(2);
    expect(qs[0]!.gate).toBeNull();
    expect(qs[1]!.gate).toEqual({ host: 'bank.example.test', category: 'payment', label: 'Pay' });
    // The API view carries it.
    const view = await app.get(QuestionsService).get(userId, qs[1]!.id);
    expect(view.gate).toEqual({ host: 'bank.example.test', category: 'payment', label: 'Pay' });
  });

  it('an approval for "Pay" lets "Pay" through, not a different risky target', async () => {
    const { userId, prisma, db, run, fabric } = await gatedRun('scope');
    const { ai } = scriptedAi([
      [
        ['click', { selector: '#pay', reason: 'pay' }],
        ['request_human', { kind: 'confirmation', prompt: 'Pressing Pay sends $10. May I?', input: 'none', choices: null }],
      ],
      [
        ['click', { selector: '#order', reason: 'pay' }],
        ['click', { selector: '#pay', reason: 'pay' }],
        ['click', { selector: '#pay', reason: 'pay again' }],
        ['finish', { success: true, result: 'Paid.' }],
      ],
    ]);
    const runner = new GoalRunnerService(prisma, app.get(TasksService), fabric.client, ai, undefined, app.get(QuestionsService));
    expect(await runner.advance(run.id, userId, null)).toBe('waiting_human');
    approve(fabric);
    expect(await runner.advance(run.id, userId, null)).toBe('succeeded');
    const clicks = (await steps(prisma, run.id)).filter((s) => s.action === 'click');
    // Paused at Pay; approved; Place order still paused; Pay goes ahead once; a second Pay is paused again.
    expect(clicks.map((c) => [c.ok, (c.args as { label?: string }).label ?? null])).toEqual([
      [false, 'Pay'],
      [false, 'Place order'],
      [true, null],
      [false, 'Pay'],
    ]);
    expect(fabric.actions.filter((a) => a.type === 'click')).toEqual([{ type: 'click', selector: '#pay' }]);
  });

  it('click_at over a "Place order" button is paused; over plain text it is not', async () => {
    const { userId, prisma, db, run, fabric } = await gatedRun('point');
    const at = (x: number, y: number): Call => ['click_at', { x, y, button: 'left', double: false, modifiers: [], reason: 'buy it now' }];
    const { ai } = scriptedAi([[at(5, 5), at(100, 200), ['finish', { success: false, result: 'Waiting.' }]]]);
    const runner = new GoalRunnerService(prisma, app.get(TasksService), fabric.client, ai, undefined, app.get(QuestionsService));
    await runner.advance(run.id, userId, null);
    const clicks = (await steps(prisma, run.id)).filter((s) => s.action === 'click_at');
    expect(clicks.map((c) => c.ok)).toEqual([true, false]);
    expect(clicks[1]!.args).toMatchObject({ x: 100, y: 200, category: 'purchase', label: 'Place order' });
    expect(fabric.actions.filter((a) => a.type === 'click_at')).toEqual([{ type: 'click_at', x: 5, y: 5 }]);
    expect(fabric.probes.map((p) => String(p.script).match(/const where = (.*);/)![1])).toEqual(['{"x":5,"y":5}', '{"x":100,"y":200}']);
  });

  it('with confirmation off, nothing is read and nothing is gated', async () => {
    const { userId, prisma, db, run, fabric } = await gatedRun('off');
    await db.task.update({ where: { id: run.taskId! }, data: { confirmRiskyActions: false } });
    const { ai } = scriptedAi([[['click', { selector: '#pay', reason: 'pay' }], ['finish', { success: true, result: 'Paid.' }]]]);
    const runner = new GoalRunnerService(prisma, app.get(TasksService), fabric.client, ai, undefined, app.get(QuestionsService));
    expect(await runner.advance(run.id, userId, null)).toBe('succeeded');
    expect(fabric.probes).toHaveLength(0);
    expect(fabric.actions.filter((a) => a.type === 'click')).toHaveLength(1);
  });
});

describe('the run trace (#541)', () => {
  const PROMPT = 'Pressing Pay sends $10 from card 4111 1111 1111 1111 to Person A. May I send it?';
  const JPEG = Buffer.from('fake-jpeg-bytes');

  /** A fabric whose masked screenshots answer with an image (or fail as told), and a store that keeps what it is given. */
  function traced(opts: { failMask?: string } = {}) {
    const fabric = fakeFabric();
    const masked: Record<string, unknown>[] = [];
    const base = fabric.request.getMockImplementation()!;
    fabric.request.mockImplementation((async (method: string, path: string, o: { body?: Record<string, unknown> } = {}) => {
      const action = o.body?.action as Record<string, unknown> | undefined;
      if (method === 'POST' && path.endsWith('/actions') && action?.type === 'screenshot' && action.mask === true) {
        masked.push(action);
        if (opts.failMask) return { id: 'op', state: 'failed', error: opts.failMask };
        return { id: 'op', state: 'succeeded', result: { data: JPEG.toString('base64'), mime: 'image/jpeg', masked: 3 } };
      }
      return base(method, path, o);
    }) as never);
    const objects = new Map<string, Buffer>();
    const store = {
      put: jest.fn(async (key: string, bytes: Buffer) => void objects.set(key, bytes)),
      get: jest.fn(async (key: string) => (objects.has(key) ? { bytes: objects.get(key)!, contentType: 'image/jpeg' } : null)),
      delete: jest.fn(async (key: string) => void objects.delete(key)),
    };
    return { fabric, masked, store, objects };
  }

  async function taskRun(label: string, columns: Record<string, unknown> = {}) {
    const userId = await login(`trace-${label}-${stamp}@example.test`);
    const prisma = app.get(PrismaService);
    const db = prisma.forUser({ userId });
    const task = await db.task.create({ data: { userId, name: 'Pay', goal: 'Send the payment', confirmRiskyActions: true } });
    const run = await db.run.create({ data: { userId, taskId: task.id, goal: task.goal, ...columns } });
    return { userId, prisma, db, run };
  }
  const stepsOf = (prisma: PrismaService, runId: string) => prisma.runStep.findMany({ where: { runId }, orderBy: { seq: 'asc' } });

  it('keeps masked pictures at the question, after the confirmed action and at the end; captures are not actions', async () => {
    const { userId, prisma, db, run } = await taskRun('confirm');
    const t = traced();
    const { ai } = scriptedAi([
      [
        ['click', { selector: '#pay', reason: 'pay now' }],
        ['request_human', { kind: 'confirmation', prompt: PROMPT, input: 'none', choices: null }],
      ],
      [['click', { selector: '#pay', reason: 'pay now' }], ['finish', { success: true, result: 'Sent.' }]],
    ]);
    const runner = new GoalRunnerService(prisma, app.get(TasksService), t.fabric.client, ai, undefined, app.get(QuestionsService), undefined, undefined, undefined, undefined, t.store);
    expect(await runner.advance(run.id, userId, null)).toBe('waiting_human');
    const h = [...t.fabric.handoffs.values()].at(-1)!;
    Object.assign(h, { status: 'completed', response: { outcome: 'completed', value_withheld: false } });
    expect(await runner.advance(run.id, userId, null)).toBe('succeeded');

    const steps = await stepsOf(prisma, run.id);
    const shots = steps.filter((x) => x.screenshotKey).map((x) => [x.kind, x.action, x.screenshotMoment, x.screenshotMasked]);
    expect(shots).toEqual([
      ['handoff', null, 'before_confirmed', 3],
      ['action', 'click', 'after_confirmed', 3],
      ['end', null, 'final', 3],
    ]);
    for (const x of steps.filter((y) => y.screenshotKey)) expect(x.screenshotKey).toBe(`runs/${userId}/${run.id}/${x.seq}-${x.screenshotMoment}.jpg`);
    expect([...t.objects.keys()].sort()).toEqual(steps.filter((y) => y.screenshotKey).map((y) => y.screenshotKey).sort());
    // Every trace capture asked the extension to mask, and never drew marks.
    expect(t.masked.length).toBe(3);
    for (const a of t.masked) expect(a).toEqual({ type: 'screenshot', mask: true });
    // The handoff step links its question; the answer is its own step; neither these nor the end are actions.
    const asked = steps.find((x) => x.kind === 'handoff' && x.action === null)!;
    expect(asked.questionId).toEqual(expect.any(String));
    const answered = steps.find((x) => x.action === 'answered')!;
    expect(answered).toMatchObject({ kind: 'handoff', summary: 'The owner allowed it', questionId: asked.questionId });
    const done = await db.run.findFirstOrThrow({ where: { id: run.id } });
    const actions = steps.filter((x) => ['action', 'handoff', 'finish'].includes(x.kind) && x.action !== 'answered');
    expect(done.stepCount).toBe(actions.length);
  });

  it('a secret request takes no picture and its answer step never holds the value', async () => {
    const { userId, prisma, db, run } = await taskRun('secret');
    const t = traced();
    const { ai } = scriptedAi([
      [['request_human', { kind: 'code', prompt: 'Enter the code sent to your phone', input: 'secret', choices: null }]],
      [['finish', { success: true, result: 'In.' }]],
    ]);
    const runner = new GoalRunnerService(prisma, app.get(TasksService), t.fabric.client, ai, undefined, app.get(QuestionsService), undefined, undefined, undefined, undefined, t.store);
    expect(await runner.advance(run.id, userId, null)).toBe('waiting_human');
    expect(t.masked).toHaveLength(0);
    const h = [...t.fabric.handoffs.values()].at(-1)!;
    Object.assign(h, { status: 'completed', response: { outcome: 'completed', value_withheld: true } });
    expect(await runner.advance(run.id, userId, null)).toBe('succeeded');
    const steps = await stepsOf(prisma, run.id);
    expect(steps.find((x) => x.kind === 'handoff' && x.action === null)!.screenshotKey).toBeNull();
    expect(steps.find((x) => x.action === 'answered')!.summary).toBe('The owner provided it');
    const view = await app.get(TasksService).getRun(userId, run.id);
    const q = (view.steps as { question: { answer: { valueWithheld: boolean; value?: string } | null } | null }[]).find((x) => x.question)!.question!;
    expect(q.answer?.valueWithheld ?? true).toBe(true);
    expect(q.answer?.value).toBeUndefined();
    expect(JSON.stringify(await db.run.findFirstOrThrow({ where: { id: run.id }, include: { steps: true } }))).not.toContain(SECRET);
  });

  it('a capture that cannot be masked leaves the run going and says why on the step', async () => {
    const { userId, prisma, run } = await taskRun('mask-fails');
    const t = traced({ failMask: 'mask_unavailable: a cross-origin frame fills the viewport' });
    const { ai } = scriptedAi([[['finish', { success: true, result: 'Done.' }]]]);
    const runner = new GoalRunnerService(prisma, app.get(TasksService), t.fabric.client, ai, undefined, undefined, undefined, undefined, undefined, undefined, t.store);
    expect(await runner.advance(run.id, userId, null)).toBe('succeeded');
    const end = (await stepsOf(prisma, run.id)).find((x) => x.kind === 'end')!;
    expect(end).toMatchObject({ screenshotKey: null, screenshotMoment: 'final', screenshotNote: 'masked_failed' });
    expect(t.store.put).not.toHaveBeenCalled();
  });

  it('without storage: no trace screenshot is asked for, and the run, its steps and questions are recorded', async () => {
    const { userId, prisma, run } = await taskRun('no-storage');
    const t = traced();
    const { ai } = scriptedAi([[['click', { selector: '#x', reason: 'go' }], ['finish', { success: true, result: 'Done.' }]]]);
    const runner = new GoalRunnerService(prisma, app.get(TasksService), t.fabric.client, ai);
    expect(await runner.advance(run.id, userId, null)).toBe('succeeded');
    expect(t.masked).toHaveLength(0);
    const steps = await stepsOf(prisma, run.id);
    expect(steps.map((x) => x.kind)).toEqual(['action', 'finish', 'end']);
    expect(steps.at(-1)).toMatchObject({ screenshotNote: 'no_storage', screenshotKey: null });
  });

  it('records chat guidance as masked guidance steps, not actions', async () => {
    const userId = await login(`trace-guidance-${stamp}@example.test`);
    const prisma = app.get(PrismaService);
    const db = prisma.forUser({ userId });
    const chat = await db.conversation.create({ data: { userId, title: 'Pay' } });
    const run = await db.run.create({ data: { userId, conversationId: chat.id, trigger: 'chat', goal: 'Pay the bill' } });
    await prisma.runGuidance.create({ data: { runId: run.id, conversationId: chat.id, messageSeq: 1, note: 'Use the account 123456789 ending in checking' } });
    const { ai } = scriptedAi([[['finish', { success: true, result: 'Paid.' }]]]);
    const runner = new GoalRunnerService(prisma, app.get(TasksService), fakeFabric().client, ai);
    expect(await runner.advance(run.id, userId, null)).toBe('succeeded');
    const steps = await stepsOf(prisma, run.id);
    const g = steps.find((x) => x.kind === 'guidance')!;
    expect(g.summary).toMatch(/^The owner added: Use the account/);
    expect(g.summary).not.toContain('123456789');
    expect((await db.run.findFirstOrThrow({ where: { id: run.id } })).stepCount).toBe(1);
  });

  it('past the cap keeps only the confirmed-action and final pictures', async () => {
    const { userId, prisma, run } = await taskRun('cap', { transcript: { log: [], chunks: 0, traceShots: 40 } });
    const t = traced();
    const { ai } = scriptedAi([
      [
        ['click', { selector: '#pay', reason: 'pay now' }],
        ['request_human', { kind: 'confirmation', prompt: PROMPT, input: 'none', choices: null }],
      ],
      [['request_human', { kind: 'other', prompt: 'Which account?', input: 'text', choices: null }]],
    ]);
    const runner = new GoalRunnerService(prisma, app.get(TasksService), t.fabric.client, ai, undefined, undefined, undefined, undefined, undefined, undefined, t.store);
    expect(await runner.advance(run.id, userId, null)).toBe('waiting_human');
    Object.assign([...t.fabric.handoffs.values()].at(-1)!, { status: 'completed', response: { outcome: 'completed', value_withheld: false } });
    expect(await runner.advance(run.id, userId, null)).toBe('waiting_human');
    const steps = await stepsOf(prisma, run.id);
    const handoffs = steps.filter((x) => x.kind === 'handoff' && x.action === null);
    // The confirmation's picture is kept past the cap; a plain question's is not.
    expect(handoffs.map((x) => [x.screenshotMoment, x.screenshotNote, Boolean(x.screenshotKey)])).toEqual([
      ['before_confirmed', null, true],
      ['question', 'capped', false],
    ]);
  });

  it('serves a step picture to its owner only', async () => {
    const { userId, prisma, run } = await taskRun('route');
    const t = traced();
    const { ai } = scriptedAi([[['finish', { success: true, result: 'Done.' }]]]);
    const runner = new GoalRunnerService(prisma, app.get(TasksService), t.fabric.client, ai, undefined, undefined, undefined, undefined, undefined, undefined, t.store);
    expect(await runner.advance(run.id, userId, null)).toBe('succeeded');
    const end = (await stepsOf(prisma, run.id)).find((x) => x.kind === 'end')!;
    const live = app.get(RunLiveController) as unknown as { artifacts?: unknown };
    const before = live.artifacts;
    live.artifacts = t.store;
    try {
      const token = async (email: string) => new URL(String((await app.inject({ method: 'POST', url: '/api/auth/test/login', payload: { email, role: 'contributor' } })).headers.location)).searchParams.get('token')!;
      const mine = await token(`trace-route-${stamp}@example.test`);
      const other = await token(`trace-route-other-${stamp}@example.test`);
      const get = (tk: string, seq: number) => app.inject({ method: 'GET', url: `/api/runs/${run.id}/steps/${seq}/screenshot`, headers: { authorization: `Bearer ${tk}` } });
      const ok = await get(mine, end.seq);
      expect(ok.statusCode).toBe(200);
      expect(ok.headers['content-type']).toBe('image/jpeg');
      expect(ok.headers['cache-control']).toBe('private, max-age=3600');
      expect(ok.rawPayload.equals(JPEG)).toBe(true);
      expect((await get(other, end.seq)).statusCode).toBe(404);
      expect((await get(mine, 999)).statusCode).toBe(404);
      expect((await get(mine, end.seq - 1)).statusCode).toBe(404);
      // The run view: hasScreenshot, never the key.
      const view = await app.inject({ method: 'GET', url: `/api/runs/${run.id}`, headers: { authorization: `Bearer ${mine}` } });
      const steps = view.json<{ data: { steps: Record<string, unknown>[] } }>().data.steps;
      expect(steps.at(-1)).toMatchObject({ kind: 'end', hasScreenshot: true, screenshotMoment: 'final' });
      expect(JSON.stringify(steps)).not.toContain('screenshotKey');
    } finally {
      live.artifacts = before;
    }
  });
});

describe('task outputs (E39.5, #600)', () => {
  const FOUR: TaskOutput[] = [
    { key: 'confirmation_number', label: 'Confirmation number', type: 'text', required: true, help: 'Shown on the receipt' },
    { key: 'amount_paid', label: 'Amount paid', type: 'money', required: true },
    { key: 'paid_on', label: 'Paid on', type: 'date', required: true },
    { key: 'balance', label: 'Remaining balance', type: 'money', required: false },
  ];
  const GOOD = { confirmation_number: 'C-8841', amount_paid: '$1,250.00', paid_on: 'March 25, 2026', balance: null };
  const WRAP = 'Paid; the balance page did not load.';

  async function outputsRun(email: string, spec: TaskOutput[] | null = FOUR, columns: Record<string, unknown> = {}) {
    const userId = await login(email);
    const prisma = app.get(PrismaService);
    const db = prisma.forUser({ userId });
    const task = await db.task.create({ data: { userId, name: 'Pay the rent', goal: 'Pay the rent', ...(spec ? { outputs: spec as never } : {}) } });
    const run = await db.run.create({ data: { userId, taskId: task.id, goal: 'Pay the rent', ...(spec ? { outputsSpec: spec as never } : {}), ...columns } });
    return { userId, prisma, db, task, run };
  }
  const runnerOf = (prisma: PrismaService, ai: AiService, fabric: ReturnType<typeof fakeFabric>) => new GoalRunnerService(prisma, app.get(TasksService), fabric.client, ai, { needsYou: async () => undefined, finished: async () => undefined } as never);
  const finish = (success: boolean, outputs: Record<string, unknown> | undefined, result = 'Paid the rent.'): Call => ['finish', { success, result, ...(outputs ? { outputs } : {}) }];
  /** The scripted model, with every request it was sent. */
  function recordingAi(scripts: Call[][]) {
    const scripted = scriptedAi(scripts);
    return scripted;
  }
  const reqs = (runTools: jest.Mock) => runTools.mock.calls.map((c) => c[0] as { instructions: string; input: string; tools: { tool: { name: string; parameters: z.ZodType } }[] });

  it('finishes a task with four outputs: all stored, read by type, outputsComplete true', async () => {
    const { userId, prisma, db, run } = await outputsRun(`outputs-ok-${stamp}@example.test`);
    const { ai, runTools } = recordingAi([[finish(true, GOOD)]]);
    expect(await runnerOf(prisma, ai, fakeFabric()).advance(run.id, userId, null)).toBe('succeeded');
    const done = await db.run.findFirstOrThrow({ where: { id: run.id } });
    expect(done).toMatchObject({ status: 'succeeded', outputsComplete: true, stopReason: 'finished' });
    expect(done.outputs).toEqual({
      confirmation_number: { value: 'C-8841', ok: true },
      amount_paid: { value: { amount: 1250, currency: 'USD' }, ok: true },
      paid_on: { value: '2026-03-25', ok: true },
      balance: { value: null, ok: true },
    });
    // The instructions list the outputs; the finish schema carries exactly the task's keys.
    const [first] = reqs(runTools);
    expect(first!.instructions).toContain('Outputs to return:');
    expect(first!.instructions).toContain('- confirmation_number (Confirmation number): text, required. Shown on the receipt');
    const json = z.toJSONSchema(first!.tools.find((t) => t.tool.name === 'finish')!.tool.parameters) as unknown as { properties: { outputs: { properties: Record<string, unknown> } } };
    expect(Object.keys(json.properties.outputs.properties)).toEqual(FOUR.map((o) => o.key));
  });

  it('a task without outputs keeps today’s finish schema and instructions, and stores no outputs', async () => {
    const { userId, prisma, db, run } = await outputsRun(`outputs-none-${stamp}@example.test`, null);
    const { ai, runTools } = recordingAi([[['finish', { success: true, result: 'Done.' }]]]);
    expect(await runnerOf(prisma, ai, fakeFabric()).advance(run.id, userId, null)).toBe('succeeded');
    const [first] = reqs(runTools);
    expect(first!.instructions).toBe(INSTRUCTIONS);
    expect(z.toJSONSchema(first!.tools.find((t) => t.tool.name === 'finish')!.tool.parameters)).toEqual(z.toJSONSchema(z.object({ success: z.boolean(), result: z.string().min(1).max(4000) })));
    expect(await db.run.findFirstOrThrow({ where: { id: run.id } })).toMatchObject({ outputs: null, outputsComplete: null });
  });

  it('keeps the instructions, the stable prefix, the same in every round', async () => {
    const { userId, prisma, run } = await outputsRun(`outputs-prefix-${stamp}@example.test`);
    const { ai, runTools } = recordingAi([[['navigate', { url: 'https://shop.example.test/pay', reason: 'open' }]], [['observe_elements', {}]], [finish(true, GOOD)]]);
    expect(await runnerOf(prisma, ai, fakeFabric()).advance(run.id, userId, null)).toBe('succeeded');
    const all = reqs(runTools);
    expect(all.length).toBeGreaterThanOrEqual(3);
    expect(new Set(all.map((r) => r.instructions)).size).toBe(1);
    expect(all[0]!.instructions.startsWith(INSTRUCTIONS)).toBe(true);
  });

  it('answers a finish with a missing required output, and the run goes on', async () => {
    const { userId, prisma, db, run } = await outputsRun(`outputs-missing-${stamp}@example.test`);
    const { ai, outputs } = recordingAi([[finish(true, { ...GOOD, confirmation_number: null, amount_paid: 'ten dollars' })], [finish(true, GOOD)]]);
    expect(await runnerOf(prisma, ai, fakeFabric()).advance(run.id, userId, null)).toBe('succeeded');
    expect(outputs[0]).toMatch(/^Not finished: `confirmation_number` is required; `amount_paid` is not an amount of money: 'ten dollars'\./);
    expect(outputs[1]).toBe('Finished.');
    const done = await db.run.findFirstOrThrow({ where: { id: run.id } });
    expect(done).toMatchObject({ status: 'succeeded', outputsComplete: true });
    // Only the accepted finish is a step of the run; the refusal is a note.
    const steps = await prisma.runStep.findMany({ where: { runId: run.id }, orderBy: { seq: 'asc' } });
    expect(steps.filter((x) => x.kind === 'finish')).toHaveLength(1);
    expect(steps.find((x) => x.kind === 'note')?.summary).toMatch(/finish was refused: confirmation_number, amount_paid \(1 of 2\)/);
  });

  it('after two bad attempts the run ends with what it has: invalid fields null with the reason, outputsComplete false', async () => {
    const { userId, prisma, db, run } = await outputsRun(`outputs-bad-${stamp}@example.test`);
    const bad = { confirmation_number: 'C-1', amount_paid: 'ten dollars', paid_on: null, balance: null };
    const { ai, outputs } = recordingAi([[finish(true, bad)], [finish(true, bad)], [finish(true, bad)]]);
    expect(await runnerOf(prisma, ai, fakeFabric()).advance(run.id, userId, null)).toBe('succeeded');
    expect(outputs[0]).not.toBe('Finished.');
    expect(outputs[1]).toMatch(/last time/);
    expect(outputs[2]).toBe('Finished.');
    const done = await db.run.findFirstOrThrow({ where: { id: run.id } });
    expect(done).toMatchObject({ status: 'succeeded', outputsComplete: false });
    expect(done.outputs).toEqual({
      confirmation_number: { value: 'C-1', ok: true },
      amount_paid: { value: null, ok: false, note: 'Not an amount of money' },
      paid_on: { value: null, ok: false, note: 'Not found' },
      balance: { value: null, ok: true },
    });
  });

  it('a failed run stores the outputs it gave, validated, and may omit the rest', async () => {
    const { userId, prisma, db, run } = await outputsRun(`outputs-failed-${stamp}@example.test`);
    const { ai, outputs } = recordingAi([[finish(false, { confirmation_number: 'C-2', amount_paid: 'n/a' }, 'Payment page was down.')]]);
    expect(await runnerOf(prisma, ai, fakeFabric()).advance(run.id, userId, null)).toBe('failed');
    // A failure is never refused.
    expect(outputs[0]).toBe('Finished.');
    const done = await db.run.findFirstOrThrow({ where: { id: run.id } });
    expect(done).toMatchObject({ status: 'failed', outputsComplete: false });
    expect(done.outputs).toMatchObject({ confirmation_number: { value: 'C-2', ok: true }, amount_paid: { value: null, ok: false, note: 'Not an amount of money' }, paid_on: { value: null, ok: false } });
  });

  it('a failed finish with no outputs at all still ends the run, every required output not found', async () => {
    const { userId, prisma, db, run } = await outputsRun(`outputs-omit-${stamp}@example.test`);
    const { ai } = recordingAi([[finish(false, undefined, 'Could not sign in.')]]);
    expect(await runnerOf(prisma, ai, fakeFabric()).advance(run.id, userId, null)).toBe('failed');
    const done = await db.run.findFirstOrThrow({ where: { id: run.id } });
    expect(done.outputsComplete).toBe(false);
    expect(done.outputs).toMatchObject({ confirmation_number: { value: null, ok: false, note: 'Not found' }, balance: { value: null, ok: true } });
  });

  it('the wrap-up call uses the same finish schema, and a stopped run still returns the fields it found', async () => {
    const { userId, prisma, db, run } = await outputsRun(`outputs-wrap-${stamp}@example.test`, FOUR, { policyRef: 'builtin:balanced', policyVersion: 1, policySource: 'system_default', policySnapshot: snapshotWith({ maxActions: 2 }) as never });
    const nav = (n: number): Call[] => Array.from({ length: n }, (_, i): Call => ['navigate', { url: `https://shop.example.test/${i}`, reason: 'go' }]);
    // The model gives a bad value in the wrap-up: there is no second try there.
    const { ai, runTools, outputs } = recordingAi([nav(3), [finish(false, { confirmation_number: 'C-3', amount_paid: 'lots' }, WRAP)]]);
    expect(await runnerOf(prisma, ai, fakeFabric()).advance(run.id, userId, null)).toBe('failed');
    expect(outputs.at(-1)).toBe('Finished.');
    const wrap = reqs(runTools)[1]!;
    expect(wrap.tools.map((t) => t.tool.name)).toEqual(['finish']);
    expect(wrap.instructions).toBe(reqs(runTools)[0]!.instructions);
    expect(wrap.input).toMatch(/Give the outputs in finish too/);
    const json = z.toJSONSchema(wrap.tools[0]!.tool.parameters) as unknown as { properties: { outputs: { properties: Record<string, unknown> } } };
    expect(Object.keys(json.properties.outputs.properties)).toEqual(FOUR.map((o) => o.key));
    const done = await db.run.findFirstOrThrow({ where: { id: run.id } });
    expect(done).toMatchObject({ status: 'failed', stopReason: 'budget_actions', result: WRAP, outputsComplete: false });
    expect(done.outputs).toMatchObject({ confirmation_number: { value: 'C-3', ok: true }, amount_paid: { value: null, ok: false } });
  });

  it('a model that stops without finish is asked for the outputs, twice at most', async () => {
    const { userId, prisma, db, run } = await outputsRun(`outputs-nofinish-${stamp}@example.test`);
    const scripted = recordingAi([[finish(true, GOOD)]]);
    let calls = 0;
    const runTools = jest.fn(async (req: Parameters<typeof scripted.runTools>[0]) => {
      calls += 1;
      if (calls === 1) return { final: { outputText: 'All done.' }, steps: [], stopReason: 'completed' };
      return scripted.runTools(req);
    });
    const ai = { forUser: () => ({ runTools }) } as unknown as AiService;
    expect(await runnerOf(prisma, ai, fakeFabric()).advance(run.id, userId, null)).toBe('succeeded');
    expect(calls).toBe(2);
    expect(String((runTools.mock.calls[1]![0] as { input: string }).input)).toMatch(/You stopped without calling finish/);
    expect(await db.run.findFirstOrThrow({ where: { id: run.id } })).toMatchObject({ outputsComplete: true });
  });

  it('keeps a sensitive output’s value out of the result text and the steps, and the trace holds no model arguments', async () => {
    const MARK = 'SENSITIVE-OUT-5521-zq';
    const spec: TaskOutput[] = [...FOUR, { key: 'account', label: 'Account', type: 'text', required: false, sensitive: true }];
    const { userId, prisma, db, run } = await outputsRun(`outputs-sens-${stamp}@example.test`, spec);
    const { ai } = recordingAi([[finish(true, { ...GOOD, account: MARK }, `Paid from account ${MARK}.`)]]);
    expect(await runnerOf(prisma, ai, fakeFabric()).advance(run.id, userId, null)).toBe('succeeded');
    const done = await db.run.findFirstOrThrow({ where: { id: run.id } });
    // Stored whole (a delivery the owner configured may carry it), but never in the words or the trace.
    expect(JSON.stringify(done.outputs)).toContain(MARK);
    expect(done.result).not.toContain(MARK);
    expect(JSON.stringify(await prisma.runStep.findMany({ where: { runId: run.id } }))).not.toContain(MARK);
    expect(JSON.stringify(done.transcript)).not.toContain(MARK);
  });

  it('a run stopped by the owner has not returned its outputs', async () => {
    const { userId, prisma, db, run } = await outputsRun(`outputs-cancel-${stamp}@example.test`);
    await app.get(TasksService).transition(userId, run.id, 'cancelled', { error: 'Cancelled before it started', stopReason: 'cancelled' });
    void prisma;
    expect(await db.run.findFirstOrThrow({ where: { id: run.id } })).toMatchObject({ status: 'cancelled', outputsComplete: false, outputs: null });
  });
});
