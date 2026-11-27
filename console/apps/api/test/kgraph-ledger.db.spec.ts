// E46.6 (#780) against a real database: the savings ledger. A `learn` run gets a kg_runs row, a `kgraph.ledger.write` job queued after its
// final transition and, from the job, one kg_ledger row copied from its own counters; an `off` run gets none of them. A failing ledger (the
// job, or the hook that queues it) never changes the run. The routes are the owner's: another user's task is a 404.
import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import type { AiService } from '@marinoscar/platform-api/ai';
import type { Job } from '@marinoscar/platform-api/jobs';

import { KgraphEnabledService } from '../src/kgraph/kgraph-enabled.service';
import { KGRAPH_LEDGER_JOB } from '../src/kgraph/ledger.enqueue';
import { LedgerWriteHandler } from '../src/kgraph/ledger.job';
import { LedgerService } from '../src/kgraph/ledger.service';
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
  await app?.close();
});

async function login(email: string, role: 'contributor' | 'admin' = 'contributor'): Promise<{ userId: string; token: string }> {
  const res = await app.inject({ method: 'POST', url: '/api/auth/test/login', payload: { email, role } });
  const token = new URL(String(res.headers.location)).searchParams.get('token')!;
  const me = await app.inject({ method: 'GET', url: '/api/auth/me', headers: { authorization: `Bearer ${token}` } });
  return { userId: me.json<{ data: { id: string } }>().data.id, token };
}
const patch = (token: string, url: string, payload: object) => app.inject({ method: 'PATCH', url: `/api${url}`, headers: { authorization: `Bearer ${token}` }, payload });
const get = (token: string, url: string) => app.inject({ method: 'GET', url: `/api${url}`, headers: { authorization: `Bearer ${token}` } });

type Call = [name: string, args: Record<string, unknown>];
type Tool = { tool: { name: string }; execute: (a: unknown, c: unknown) => Promise<unknown> };
type Req = { tools: Tool[]; onStep?: (s: unknown) => void };

function scriptedAi(scripts: Call[][]): AiService {
  const runTools = jest.fn(async (req: Req) => {
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
  return r;
}

const script = (): Call[][] => [
  [
    ['navigate', { url: 'https://shop.example.test/item', reason: 'open the shop' }],
    ['read_text', { selector: null }],
    ['finish', { success: true, result: 'Found them.' }],
  ],
];

async function runOnce(userId: string, taskId: string) {
  const run = await prisma.forUser({ userId }).run.create({ data: { userId, taskId, goal: 'Search the shop for blue pens' } });
  const fabric = fakeSecretsFabric('https://shop.example.test/start');
  const outcome = await runnerOf(fabric, scriptedAi(script())).advance(run.id, userId, null);
  const row = await prisma.run.findFirstOrThrow({ where: { id: run.id } });
  return { runId: run.id, outcome, row };
}

const ledgerJobs = (runId: string) => prisma.job.findMany({ where: { type: KGRAPH_LEDGER_JOB, subjectId: runId } });

describe('the savings ledger (#780)', () => {
  let owner: { userId: string; token: string };
  let other: { userId: string; token: string };
  let admin: { token: string };
  beforeAll(async () => {
    admin = await login(`kgled-admin-${stamp}@example.test`, 'admin');
    owner = await login(`kgled-owner-${stamp}@example.test`);
    other = await login(`kgled-other-${stamp}@example.test`);
    await patch(admin.token, '/system-settings', { kgraph: { enabled: true } });
    await patch(owner.token, '/user-settings', { kgraph: { enabled: true } });
  });
  afterAll(async () => {
    await patch(admin.token, '/system-settings', { kgraph: { enabled: false } });
  });

  const newTask = async (mode: 'off' | 'learn') => {
    const task = await prisma.forUser({ userId: owner.userId }).task.create({ data: { userId: owner.userId, name: `Pens ${mode} ${stamp}`, goal: 'Search the shop for blue pens', confirmRiskyActions: false } });
    // AI only is stored explicitly: a task with no setting learns by default (#1031).
    await prisma.kgTaskSettings.create({ data: { taskId: task.id, userId: owner.userId, mode } });
    return task.id;
  };
  const processJob = async (runId: string) => {
    const [job] = await ledgerJobs(runId);
    await app.get(LedgerWriteHandler).process({ id: job!.id, payload: job!.payload } as unknown as Job);
  };

  it('writes a ledger row for a learn run, and none for an off run', async () => {
    const offTask = await newTask('off');
    const off = await runOnce(owner.userId, offTask);
    expect(off.row.status).toBe('succeeded');
    expect(await prisma.kgRun.count({ where: { runId: off.runId } })).toBe(0);
    expect(await ledgerJobs(off.runId)).toHaveLength(0);
    expect(await app.get(LedgerService).write(owner.userId, off.runId)).toBe('skipped');
    expect(await prisma.kgLedger.count({ where: { runId: off.runId } })).toBe(0);

    const learnTask = await newTask('learn');
    const learn = await runOnce(owner.userId, learnTask);
    expect(learn.row.status).toBe('succeeded');
    expect(await prisma.kgRun.findFirst({ where: { runId: learn.runId } })).toMatchObject({ mode: 'learn', userId: owner.userId });
    expect(await ledgerJobs(learn.runId)).toHaveLength(1);
    await processJob(learn.runId);
    const row = await prisma.kgLedger.findFirstOrThrow({ where: { runId: learn.runId } });
    expect(row).toMatchObject({ userId: owner.userId, taskId: learnTask, mode: 'learn', procedureVersionId: null, runStatus: 'succeeded', outcome: 'ai_only', checksPassed: null });
    expect(row.modelCalls).toBe(learn.row.modelCalls);
    expect(row.inputTokens).toBe(learn.row.inputTokens);
    expect(row.stepsAgent).toBe(learn.row.stepCount);
    expect(row.activeMs).toBe(learn.row.activeMs);
    expect(Number(row.costUsd)).toBe(Number(learn.row.costUsd));
    // Safe to repeat: still one row.
    await processJob(learn.runId);
    expect(await prisma.kgLedger.count({ where: { runId: learn.runId } })).toBe(1);

    // The routes: the learn run is the baseline now (an AI-only run), and no saving is shown (nothing executed a procedure).
    const ledger = await get(owner.token, `/kgraph/ledger?taskId=${learnTask}`);
    expect(ledger.statusCode).toBe(200);
    const body = ledger.json<{ data: { rows: { runId: string; outcome: string }[]; baseline: { runs: number } | null } }>().data;
    expect(body.rows.map((r) => [r.runId, r.outcome])).toEqual([[learn.runId, 'ai_only']]);
    expect(body.baseline?.runs).toBeGreaterThanOrEqual(1);
    const summary = await get(owner.token, '/kgraph/summary');
    expect(summary.statusCode).toBe(200);
    const mine = summary.json<{ data: { tasks: { taskId: string; saving: unknown; procedureRuns: number }[] } }>().data.tasks.find((t) => t.taskId === learnTask);
    expect(mine).toMatchObject({ procedureRuns: 0, saving: null });
    // Another user's task is a 404, like a missing one; a bad query is a 400.
    expect((await get(other.token, `/kgraph/ledger?taskId=${learnTask}`)).statusCode).toBe(404);
    expect((await get(owner.token, '/kgraph/ledger?taskId=nope')).statusCode).toBe(400);
    expect(summary.json<{ data: { tasks: { taskId: string }[] } }>().data.tasks.every((t) => t.taskId !== offTask)).toBe(true);
    expect((await get(other.token, '/kgraph/summary')).json<{ data: { tasks: unknown[] } }>().data.tasks).toEqual([]);
  });

  it('a summary with no baseline says "no baseline yet" and shows no saving', async () => {
    const taskId = await newTask('learn');
    const run = await prisma.forUser({ userId: owner.userId }).run.create({ data: { userId: owner.userId, taskId, goal: 'g', status: 'failed', finishedAt: new Date(), modelCalls: 3 } });
    await prisma.kgRun.create({ data: { runId: run.id, userId: owner.userId, mode: 'reuse', procedureVersionId: 'pv-1' } });
    expect(await app.get(LedgerService).write(owner.userId, run.id)).toBe('written');
    const t = (await get(owner.token, '/kgraph/summary')).json<{ data: { tasks: { taskId: string; baseline: unknown; note: string | null; saving: unknown; procedureRuns: number }[] } }>().data.tasks.find((x) => x.taskId === taskId);
    expect(t).toMatchObject({ baseline: null, note: 'no baseline yet', saving: null, procedureRuns: 1 });
  });

  it('a thrown ledger error leaves the run status unchanged', async () => {
    const ledger = app.get(LedgerService);
    // The ledger job fails (here and in the app's own worker, which may claim it first): the run is untouched.
    const taskId = await newTask('learn');
    const spy = jest.spyOn(ledger, 'write').mockRejectedValue(new Error('db down'));
    let done: Awaited<ReturnType<typeof runOnce>>;
    try {
      done = await runOnce(owner.userId, taskId);
      await expect(processJob(done.runId)).rejects.toThrow('db down');
    } finally {
      spy.mockRestore();
    }
    expect(done.row.status).toBe('succeeded');
    const after = await prisma.run.findFirstOrThrow({ where: { id: done.runId } });
    expect({ status: after.status, result: after.result, error: after.error, finishedAt: after.finishedAt, stopReason: after.stopReason }).toEqual({ status: done.row.status, result: done.row.result, error: done.row.error, finishedAt: done.row.finishedAt, stopReason: done.row.stopReason });
    expect(await prisma.kgLedger.count({ where: { runId: done.runId } })).toBe(0);

    // The hook that queues the job fails: the run still ends as it would.
    const hookSpy = jest.spyOn(ledger, 'onRunEnd').mockRejectedValue(new Error('queue down'));
    try {
      const again = await runOnce(owner.userId, taskId);
      expect(again.outcome).toBe(done.outcome);
      expect(again.row.status).toBe('succeeded');
    } finally {
      hookSpy.mockRestore();
    }
  });
});
