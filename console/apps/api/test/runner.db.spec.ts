// The goal runner against a real database, with a scripted model and an
// in-memory fabric: policy refusals, a confirmation handoff, a secret typed
// by the runner (never stored), finishing, and cancelling.
import { randomUUID } from 'node:crypto';
import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import type { AiService } from '@marinoscar/platform-api/ai';

import { createApp } from '../src/main';
import { PrismaService } from '../src/prisma/prisma.service';
import { FabricError, type FabricClient } from '../src/fabric/fabric.client';
import { GoalRunnerService } from '../src/runner/goal-runner.service';
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

/** An in-memory fabric: sessions, actions and handoffs. */
function fakeFabric() {
  const actions: Record<string, unknown>[] = [];
  // The fabric's real handoff view (crates/hexactra-core/src/remote.rs `HandoffView`).
  const handoffs = new Map<string, { id: string; status: string; input: string; kind: string; response?: { outcome?: string; value?: string; value_withheld: boolean; channel?: string; by?: string; answered_at?: string } }>();
  const typed = new Set<string>();
  let ended = 0;
  const request = jest.fn(async (method: string, path: string, opts: { body?: Record<string, unknown> } = {}) => {
    if (method === 'POST' && path === '/v1/sessions') return { id: '00000000-0000-4000-8000-00000000000a' };
    if (method === 'DELETE' && path.startsWith('/v1/sessions/')) return void (ended += 1);
    if (method === 'POST' && path.endsWith('/actions')) {
      const action = opts.body!.action as Record<string, unknown>;
      actions.push(action);
      if (action.type === 'navigate') return { id: 'op', state: 'succeeded', result: { url: action.url, title: 'Shop' } };
      if (action.type === 'elements') return { id: 'op', state: 'succeeded', result: { elements: [{ selector: '#buy', tag: 'button', text: 'Place order' }] } };
      if (action.type === 'type_secret') {
        // The fabric types the answer itself, once; the console only names the handoff.
        const h = handoffs.get(String(action.handoff_id));
        if (!h || h.input !== 'secret' || h.status !== 'completed' || typed.has(h.id)) throw new FabricError('api', 'secret_unavailable', 409, 'secret_unavailable');
        typed.add(h.id);
        return { id: 'op', state: 'succeeded', result: {} };
      }
      return { id: 'op', state: 'succeeded', result: {} };
    }
    if (method === 'POST' && path.endsWith('/handoffs')) {
      // Unique per run of the suite: the question broker mirrors handoffs by id.
      const id = randomUUID();
      handoffs.set(id, { id, status: 'pending', input: String(opts.body!.input), kind: String(opts.body!.kind) });
      return { handoff: { id } };
    }
    if (method === 'GET' && path.startsWith('/v1/handoffs/')) return handoffs.get(path.split('/')[3]!);
    // The deprecated claim route returns the plaintext: the console must never call it.
    if (method === 'POST' && path.endsWith('/claim')) throw new Error('the console called the secret claim route');
    throw new Error(`unexpected ${method} ${path}`);
  });
  const claimed = () => request.mock.calls.some(([, path]) => String(path).endsWith('/claim'));
  return { client: { request, config: async () => ({ url: 'http://f', token: 't' }) } as unknown as FabricClient, actions, handoffs, ended: () => ended, claimed };
}

type Call = [name: string, args: Record<string, unknown>];

/** A model that makes the scripted tool calls, one script per runTools call. */
function scriptedAi(scripts: Call[][], served: { provider: string; model: string; cachedInputTokens?: number } | null = null, usage: { inputTokens: number; outputTokens: number } = { inputTokens: 10, outputTokens: 5 }) {
  const outputs: string[] = [];
  const runTools = jest.fn(async (req: { tools: { tool: { name: string }; execute: (a: unknown, c: unknown) => Promise<unknown> }[]; onStep?: (s: unknown) => void; input: string }) => {
    const script = scripts.shift() ?? [];
    let step = 0;
    for (const [name, args] of script) {
      const t = req.tools.find((x) => x.tool.name === name)!;
      outputs.push(String(await t.execute(args, { userId: 'u' })));
      req.onStep?.({ step: ++step, response: { ...(served ? { provider: served.provider, model: served.model } : {}), usage: { ...usage, ...(served?.cachedInputTokens ? { cachedInputTokens: served.cachedInputTokens } : {}) } }, calls: [] });
    }
    return { final: { outputText: '' }, steps: [], stopReason: 'steps_exhausted' };
  });
  return { ai: { forUser: () => ({ runTools }) } as unknown as AiService, runTools, outputs };
}

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
    expect(outputs[3]).toMatch(/Refused: this looks like a purchase/);
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
    expect(await db.run.findFirstOrThrow({ where: { id: run.id } })).toMatchObject({ status: 'failed', stopReason: 'budget_model_calls', error: 'Model call budget exhausted', result: null });
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
