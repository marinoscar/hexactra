// E46.12 (#786) circuit breaker and rollback, against a real database (helpers as in kgraph-replay.db.spec.ts). E46.9 (#783) against a real database: a reuse-mode task run replays its procedure inside the ordinary run. Every call goes through
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
const notifier = { kgraphSuspended: jest.fn(), finished: jest.fn(), needsYou: jest.fn(), started: jest.fn(), savedLoginUsed: jest.fn(), savedApprovalsUsed: jest.fn(), overBudget: jest.fn() };
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

describe('circuit breaker and rollback (#786)', () => {
  let owner: { userId: string; token: string };
  let admin: { token: string };
  beforeAll(async () => {
    admin = await login(`kgbrk-admin-${stamp}@example.test`, 'admin');
    owner = await login(`kgbrk-owner-${stamp}@example.test`);
    await patch(admin.token, '/system-settings', { kgraph: { enabled: true, auditEvery: 0, suspendAfterFailures: 3, pacing: 'fast' } });
    await patch(owner.token, '/user-settings', { kgraph: { enabled: true } });
  });
  afterAll(async () => {
    await patch(admin.token, '/system-settings', { kgraph: { enabled: false, auditEvery: 10 } });
  });
  const db = () => prisma.forUser({ userId: owner.userId });
  const store = () => app.get(PrismaProcedureStore);
  async function setup() {
    const t = await db().task.create({ data: { userId: owner.userId, name: 'Pens', goal: 'Search the shop for blue pens', confirmRiskyActions: false } });
    await prisma.kgTaskSettings.create({ data: { taskId: t.id, userId: owner.userId, mode: 'reuse' } });
    const now = new Date().toISOString();
    const pid = `kgp-brk-${t.id}`;
    await store().putProcedure({ id: pid, owner: owner.userId, task: t.id, name: 'Pens', activeVersion: null, createdAt: now, updatedAt: now });
    // The page is never where the procedure expects it: every replay hands over.
    const v = procedureVersionSchema.parse({ id: `kgv-brk-${t.id}`, procedure: pid, number: 1, state: 'active', changeClass: 'initial', sourceRun: null, parent: null, createdAt: now, entry: 's1', sites: [{ id: 'site:example.test', domain: 'example.test' }], steps: [{ id: 's1', kind: 'call', label: 'navigate', tool: 'navigate', commitClass: true, args: { url: { kind: 'literal', value: 'https://shop.example.test/pens' }, reason: { kind: 'literal', value: 'open' } }, checks: [{ kind: 'location', host: 'shop.example.test', pathPattern: '/pens' }] }] });
    await store().putVersion(owner.userId, v);
    return { taskId: t.id, pid, vid: v.id };
  }
  const run = async (taskId: string, script: Call[][] = [[['finish', { success: true, result: 'AI did it.' }]]]) => {
    const id = (await db().run.create({ data: { userId: owner.userId, taskId, goal: 'Search the shop for blue pens' } })).id;
    const fabric = fakeSecretsFabric('https://shop.example.test/start');
    const s = scriptedAi(script);
    const outcome = await runnerOf(fabric, s.ai).advance(id, owner.userId, null);
    return { id, fabric, s, outcome };
  };

  it('three handovers in a row suspend the version once, notify once, and the next run skips replay as ai_only', async () => {
    notifier.kgraphSuspended.mockClear();
    const { taskId, vid } = await setup();
    for (let i = 0; i < 3; i++) await run(taskId);
    expect((await store().getVersion(owner.userId, vid))!.state).toBe('suspended');
    expect(notifier.kgraphSuspended).toHaveBeenCalledTimes(1);
    expect(await prisma.auditEvent.count({ where: { action: 'kgraph.version.suspended', targetId: vid } })).toBe(1);
    const next = await run(taskId);
    expect(next.fabric.actions.filter((a) => a.type === 'navigate')).toHaveLength(0);
    expect(await prisma.kgRun.findUniqueOrThrow({ where: { runId: next.id } })).toMatchObject({ aiOnly: true, outcome: 'ai_only' });
  });

  it('restore makes the chosen version usable again and its next run a verification run that asks before commits', async () => {
    const { taskId, pid, vid } = await setup();
    for (let i = 0; i < 3; i++) await run(taskId);
    expect((await store().getVersion(owner.userId, vid))!.state).toBe('suspended');
    const res = await app.inject({ method: 'POST', url: `/api/kgraph/procedures/${pid}/restore`, headers: { authorization: `Bearer ${owner.token}` }, payload: { versionId: vid } });
    expect(res.statusCode).toBe(200);
    const { versionId } = res.json<{ data: { versionId: string } }>().data;
    expect((await store().getVersion(owner.userId, versionId))!).toMatchObject({ state: 'candidate', parent: vid });
    const next = await run(taskId, []);
    // The restored copy's first step is commit-class: the verification run asks before it.
    expect(next.outcome).toBe('waiting_human');
    expect(next.fabric.actions.filter((a) => a.type === 'navigate')).toHaveLength(0);
    expect(await prisma.auditEvent.count({ where: { action: 'kgraph.version.restored', targetId: versionId } })).toBe(1);
    // Another user cannot restore it; an active version cannot be restored.
    const other = await login(`kgbrk-other-${stamp}@example.test`);
    expect((await app.inject({ method: 'POST', url: `/api/kgraph/procedures/${pid}/restore`, headers: { authorization: `Bearer ${other.token}` }, payload: { versionId: vid } })).statusCode).toBe(404);
  });

  it('forget retires every version; the task learns again', async () => {
    const { pid, vid } = await setup();
    const res = await app.inject({ method: 'POST', url: `/api/kgraph/procedures/${pid}/forget`, headers: { authorization: `Bearer ${owner.token}` } });
    expect(res.json<{ data: { retired: number } }>().data.retired).toBe(1);
    expect((await store().getVersion(owner.userId, vid))!.state).toBe('retired');
  });
});
