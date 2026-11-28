// Several actions in one model reply, through the console's host (E54.1, #1082): with `actionsPerReply` above 1 in the run's policy, a reply
// of fill actions then one click runs in order, and an action after the click is not run (nothing reaches the browser for it). With the
// setting absent (every built-in) the same reply runs every call, as before, and the instructions are unchanged.
import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import type { AiService } from '@marinoscar/platform-api/ai';

import { createApp } from '../src/main';
import { balancedSpec } from '../src/policies/builtin-policies';
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
  process.env.JOBS_WORKER_MODE = 'off';
  app = await createApp();
  await app.init();
  prisma = app.get(PrismaService);
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

type Call = [name: string, args: Record<string, unknown>];
type Req = { tools: { tool: { name: string }; execute: (a: unknown, c: unknown) => Promise<unknown> }[]; onStep?: (s: unknown) => void; instructions?: string };

/** A model whose every reply carries several calls: the calls of one reply run, then ONE step is reported (as a provider does). */
function replyingAi(replies: Call[][]) {
  const outputs: string[][] = [];
  const instructions: string[] = [];
  const inputs: string[] = [];
  const runTools = jest.fn(async (req: Req) => {
    instructions.push(req.instructions ?? '');
    inputs.push(JSON.stringify((req as { input?: unknown }).input));
    let step = 0;
    while (replies.length) {
      const reply = replies.shift()!;
      const out: string[] = [];
      for (const [name, args] of reply) out.push(String(await req.tools.find((t) => t.tool.name === name)!.execute(args, { userId: 'u' })));
      outputs.push(out);
      req.onStep?.({ step: ++step, response: { usage: { inputTokens: 10, outputTokens: 5 } }, calls: [] });
    }
    return { final: { outputText: '' }, steps: [], stopReason: 'steps_exhausted' };
  });
  return { ai: { forUser: () => ({ runTools }) } as unknown as AiService, outputs, instructions, inputs };
}

const notifier = { finished: jest.fn(), needsYou: jest.fn(), started: jest.fn(), savedLoginUsed: jest.fn(), savedApprovalsUsed: jest.fn(), overBudget: jest.fn() };
const runnerOf = (fabric: SecretsFabric, ai: AiService) =>
  new GoalRunnerService(prisma, app.get(TasksService), fabric.client, ai, notifier as never, new QuestionsService(prisma, fabric.client, { enqueue: async () => undefined } as never, new QuestionEvents()));

const REPLY: Call[] = [
  ['type_text', { selector: '#q', text: 'blue pens', submit: false }],
  ['type_text', { selector: '#r', text: 'size M', submit: false }],
  ['click', { selector: '#go', reason: 'search' }],
  ['type_text', { selector: '#q', text: 'too late', submit: false }],
];
const FINISH: Call[] = [['finish', { success: true, result: 'Searched.' }]];

async function runWith(actionsPerReply: number | null, more: Record<string, unknown> = {}, tabs: { id: number; active: boolean; url: string; title: string }[] | null = null) {
  const userId = await login(`reply-${actionsPerReply}-${stamp}@example.test`);
  const db = prisma.forUser({ userId });
  const run = await db.run.create({ data: { userId, goal: 'Search the shop for blue pens' } });
  const spec = balancedSpec();
  const context = { ...(actionsPerReply === null ? spec.context : { ...spec.context, actionsPerReply }), ...more };
  const snapshot = { schemaVersion: 1, ref: 'reply', name: 'Reply', version: 1, builtin: false, source: 'system_default', spec: { ...spec, context }, tiers: null, takenAt: '2026-11-28T00:00:00.000Z' };
  await db.run.update({ where: { id: run.id }, data: { policySnapshot: snapshot as never } });
  const fabric = fakeSecretsFabric('https://shop.example.test/start');
  fabric.page.inputs = [
    { selector: '#q', tag: 'input' },
    { selector: '#r', tag: 'input' },
    { selector: '#go', tag: 'button' },
  ];
  fabric.page.tabs = tabs;
  const model = replyingAi([REPLY, FINISH]);
  const outcome = await runnerOf(fabric, model.ai).advance(run.id, userId, null);
  const steps = await prisma.runStep.findMany({ where: { runId: run.id }, orderBy: { seq: 'asc' }, select: { action: true, kind: true } });
  const sent = (fabric.actions as { action?: { type?: string }; type?: string }[]).map((a) => a.action?.type ?? a.type).filter((t) => t === 'type' || t === 'click');
  return { outcome, model, steps: steps.map((s) => s.action ?? s.kind), sent };
}

describe('several actions per reply', () => {
  it('runs the fill actions and the click, and nothing after the click', async () => {
    const r = await runWith(3);
    expect(r.outcome).toBe('succeeded');
    expect(r.model.instructions[0]).toContain('send up to 3 actions in one reply');
    expect(r.model.outputs[0]![3]).toMatch(/^Not run: click may have changed the page/);
    expect(r.sent).toEqual(['type', 'type', 'click']);
    expect(r.steps.filter((a) => a === 'type' || a === 'click')).toEqual(['type', 'type', 'click']);
  });

  it('without the setting, runs every call of the reply and keeps the instructions as they were', async () => {
    const r = await runWith(null);
    expect(r.outcome).toBe('succeeded');
    expect(r.model.instructions[0]).toContain('- Check the result of each action before the next one.');
    expect(r.model.instructions[0]).not.toContain('actions in one reply');
    expect(r.model.outputs[0]!.some((o) => o.startsWith('Not run'))).toBe(false);
    expect(r.sent).toEqual(['type', 'type', 'click', 'type']);
  });
});

describe('what changed, with each action (E54.2, #1083)', () => {
  const TABS = [
    { id: 1, active: false, url: 'https://shop.example.test/start', title: 'Start' },
    { id: 2, active: true, url: 'https://shop.example.test/cart', title: 'Cart' },
  ];

  it('names the open tabs in the round with `delta`', async () => {
    const r = await runWith(null, { actionResults: 'delta' }, TABS);
    expect(r.outcome).toBe('succeeded');
    expect(r.model.inputs[0]).toContain('Tabs: 2 open; active: \\"Cart\\" at https://shop.example.test/cart.');
  });

  it('says nothing of the tabs without it, with the same two tabs open', async () => {
    const r = await runWith(null, {}, TABS);
    expect(r.model.inputs[0]).not.toContain('Tabs: 2 open');
  });
});
