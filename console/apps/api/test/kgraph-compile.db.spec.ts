// E46.7 (#781) against a real database: a captured, succeeded learn-mode run enqueues `kgraph.compile`, and the job stores a candidate
// version; a failed run enqueues nothing and compiles nothing; compiling twice is idempotent.
import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import type { AiService } from '@marinoscar/platform-api/ai';

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
  const runTools = jest.fn(async (req: { tools: Tool[]; onStep?: (s: unknown) => void }) => {
    let step = 0;
    for (const [name, args] of scripts.shift() ?? []) {
      const t = req.tools.find((x) => x.tool.name === name);
      if (t) await t.execute(args, { userId: 'u' });
      req.onStep?.({ step: ++step, response: { usage: { inputTokens: 10, outputTokens: 5 } }, calls: [] });
    }
    return { final: { outputText: '' }, steps: [], stopReason: 'steps_exhausted' };
  });
  return { forUser: () => ({ runTools }) } as unknown as AiService;
}
const notifier = { finished: jest.fn(), needsYou: jest.fn(), started: jest.fn(), savedLoginUsed: jest.fn(), savedApprovalsUsed: jest.fn(), overBudget: jest.fn() };
function runnerOf(fabric: SecretsFabric, ai: AiService) {
  const questions = new QuestionsService(prisma, fabric.client, { enqueue: async () => undefined } as never, new QuestionEvents());
  const r = new GoalRunnerService(prisma, app.get(TasksService), fabric.client, ai, notifier as never, questions);
  r.kgraph = app.get(KgraphEnabledService);
  r.kgraphAfterRun = app.get(KgraphAfterRun);
  return r;
}

describe('the Knowledge Graph compiler job (#781)', () => {
  let owner: { userId: string; token: string };
  let admin: { token: string };
  beforeAll(async () => {
    admin = await login(`kgcomp-admin-${stamp}@example.test`, 'admin');
    owner = await login(`kgcomp-owner-${stamp}@example.test`);
    await patch(admin.token, '/system-settings', { kgraph: { enabled: true, pacing: 'fast' } });
    await patch(owner.token, '/user-settings', { kgraph: { enabled: true } });
  });
  afterAll(async () => {
    await patch(admin.token, '/system-settings', { kgraph: { enabled: false } });
  });

  async function learnRun(script: Call[][]) {
    const task = await prisma.forUser({ userId: owner.userId }).task.create({ data: { userId: owner.userId, name: 'Pens', goal: 'Search the shop for blue pens', confirmRiskyActions: false } });
    await prisma.kgTaskSettings.create({ data: { taskId: task.id, userId: owner.userId, mode: 'learn' } });
    const run = await prisma.forUser({ userId: owner.userId }).run.create({ data: { userId: owner.userId, taskId: task.id, goal: 'Search the shop for blue pens' } });
    const fabric = fakeSecretsFabric('https://shop.example.test/start');
    fabric.page.inputs = [{ selector: '#q', tag: 'input' }, { selector: '#go', tag: 'button' }];
    await runnerOf(fabric, scriptedAi(script)).advance(run.id, owner.userId, null);
    return { taskId: task.id, runId: run.id };
  }
  const jobsFor = (runId: string) => prisma.job.count({ where: { type: 'kgraph.compile', subjectId: runId } });

  it('a succeeded learn run enqueues the job, which stores one candidate, once', async () => {
    const { taskId, runId } = await learnRun([[['navigate', { url: 'https://shop.example.test/pens', reason: 'open' }], ['type_text', { selector: '#q', text: 'blue pens', submit: false }], ['click', { selector: '#go', reason: 'search' }], ['finish', { success: true, result: 'Found.' }]]]);
    expect((await prisma.run.findUniqueOrThrow({ where: { id: runId } })).status).toBe('succeeded');
    expect(await jobsFor(runId)).toBe(1);
    const compiler = app.get(KgraphCompileService);
    expect(await compiler.compileRun(owner.userId, runId)).toBe('compiled');
    expect(await compiler.compileRun(owner.userId, runId)).toBe('skipped_done');
    const store = app.get(PrismaProcedureStore);
    const proc = await store.findProcedureForTask(owner.userId, taskId);
    const [v] = await store.listVersions(owner.userId, proc!.id);
    expect(v!.state).toBe('candidate');
    expect(v!.sourceRun).toBe(runId);
    expect(v!.steps.filter((s) => s.kind === 'call').map((s) => (s as { tool: string }).tool)).toEqual(['navigate', 'type_text', 'click']);
    // Another user cannot compile it or read it.
    const other = await login(`kgcomp-other-${stamp}@example.test`);
    expect(await compiler.compileRun(other.userId, runId)).toBe('skipped_not_clean');
    expect(await store.getVersion(other.userId, v!.id)).toBeNull();
  });

  it('a failed run enqueues nothing and compiles nothing', async () => {
    // A failed finish escalates once first (E49.4, #961); the second ends the run.
    const { runId } = await learnRun([[['navigate', { url: 'https://shop.example.test/pens', reason: 'open' }], ['finish', { success: false, result: 'Could not.' }]], [['finish', { success: false, result: 'Could not.' }]]]);
    expect((await prisma.run.findUniqueOrThrow({ where: { id: runId } })).status).toBe('failed');
    expect(await jobsFor(runId)).toBe(0);
    expect(await app.get(KgraphCompileService).compileRun(owner.userId, runId)).toBe('skipped_not_clean');
  });
});
