// E46.5 (#779) against a real database: the Knowledge Graph's capture. With the task's mode `learn` a run produces exactly what it produces
// with the feature off (prompt, tools, fabric actions, step rows, run row) plus one kg_traces row per tool call; with the mode `off` no
// observer is bound and nothing is written; planted markers (a typed password, a handoff code, a page sentence) never reach kg_traces.
import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import type { AiService } from '@marinoscar/platform-api/ai';
import { z } from 'zod';

import { KgraphEnabledService } from '../src/kgraph/kgraph-enabled.service';
import { createApp } from '../src/main';
import { PrismaService } from '../src/prisma/prisma.service';
import { QuestionEvents } from '../src/questions/question-events';
import { QuestionsService } from '../src/questions/questions.service';
import { GoalRunnerService } from '../src/runner/goal-runner.service';
import { TasksService } from '../src/tasks/tasks.service';
import { fakeSecretsFabric, type SecretsFabric } from './support/fake-secrets-fabric';

let app: NestFastifyApplication;
let prisma: PrismaService;
const stamp = `${Date.now()}`;

beforeAll(async () => {
  app = await createApp();
  await app.init();
  await app.getHttpAdapter().getInstance().ready();
  prisma = app.get(PrismaService);
});
afterAll(async () => {
  await prisma.systemSettings.updateMany({ data: {} }).catch(() => undefined);
  await app?.close();
});

async function login(email: string, role: 'contributor' | 'admin' = 'contributor'): Promise<{ userId: string; token: string }> {
  const res = await app.inject({ method: 'POST', url: '/api/auth/test/login', payload: { email, role } });
  const token = new URL(String(res.headers.location)).searchParams.get('token')!;
  const me = await app.inject({ method: 'GET', url: '/api/auth/me', headers: { authorization: `Bearer ${token}` } });
  return { userId: me.json<{ data: { id: string } }>().data.id, token };
}
const patch = (token: string, url: string, payload: object) => app.inject({ method: 'PATCH', url: `/api${url}`, headers: { authorization: `Bearer ${token}` }, payload });

type Call = [name: string, args: Record<string, unknown>];
type Tool = { tool: { name: string; description?: string; parameters?: unknown; strict?: boolean }; execute: (a: unknown, c: unknown) => Promise<unknown> };
type Req = { tools: Tool[]; onStep?: (s: unknown) => void; input: unknown; instructions?: string; [k: string]: unknown };

function scriptedAi(scripts: Call[][]) {
  const rounds: { request: Record<string, unknown>; tools: unknown[]; input: unknown; outputs: string[] }[] = [];
  const runTools = jest.fn(async (req: Req) => {
    const { tools, onStep, input, instructions, ...rest } = req;
    const offered = tools.map((t) => ({ name: t.tool.name, description: t.tool.description, strict: t.tool.strict, parameters: z.toJSONSchema(t.tool.parameters as z.ZodType) }));
    const round = { request: { ...rest, instructions }, tools: offered, input, outputs: [] as string[] };
    rounds.push(round);
    let step = 0;
    for (const [name, args] of scripts.shift() ?? []) {
      const t = tools.find((x) => x.tool.name === name);
      round.outputs.push(t ? String(await t.execute(args, { userId: 'u' })) : `NO TOOL ${name}`);
      onStep?.({ step: ++step, response: { usage: { inputTokens: 10, outputTokens: 5 } }, calls: [] });
    }
    return { final: { outputText: '' }, steps: [], stopReason: 'steps_exhausted' };
  });
  return { ai: { forUser: () => ({ runTools }) } as unknown as AiService, rounds };
}

const notifier = { finished: jest.fn(), needsYou: jest.fn(), started: jest.fn(), savedLoginUsed: jest.fn(), savedApprovalsUsed: jest.fn(), overBudget: jest.fn() };

function runnerOf(fabric: SecretsFabric, ai: AiService, kgraph: boolean) {
  const questions = new QuestionsService(prisma, fabric.client, { enqueue: async () => undefined } as never, new QuestionEvents());
  const r = new GoalRunnerService(prisma, app.get(TasksService), fabric.client, ai, notifier as never, questions);
  if (kgraph) r.kgraph = app.get(KgraphEnabledService);
  return r;
}

function scrub<T>(value: T): T {
  const text = JSON.stringify(value)
    .replace(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/g, '<uuid>')
    .replace(/\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?Z/g, '<time>')
    .replace(/data:image\/[a-z]+;base64,[A-Za-z0-9+/=]+/g, '<image>');
  return JSON.parse(text) as T;
}

async function record(runId: string, rounds: ReturnType<typeof scriptedAi>['rounds'], fabric: SecretsFabric, outcomes: string[]) {
  const steps = await prisma.runStep.findMany({ where: { runId }, orderBy: { seq: 'asc' } });
  const run = await prisma.run.findFirstOrThrow({ where: { id: runId } });
  const pick = ({ id: _id, runId: _r, createdAt: _c, startedAt: _s, ...s }: Record<string, unknown>) => ({ ...s, durationMs: typeof s.durationMs === 'number' ? 'ms' : s.durationMs });
  const { id: _i, taskId: _t, createdAt: _c, updatedAt: _u, startedAt: _s, finishedAt: _f, leaseUntil: _l, leaseOwner: _o, activeMs: _a, ...row } = run as unknown as Record<string, unknown>;
  return scrub({ outcomes, rounds, actions: fabric.actions, steps: steps.map((s) => pick(s as unknown as Record<string, unknown>)), run: row });
}

const TYPED_MARKER = ['typed', 'marker', 'hunter', 'xyz'].join('-');
const HANDOFF = 'otp-777333-zz';
const script = (): Call[][] => [
  [
    ['navigate', { url: 'https://shop.example.test/item?ref=abc', reason: 'open the shop' }],
    ['read_text', { selector: null }],
    ['type_text', { selector: '#q', text: TYPED_MARKER, submit: false }],
    ['click', { selector: '#go', reason: 'search' }],
    ['request_human', { kind: 'code', prompt: 'Enter the code', input: 'secret', choices: null, options: null, constraints: null, confirm_label: null, deny_label: null, risk: null, remember_label: null, topic: null }],
  ],
];

async function runOnce(userId: string, taskId: string, kgraph: boolean) {
  const run = await prisma.forUser({ userId }).run.create({ data: { userId, taskId, goal: 'Search the shop for blue pens' } });
  const fabric = fakeSecretsFabric('https://shop.example.test/start');
  fabric.page.inputs = [
    { selector: '#q', tag: 'input' },
    { selector: '#go', tag: 'button' },
  ];
  const first = scriptedAi(script());
  const outcomes = [await runnerOf(fabric, first.ai, kgraph).advance(run.id, userId, null)];
  const code = [...fabric.handoffs.values()][0]!;
  fabric.answer(code, { value_withheld: true });
  Object.assign(code, { secret: HANDOFF });
  const second = scriptedAi([[['type_handoff_secret', { selector: '#otp', submit: true, parameter: null }], ['finish', { success: true, result: 'Found them.' }]]]);
  outcomes.push(await runnerOf(fabric, second.ai, kgraph).advance(run.id, userId, null));
  return { runId: run.id, snap: await record(run.id, [...first.rounds, ...second.rounds], fabric, outcomes) };
}

describe('the Knowledge Graph capture (#779)', () => {
  let owner: { userId: string; token: string };
  let admin: { token: string };
  beforeAll(async () => {
    admin = await login(`kgcap-admin-${stamp}@example.test`, 'admin');
    owner = await login(`kgcap-owner-${stamp}@example.test`);
    await patch(admin.token, '/system-settings', { kgraph: { enabled: true, pacing: 'fast' } });
    await patch(owner.token, '/user-settings', { kgraph: { enabled: true } });
  });
  afterAll(async () => {
    await patch(admin.token, '/system-settings', { kgraph: { enabled: false } });
  });

  const newTask = async (mode: 'off' | 'learn' | 'unset') => {
    const task = await prisma.forUser({ userId: owner.userId }).task.create({ data: { userId: owner.userId, name: `Pens ${mode}`, goal: 'Search the shop for blue pens', confirmRiskyActions: false } });
    // AI only is stored explicitly: a task with no setting learns by default (#1031).
    if (mode !== 'unset') await prisma.kgTaskSettings.create({ data: { taskId: task.id, userId: owner.userId, mode } });
    return task.id;
  };

  it('learn mode: the run is identical to the feature off, plus one trace row per tool call, with no planted marker', async () => {
    const off = await runOnce(owner.userId, await newTask('off'), false);
    const learn = await runOnce(owner.userId, await newTask('learn'), true);
    expect(learn.snap).toEqual(off.snap);
    expect(await prisma.kgTrace.count({ where: { runId: off.runId } })).toBe(0);

    const traces = await prisma.kgTrace.findMany({ where: { runId: learn.runId }, orderBy: { seq: 'asc' } });
    expect(traces.map((t) => t.tool)).toEqual(['navigate', 'read_text', 'type_text', 'click', 'request_human', 'type_handoff_secret', 'finish']);
    expect(traces.every((t) => t.userId === owner.userId)).toBe(true);
    const nav = traces[0]!;
    // The console's pattern table treats a URL's query string as possibly secret (`urlSecret`): the whole URL is withheld.
    expect(nav.bindings).toMatchObject({ url: { kind: 'withheld' } });
    expect((traces[3]!.bindings as Record<string, unknown>).selector).toEqual({ kind: 'literal', value: '#go' });
    // Post-state is what the steps reported (the fake fabric's navigate reports no URL): never a query string.
    for (const t of traces) expect(JSON.stringify(t.post)).not.toMatch(/\?|ref=abc/);
    expect((traces[2]!.bindings as Record<string, unknown>).text).toEqual({ kind: 'model' });
    const stored = JSON.stringify(traces);
    for (const marker of [TYPED_MARKER, 'hunter', HANDOFF, '777333']) expect(stored).not.toContain(marker);
    // A page sentence read back by read_text is never stored: no trace holds result text.
    expect(stored).not.toMatch(/resultText|"text":"[^"]{40,}/);
  });

  it('a task its owner never set learns by default: its run is captured (#1031)', async () => {
    const { runId } = await runOnce(owner.userId, await newTask('unset'), true);
    expect(await prisma.kgTrace.count({ where: { runId } })).toBeGreaterThan(0);
    expect(await prisma.kgRun.findFirst({ where: { runId } })).toMatchObject({ mode: 'learn' });
  });

  it('off mode with the gate bound: no observer, nothing written', async () => {
    const taskId = await newTask('off');
    const { runId } = await runOnce(owner.userId, taskId, true);
    expect(await prisma.kgTrace.count({ where: { runId } })).toBe(0);
  });

  it('a failing trace write changes nothing about the run', async () => {
    const taskId = await newTask('learn');
    const create = prisma.kgTrace.create.bind(prisma.kgTrace);
    const spy = jest.spyOn(prisma.kgTrace, 'create').mockRejectedValue(new Error('db down') as never);
    try {
      const failing = await runOnce(owner.userId, taskId, true);
      spy.mockRestore();
      const off = await runOnce(owner.userId, await newTask('off'), false);
      expect(failing.snap).toEqual(off.snap);
      expect(await prisma.kgTrace.count({ where: { runId: failing.runId } })).toBe(0);
    } finally {
      spy.mockRestore();
      void create;
    }
  });
});
