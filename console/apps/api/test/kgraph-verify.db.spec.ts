// (helpers copied from kgraph-replay.db.spec.ts) E46.9 (#783) against a real database: a reuse-mode task run replays its procedure inside the ordinary run. Every call goes through
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

describe('verified admission and learn-only (#784)', () => {
  let owner: { userId: string; token: string };
  let admin: { token: string };
  beforeAll(async () => {
    admin = await login(`kgver-admin-${stamp}@example.test`, 'admin');
    owner = await login(`kgver-owner-${stamp}@example.test`);
    await patch(admin.token, '/system-settings', { kgraph: { enabled: true } });
    await patch(owner.token, '/user-settings', { kgraph: { enabled: true } });
  });
  afterAll(async () => {
    await patch(admin.token, '/system-settings', { kgraph: { enabled: false } });
  });
  const db = () => prisma.forUser({ userId: owner.userId });
  async function task(mode: 'learn' | 'reuse') {
    const t = await db().task.create({ data: { userId: owner.userId, name: `Pens ${mode}`, goal: 'Search the shop for blue pens', confirmRiskyActions: false } });
    await prisma.kgTaskSettings.create({ data: { taskId: t.id, userId: owner.userId, mode } });
    return t.id;
  }
  async function candidate(taskId: string, steps: ProcedureVersionInput['steps']) {
    const store = app.get(PrismaProcedureStore);
    const now = new Date().toISOString();
    const pid = `kgp-ver-${taskId}`;
    await store.putProcedure({ id: pid, owner: owner.userId, task: taskId, name: 'Pens', activeVersion: null, createdAt: now, updatedAt: now });
    const v = procedureVersionSchema.parse({ id: `kgv-ver-${taskId}`, procedure: pid, number: 1, state: 'candidate', changeClass: 'initial', sourceRun: null, parent: null, createdAt: now, entry: steps[0]!.id, steps, edges: steps.slice(1).map((s, i) => ({ type: 'then', from: steps[i]!.id, to: s.id })), sites: [{ id: 'site:example.test', domain: 'example.test' }] });
    await store.putVersion(owner.userId, v);
    return v;
  }
  const newRun = async (taskId: string) => (await db().run.create({ data: { userId: owner.userId, taskId, goal: 'Search the shop for blue pens' } })).id;
  const fabricAt = () => {
    const f = fakeSecretsFabric('https://shop.example.test/start');
    f.page.inputs = [{ selector: '#q', tag: 'input' }, { selector: '#go', tag: 'button' }];
    return f;
  };
  const nav = { id: 's1', kind: 'call', label: 'navigate', tool: 'navigate', args: { url: { kind: 'literal', value: 'https://shop.example.test/pens' }, reason: { kind: 'literal', value: 'open' } }, sites: ['site:example.test'] } satisfies ProcedureVersionInput['steps'][number];
  const go = { id: 's2', kind: 'call', label: 'search', tool: 'click', commitClass: true, args: { selector: { kind: 'literal', value: '#go' }, reason: { kind: 'literal', value: 'search' } } } satisfies ProcedureVersionInput['steps'][number];
  const states = async (taskId: string) => (await app.get(PrismaProcedureStore).listVersions(owner.userId, `kgp-ver-${taskId}`)).map((v) => v.state);

  it('a candidate is never executed for a task in learn mode', async () => {
    const taskId = await task('learn');
    await candidate(taskId, [nav]);
    const fabric = fabricAt();
    const s = scriptedAi([[['finish', { success: true, result: 'AI only.' }]]]);
    await runnerOf(fabric, s.ai).advance(await newRun(taskId), owner.userId, null);
    expect(s.runTools).toHaveBeenCalledTimes(1);
    expect(fabric.actions.filter((a) => a.type === 'navigate')).toHaveLength(0);
    expect(await states(taskId)).toEqual(['candidate']);
  });

  it('a verification run asks before a commit-class step even with confirmation off; approved, it finishes and leaves exactly one active version', async () => {
    const taskId = await task('reuse');
    await candidate(taskId, [nav, go]);
    const runId = await newRun(taskId);
    const fabric = fabricAt();
    const s = scriptedAi([]);
    expect(await runnerOf(fabric, s.ai).advance(runId, owner.userId, null)).toBe('waiting_human');
    expect(fabric.actions.filter((a) => a.type === 'click')).toHaveLength(0);
    expect(fabric.actions.filter((a) => a.type === 'navigate')).toHaveLength(1);
    const h = [...fabric.handoffs.values()][0]!;
    expect(await prisma.question.count({ where: { runId, input: 'confirm' } })).toBe(1);
    fabric.answer(h, { value: 'approve' });
    expect(await runnerOf(fabric, s.ai).advance(runId, owner.userId, null)).toBe('succeeded');
    expect(s.runTools).not.toHaveBeenCalled();
    expect(fabric.actions.filter((a) => a.type === 'click')).toHaveLength(1);
    expect(fabric.actions.filter((a) => a.type === 'navigate')).toHaveLength(1);
    expect(await states(taskId)).toEqual(['active']);
    expect((await app.get(PrismaProcedureStore).getProcedure(owner.userId, `kgp-ver-${taskId}`))?.activeVersion).toBe(`kgv-ver-${taskId}`);
    expect(await prisma.auditEvent.count({ where: { actorUserId: owner.userId, action: 'kgraph.version.verified', targetId: `kgv-ver-${taskId}` } })).toBe(1);
  });

  it('declined: nothing is sent, the agent takes over and the candidate retires', async () => {
    const taskId = await task('reuse');
    await candidate(taskId, [nav, go]);
    const runId = await newRun(taskId);
    const fabric = fabricAt();
    await runnerOf(fabric, scriptedAi([]).ai).advance(runId, owner.userId, null);
    fabric.answer([...fabric.handoffs.values()][0]!, { value: 'deny' });
    const s = scriptedAi([[['finish', { success: true, result: 'The agent did it.' }]]]);
    expect(await runnerOf(fabric, s.ai).advance(runId, owner.userId, null)).toBe('succeeded');
    expect(fabric.actions.filter((a) => a.type === 'click')).toHaveLength(0);
    expect(await states(taskId)).toEqual(['retired']);
  });

  it('a handover leaves no active version, and the run the agent finished compiles a new candidate', async () => {
    const taskId = await task('reuse');
    await candidate(taskId, [{ ...nav, checks: [{ kind: 'location', host: 'shop.example.test', pathPattern: '/pens' }] }]);
    const runId = await newRun(taskId);
    const s = scriptedAi([[['navigate', { url: 'https://shop.example.test/pens', reason: 'again' }], ['finish', { success: true, result: 'Found.' }]]]);
    expect(await runnerOf(fabricAt(), s.ai).advance(runId, owner.userId, null)).toBe('succeeded');
    expect(await states(taskId)).toEqual(['retired']);
    expect(await app.get(KgraphCompileService).compileRun(owner.userId, runId)).toBe('compiled');
    const all = await app.get(PrismaProcedureStore).listVersions(owner.userId, `kgp-ver-${taskId}`);
    expect(all.map((v) => v.state)).toEqual(['candidate', 'retired']);
    expect(all.some((v) => v.state === 'active')).toBe(false);
  });
});
