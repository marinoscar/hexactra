// E46.15 (#789) interrupts end to end. E46.13 (#787) the surface graph end to end, against a real database (helpers as in kgraph-replay.db.spec.ts). E46.9 (#783) against a real database: a reuse-mode task run replays its procedure inside the ordinary run. Every call goes through
// executeTool (each one reaches the observer the wrapper calls), no model call for call steps, ordinary step rows; a mismatch hands over to
// the loop with one note; Stop before a step ends it; the site gate refuses a replayed navigate outside the allowed sites; a commit step
// whose intent was left open is never sent again; with the mode off nothing of this is entered.
import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import type { AiService } from '@marinoscar/platform-api/ai';
import { procedureVersionSchema, type ProcedureVersionInput } from '@marinoscar/hexactra-kgraph';

import { KgraphAfterRun } from '../src/kgraph/kgraph-compile.job';
import { KgraphCompileService } from '../src/kgraph/kgraph-compile.service';
import { KgraphEnabledService } from '../src/kgraph/kgraph-enabled.service';
import { PrismaProcedureStore } from '../src/kgraph/prisma-procedure-store';
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
const workerMode = process.env.JOBS_WORKER_MODE;

beforeAll(async () => {
  process.env.JOBS_WORKER_MODE = 'off';
  app = await createApp();
  await app.init();
  await app.getHttpAdapter().getInstance().ready();
  if (workerMode === undefined) delete process.env.JOBS_WORKER_MODE;
  else process.env.JOBS_WORKER_MODE = workerMode;
  prisma = app.get(PrismaService);
});
afterAll(async () => {
  await app?.close();
});

async function login(email: string, role: 'contributor' | 'admin' = 'contributor') {
  const res = await app.inject({ method: 'POST', url: '/api/auth/test/login', payload: { email, role } });
  const token = new URL(String(res.headers.location)).searchParams.get('token')!;
  const me = await app.inject({ method: 'GET', url: '/api/auth/me', headers: { authorization: `Bearer ${token}` } });
  return { userId: me.json<{ data: { id: string } }>().data.id, token };
}
const patch = (token: string, url: string, payload: object) => app.inject({ method: 'PATCH', url: `/api${url}`, headers: { authorization: `Bearer ${token}` }, payload });

type Call = [name: string, args: Record<string, unknown>];
type Tool = { tool: { name: string }; execute: (a: unknown, c: unknown) => Promise<unknown> };
function scriptedAi(scripts: Call[][]) {
  const inputs: unknown[] = [];
  const runTools = jest.fn(async (req: { tools: Tool[]; input: unknown; onStep?: (s: unknown) => void }) => {
    inputs.push(req.input);
    let step = 0;
    for (const [name, args] of scripts.shift() ?? []) {
      const t = req.tools.find((x) => x.tool.name === name);
      if (t) await t.execute(args, { userId: 'u' });
      req.onStep?.({ step: ++step, response: { usage: { inputTokens: 10, outputTokens: 5 } }, calls: [] });
    }
    return { final: { outputText: '' }, steps: [], stopReason: 'steps_exhausted' };
  });
  return { ai: { forUser: () => ({ runTools }) } as unknown as AiService, runTools, inputs };
}
const notifier = { finished: jest.fn(), needsYou: jest.fn(), started: jest.fn(), savedLoginUsed: jest.fn(), savedApprovalsUsed: jest.fn(), overBudget: jest.fn() };
function runnerOf(fabric: SecretsFabric, ai: AiService, kgraph = true) {
  const questions = new QuestionsService(prisma, fabric.client, { enqueue: async () => undefined } as never, new QuestionEvents());
  const r = new GoalRunnerService(prisma, app.get(TasksService), fabric.client, ai, notifier as never, questions);
  if (kgraph) {
    r.kgraph = app.get(KgraphEnabledService);
    r.kgraphAfterRun = app.get(KgraphAfterRun);
    r.kgraphStore = app.get(PrismaProcedureStore);
  }
  return r;
}

describe('interrupt handlers (#789)', () => {
  let owner: { userId: string; token: string };
  let admin: { token: string };
  beforeAll(async () => {
    admin = await login(`kgint-admin-${stamp}@example.test`, 'admin');
    owner = await login(`kgint-owner-${stamp}@example.test`);
    await patch(admin.token, '/system-settings', { kgraph: { enabled: true, auditEvery: 0, pacing: 'fast' } });
    await patch(owner.token, '/user-settings', { kgraph: { enabled: true } });
  });
  afterAll(async () => {
    await patch(admin.token, '/system-settings', { kgraph: { enabled: false, auditEvery: 10 } });
  });
  const go = { selector: '#go', selectors: ['#go'], role: 'button', name: 'Search', tag: 'button', inputType: 'submit', anchor: 'Find pens' };
  const accept = { selector: '#accept', selectors: ['#accept'], role: 'button', name: 'Accept all', tag: 'button', inputType: null, anchor: 'We use cookies' };
  const fabricWith = (els: Record<string, unknown>[]) => {
    const f = fakeSecretsFabric('https://shop.example.test/start');
    f.surface.push(...els);
    return f;
  };
  /** Clicking the banner's choice takes the banner away and shows the page (a hook on the fake's requests). */
  const banneredPage = (f: ReturnType<typeof fabricWith>) => {
    const request = f.client.request.bind(f.client);
    (f.client as { request: typeof request }).request = (async (...args: Parameters<typeof request>) => {
      const out = await request(...args);
      const action = (args.find((a) => a && typeof a === 'object' && 'body' in (a as object)) as { body?: { action?: { type?: string; selector?: string } } } | undefined)?.body?.action;
      if (action?.type === 'click' && action.selector === '#accept') f.surface.splice(0, f.surface.length, go);
      return out;
    }) as typeof request;
  };

  it('learns the owner\'s cookie choice, and a replay interrupted by the banner continues without the model; a CAPTCHA hands over', async () => {
    const db = prisma.forUser({ userId: owner.userId });
    const t = await db.task.create({ data: { userId: owner.userId, name: 'Pens', goal: 'Search the shop for blue pens', confirmRiskyActions: false } });
    await prisma.kgTaskSettings.create({ data: { taskId: t.id, userId: owner.userId, mode: 'learn' } });
    const first = (await db.run.create({ data: { userId: owner.userId, taskId: t.id, goal: 'Search the shop for blue pens' } })).id;
    const learnFabric = fabricWith([accept, { ...go, visible: false }]);
    banneredPage(learnFabric);
    const learn = scriptedAi([[['navigate', { url: 'https://shop.example.test/pens', reason: 'open' }], ['click', { selector: '#accept', reason: 'cookies' }], ['click', { selector: '#go', reason: 'search' }], ['finish', { success: true, result: 'Found.' }]]]);
    expect(await runnerOf(learnFabric, learn.ai).advance(first, owner.userId, null)).toBe('succeeded');
    const site = await prisma.kgNode.findFirstOrThrow({ where: { userId: owner.userId, type: 'Site', key: 'example.test' } });
    expect((site.props as { consent?: { name?: string } }).consent?.name).toBe('Accept all');
    expect(await app.get(KgraphCompileService).compileRun(owner.userId, first)).toBe('compiled');
    // The compiled procedure clicks the banner choice as a step; drop that step so the banner is a true interrupt on replay.
    const store = app.get(PrismaProcedureStore);
    const proc = await store.findProcedureForTask(owner.userId, t.id);
    const [v] = await store.listVersions(owner.userId, proc!.id);
    const steps = v!.steps.filter((s) => !(s.kind === 'call' && (s.args as { selector?: { value?: string } }).selector?.value === '#accept'));
    await prisma.kgProcedureVersion.update({ where: { id: v!.id }, data: { state: 'retired' } });
    await store.putVersion(owner.userId, { ...v!, id: `${v!.id}-b`, number: 2, state: 'active', entry: steps[0]!.id, steps, edges: steps.slice(1).map((s, i) => ({ type: 'then' as const, from: steps[i]!.id, to: s.id })) });
    await prisma.kgTaskSettings.update({ where: { taskId: t.id }, data: { mode: 'reuse' } });

    const second = (await db.run.create({ data: { userId: owner.userId, taskId: t.id, goal: 'Search the shop for blue pens' } })).id;
    const f2 = fabricWith([accept, { ...go, visible: false }]);
    banneredPage(f2);
    const s2 = scriptedAi([]);
    expect(await runnerOf(f2, s2.ai).advance(second, owner.userId, null)).toBe('succeeded');
    expect(s2.runTools).not.toHaveBeenCalled();
    expect(f2.actions.filter((a) => a.type === 'click').map((a) => a.selector)).toEqual(['#accept', '#go']);

    const third = (await db.run.create({ data: { userId: owner.userId, taskId: t.id, goal: 'Search the shop for blue pens' } })).id;
    const f3 = fabricWith([accept, { ...go, visible: false }]);
    f3.snapshot.title = 'Security check';
    f3.snapshot.text = 'Please verify you are human';
    const s3 = scriptedAi([[['finish', { success: false, result: 'Blocked.' }]]]);
    await runnerOf(f3, s3.ai).advance(third, owner.userId, null);
    expect(f3.actions.filter((a) => a.type === 'click')).toHaveLength(0);
    expect(s3.runTools).toHaveBeenCalledTimes(1);
  });
});
