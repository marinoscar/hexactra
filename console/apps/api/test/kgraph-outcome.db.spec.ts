// E46.11 (#785) outcome checks and audit runs, against a real database (helpers as in kgraph-replay.db.spec.ts). E46.9 (#783) against a real database: a reuse-mode task run replays its procedure inside the ordinary run. Every call goes through
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

describe('outcome checks and audit runs (#785)', () => {
  let owner: { userId: string; token: string };
  let admin: { token: string };
  beforeAll(async () => {
    admin = await login(`kgout-admin-${stamp}@example.test`, 'admin');
    owner = await login(`kgout-owner-${stamp}@example.test`);
    await patch(admin.token, '/system-settings', { kgraph: { enabled: true, auditEvery: 0, pacing: 'fast' } });
    await patch(owner.token, '/user-settings', { kgraph: { enabled: true } });
  });
  afterAll(async () => {
    await patch(admin.token, '/system-settings', { kgraph: { enabled: false, auditEvery: 10 } });
  });
  const db = () => prisma.forUser({ userId: owner.userId });
  const SPEC = [{ key: 'total', label: 'Total', type: 'money', required: true }];
  async function reuseTask() {
    const t = await db().task.create({ data: { userId: owner.userId, name: 'Total', goal: 'Read the total', confirmRiskyActions: false, outputs: SPEC as never } });
    await prisma.kgTaskSettings.create({ data: { taskId: t.id, userId: owner.userId, mode: 'reuse' } });
    const store = app.get(PrismaProcedureStore);
    const now = new Date().toISOString();
    await store.putProcedure({ id: `kgp-out-${t.id}`, owner: owner.userId, task: t.id, name: 'Total', activeVersion: null, createdAt: now, updatedAt: now });
    const v = procedureVersionSchema.parse({ id: `kgv-out-${t.id}`, procedure: `kgp-out-${t.id}`, number: 1, state: 'active', changeClass: 'initial', sourceRun: null, parent: null, createdAt: now, entry: 's1', steps: [{ id: 's1', kind: 'call', label: 'read', tool: 'read_text', args: { selector: { kind: 'literal', value: '#total' } } }], outputs: [{ id: 'o:total', name: 'total', step: 's1' }] });
    await store.putVersion(owner.userId, v);
    return { taskId: t.id, versionId: v.id };
  }
  const newRun = async (taskId: string) => (await db().run.create({ data: { userId: owner.userId, taskId, goal: 'Read the total', outputsSpec: SPEC as never } })).id;
  const fabric = (total: string | null) => {
    const f = fakeSecretsFabric('https://shop.example.test/start');
    f.page.inputs = [{ selector: '#total', tag: 'input' }];
    if (total !== null) f.page.fields['#total'] = total;
    return f;
  };

  it('a replay whose required output is empty hands over to the agent instead of succeeding', async () => {
    const { taskId, versionId } = await reuseTask();
    const runId = await newRun(taskId);
    const s = scriptedAi([[['finish', { success: false, result: 'No total.' }]]]);
    await runnerOf(fabric(null), s.ai).advance(runId, owner.userId, null);
    expect(s.runTools).toHaveBeenCalledTimes(1);
    expect(JSON.stringify(s.inputs[0])).toContain('The saved procedure finished but its result did not pass its checks: total is missing');
    expect((await prisma.run.findUniqueOrThrow({ where: { id: runId } })).result).not.toBe('Done by the saved procedure.');
    expect((await app.get(PrismaProcedureStore).getVersion(owner.userId, versionId))!.evidence.failures).toBe(1);
  });

  it('a clean replay succeeds with its output and learns its shape: statistics, no value', async () => {
    const { taskId, versionId } = await reuseTask();
    const runId = await newRun(taskId);
    expect(await runnerOf(fabric('4,512.07'), scriptedAi([]).ai).advance(runId, owner.userId, null)).toBe('succeeded');
    const shape = await prisma.kgNode.findFirstOrThrow({ where: { userId: owner.userId, type: 'OutputShape', key: `${versionId}:total` } });
    expect(shape.props).toEqual({ kind: 'number', minMagnitude: 3, maxMagnitude: 3, samples: 1 });
    expect(JSON.stringify(shape)).not.toContain('4,512');
  });

  it('with auditEvery 3, runs 3, 6 and 9 of the task are AI only', async () => {
    await patch(admin.token, '/system-settings', { kgraph: { auditEvery: 3 } });
    const { taskId } = await reuseTask();
    const aiOnly: boolean[] = [];
    for (let i = 0; i < 9; i++) {
      const runId = await newRun(taskId);
      await runnerOf(fabric('4,512.07'), scriptedAi([[['finish', { success: true, result: 'AI did it.' }]]]).ai).advance(runId, owner.userId, null);
      aiOnly.push((await prisma.kgRun.findUnique({ where: { runId } }))?.aiOnly === true);
    }
    expect(aiOnly.map((x, i) => (x ? i + 1 : 0)).filter(Boolean)).toEqual([3, 6, 9]);
    await patch(admin.token, '/system-settings', { kgraph: { auditEvery: 0 } });
  });

  it('auditEvery 0 never schedules an audit run', async () => {
    const { taskId } = await reuseTask();
    for (let i = 0; i < 4; i++) {
      const runId = await newRun(taskId);
      await runnerOf(fabric('4,512.07'), scriptedAi([]).ai).advance(runId, owner.userId, null);
      expect((await prisma.kgRun.findUnique({ where: { runId } }))?.aiOnly).toBe(false);
    }
  });

  it('an audit run that disagrees with the procedure records a failure on the version and a notice', async () => {
    const { taskId, versionId } = await reuseTask();
    await runnerOf(fabric('4,512.07'), scriptedAi([]).ai).advance(await newRun(taskId), owner.userId, null);
    const audit = await newRun(taskId);
    await prisma.run.update({ where: { id: audit }, data: { status: 'succeeded', outputs: { total: { value: '87,000,000', ok: true } } as never } });
    await prisma.kgRun.create({ data: { runId: audit, userId: owner.userId, mode: 'reuse', aiOnly: true, procedureVersionId: versionId, outcome: 'ai_only' } });
    await app.get(KgraphAfterRun).finished(owner.userId, audit, 'succeeded');
    expect((await app.get(PrismaProcedureStore).getVersion(owner.userId, versionId))!.evidence.failures).toBe(1);
    const notice = await prisma.kgNode.findFirstOrThrow({ where: { userId: owner.userId, type: 'Notice', key: `audit:${audit}` } });
    expect(notice.label).toBe('the AI-only run and the saved procedure disagree');
    expect(JSON.stringify(notice)).not.toContain('87,000,000');
  });
});
