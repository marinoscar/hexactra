// E46.17 (#791) repair and promotion against a real database (helpers as in kgraph-replay.db.spec.ts). E46.9 (#783) against a real database: a reuse-mode task run replays its procedure inside the ordinary run. Every call goes through
// executeTool (each one reaches the observer the wrapper calls), no model call for call steps, ordinary step rows; a mismatch hands over to
// the loop with one note; Stop before a step ends it; the site gate refuses a replayed navigate outside the allowed sites; a commit step
// whose intent was left open is never sent again; with the mode off nothing of this is entered.
import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import type { AiService } from '@marinoscar/platform-api/ai';
import { procedureVersionSchema, type ProcedureVersionInput } from '@marinoscar/hexactra-kgraph';

import { KgraphAfterRun } from '../src/kgraph/kgraph-compile.job';
import { KgraphCompileService } from '../src/kgraph/kgraph-compile.service';
import { KgraphReviewsService } from '../src/kgraph/reviews.service';
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

describe('repair and promotion (#791)', () => {
  let owner: { userId: string; token: string };
  let admin: { token: string };
  beforeAll(async () => {
    admin = await login(`kgrpr-admin-${stamp}@example.test`, 'admin');
    owner = await login(`kgrpr-owner-${stamp}@example.test`);
    await patch(admin.token, '/system-settings', { kgraph: { enabled: true, auditEvery: 0, pacing: 'fast' } });
    await patch(owner.token, '/user-settings', { kgraph: { enabled: true } });
  });
  afterAll(async () => {
    await patch(admin.token, '/system-settings', { kgraph: { enabled: false, auditEvery: 10 } });
  });
  const db = () => prisma.forUser({ userId: owner.userId });
  const store = () => app.get(PrismaProcedureStore);
  async function activeTask(steps: ProcedureVersionInput['steps'], elements: ProcedureVersionInput['elements'] = []) {
    const t = await db().task.create({ data: { userId: owner.userId, name: 'Pens', goal: 'Search the shop for blue pens', confirmRiskyActions: false } });
    await prisma.kgTaskSettings.create({ data: { taskId: t.id, userId: owner.userId, mode: 'reuse' } });
    const now = new Date().toISOString();
    const pid = `kgp-rpr-${t.id}`;
    await store().putProcedure({ id: pid, owner: owner.userId, task: t.id, name: 'Pens', activeVersion: null, createdAt: now, updatedAt: now });
    const v = procedureVersionSchema.parse({ id: `kgv-rpr-${t.id}`, procedure: pid, number: 1, state: 'active', changeClass: 'initial', sourceRun: null, parent: null, createdAt: now, entry: steps[0]!.id, steps, edges: steps.slice(1).map((s, i) => ({ type: 'then', from: steps[i]!.id, to: s.id })), sites: [{ id: 'site:example.test', domain: 'example.test' }], screens: elements!.length ? [{ id: 'sc:1', site: 'site:example.test', label: 'shop' }] : [], elements });
    await store().putVersion(owner.userId, v);
    return { taskId: t.id, pid, vid: v.id };
  }
  const nav = { id: 's1', kind: 'call', label: 'navigate', tool: 'navigate', args: { url: { kind: 'literal', value: 'https://shop.example.test/pens' }, reason: { kind: 'literal', value: 'open' } }, sites: ['site:example.test'] } as ProcedureVersionInput['steps'][number];

  it('a relocated, relabelled button: the agent repairs it, the repair is structural, verifies on the next run and becomes active with no owner action', async () => {
    const click = { id: 's2', kind: 'call', label: 'click', tool: 'click', element: 'el:1', args: { selector: { kind: 'literal', value: '#go' }, reason: { kind: 'literal', value: 'search' } } } as ProcedureVersionInput['steps'][number];
    const { taskId, pid, vid } = await activeTask([nav, click], [{ id: 'el:1', screen: 'sc:1', role: 'button', label: 'Search', selectors: ['#go'] }]);
    const find = { selector: '#find', selectors: ['#find'], role: 'button', name: 'Find pens', tag: 'button', inputType: null, anchor: null };
    const runA = (await db().run.create({ data: { userId: owner.userId, taskId, goal: 'Search the shop for blue pens' } })).id;
    const fA = fakeSecretsFabric('https://shop.example.test/start');
    fA.surface.push(find);
    // The replay cannot find "Search" (rung 4 asks once, the model names nothing); the agent clicks the new button and finishes.
    const sA = scriptedAi([[], [['click', { selector: '#find', reason: 'search' }], ['finish', { success: true, result: 'Found.' }]]]);
    expect(await runnerOf(fA, sA.ai).advance(runA, owner.userId, null)).toBe('succeeded');
    expect(await app.get(KgraphCompileService).compileRun(owner.userId, runA)).toBe('repaired_structural');
    const [repair] = await store().listVersions(owner.userId, pid);
    expect(repair).toMatchObject({ state: 'candidate', changeClass: 'structural', parent: vid });
    const runB = (await db().run.create({ data: { userId: owner.userId, taskId, goal: 'Search the shop for blue pens' } })).id;
    const fB = fakeSecretsFabric('https://shop.example.test/start');
    fB.surface.push(find);
    const sB = scriptedAi([]);
    expect(await runnerOf(fB, sB.ai).advance(runB, owner.userId, null)).toBe('succeeded');
    expect(sB.runTools).not.toHaveBeenCalled();
    expect((await store().getVersion(owner.userId, repair!.id))!.state).toBe('active');
    expect((await store().getVersion(owner.userId, vid))!.state).toBe('retired');
    expect(await prisma.kgReview.count({ where: { userId: owner.userId, versionId: repair!.id } })).toBe(0);
  });

  it('a repair that adds a site is sensitive: a review, never active unapproved; declined, it retires and is not proposed again', async () => {
    const { taskId, pid, vid } = await activeTask([nav]);
    const repairRun = async () => {
      const id = (await db().run.create({ data: { userId: owner.userId, taskId, goal: 'Search the shop for blue pens', status: 'succeeded' } })).id;
      await prisma.kgRun.create({ data: { runId: id, userId: owner.userId, mode: 'reuse', procedureVersionId: vid, outcome: 'fell_back' } });
      // What the server recorded: the replayed navigate, then the agent opened a site the procedure never used.
      await prisma.kgTrace.createMany({ data: [
        { userId: owner.userId, runId: id, seq: 1, tool: 'navigate', family: 'browser', ok: true, outcome: 'ran', bindings: { url: { kind: 'literal', value: 'https://shop.example.test/pens' } }, post: {} },
        { userId: owner.userId, runId: id, seq: 2, tool: 'navigate', family: 'browser', ok: true, outcome: 'ran', bindings: { url: { kind: 'literal', value: 'https://pay.attacker.example.net/collect' } }, post: {} },
      ] });
      return id;
    };
    const compiler = app.get(KgraphCompileService);
    expect(await compiler.compileRun(owner.userId, await repairRun())).toBe('repaired_sensitive');
    const [proposed] = await store().listVersions(owner.userId, pid);
    expect(proposed).toMatchObject({ state: 'candidate', changeClass: 'sensitive' });
    const reviews = app.get(KgraphReviewsService);
    const [review] = await reviews.list(owner.userId, 'pending');
    expect(review!.changes).toEqual([expect.objectContaining({ reason: 'new_site', text: 'adds the site example.net' })]);
    // Not chosen while pending: the next run replays the old version.
    const next = (await db().run.create({ data: { userId: owner.userId, taskId, goal: 'Search the shop for blue pens' } })).id;
    const f = fakeSecretsFabric('https://shop.example.test/start');
    await runnerOf(f, scriptedAi([]).ai).advance(next, owner.userId, null);
    expect(f.actions.filter((a) => a.type === 'navigate').map((a) => a.url)).toEqual(['https://shop.example.test/pens']);
    // Only a browser session answers it; a declined change retires and is not proposed again within 30 days.
    const res = await app.inject({ method: 'POST', url: `/api/kgraph/reviews/${review!.id}/answer`, headers: { authorization: `Bearer ${owner.token}` }, payload: { approve: false } });
    expect(res.statusCode).toBe(200);
    expect((await store().getVersion(owner.userId, proposed!.id))!.state).toBe('retired');
    expect(await compiler.compileRun(owner.userId, await repairRun())).toBe('repair_suppressed');
  });
});
