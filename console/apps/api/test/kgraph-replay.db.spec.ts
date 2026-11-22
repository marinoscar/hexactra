// E46.9 (#783) against a real database: a reuse-mode task run replays its procedure inside the ordinary run. Every call goes through
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

describe('the Knowledge Graph replay (#783)', () => {
  let owner: { userId: string; token: string };
  let admin: { token: string };
  beforeAll(async () => {
    admin = await login(`kgrep-admin-${stamp}@example.test`, 'admin');
    owner = await login(`kgrep-owner-${stamp}@example.test`);
    await patch(admin.token, '/system-settings', { kgraph: { enabled: true, pacing: 'fast' } });
    await patch(owner.token, '/user-settings', { kgraph: { enabled: true } });
  });
  afterAll(async () => {
    await patch(admin.token, '/system-settings', { kgraph: { enabled: false } });
  });

  const db = () => prisma.forUser({ userId: owner.userId });
  async function task(mode: 'off' | 'learn' | 'reuse', extra: Record<string, unknown> = {}) {
    const t = await db().task.create({ data: { userId: owner.userId, name: `Pens ${mode}`, goal: 'Search the shop for blue pens', confirmRiskyActions: false, ...extra } });
    await prisma.kgTaskSettings.create({ data: { taskId: t.id, userId: owner.userId, mode } });
    return t.id;
  }
  async function withVersion(taskId: string, steps: ProcedureVersionInput['steps'], over: Partial<ProcedureVersionInput> = {}) {
    const store = app.get(PrismaProcedureStore);
    const now = new Date().toISOString();
    const pid = `kgp-rep-${taskId}`;
    await store.putProcedure({ id: pid, owner: owner.userId, task: taskId, name: 'Pens', activeVersion: null, createdAt: now, updatedAt: now });
    const v = procedureVersionSchema.parse({ id: `kgv-rep-${taskId}`, procedure: pid, number: 1, state: 'active', changeClass: 'initial', sourceRun: null, parent: null, createdAt: now, entry: steps[0]!.id, steps, edges: steps.slice(1).map((s, i) => ({ type: 'then', from: steps[i]!.id, to: s.id })), sites: [{ id: 'site:example.test', domain: 'example.test' }], ...over });
    await store.putVersion(owner.userId, v);
    return v;
  }
  const newRun = async (taskId: string) => (await db().run.create({ data: { userId: owner.userId, taskId, goal: 'Search the shop for blue pens' } })).id;
  const fabricAt = () => {
    const f = fakeSecretsFabric('https://shop.example.test/start');
    f.page.inputs = [{ selector: '#q', tag: 'input' }, { selector: '#go', tag: 'button' }];
    return f;
  };
  const pens: ProcedureVersionInput['steps'] = [
    { id: 's1', kind: 'call', label: 'navigate', tool: 'navigate', args: { url: { kind: 'literal', value: 'https://shop.example.test/pens' }, reason: { kind: 'literal', value: 'open' } }, sites: ['site:example.test'] },
    { id: 's2', kind: 'call', label: 'type', tool: 'type_text', args: { selector: { kind: 'literal', value: '#q' }, text: { kind: 'literal', value: 'blue pens' }, submit: { kind: 'literal', value: false } } },
    { id: 's3', kind: 'call', label: 'click', tool: 'click', args: { selector: { kind: 'literal', value: '#go' }, reason: { kind: 'literal', value: 'search' } } },
  ];

  it('replays every step through executeTool with no model call; ordinary step rows; the run succeeds', async () => {
    const taskId = await task('reuse');
    await withVersion(taskId, pens);
    const runId = await newRun(taskId);
    const fabric = fabricAt();
    const s = scriptedAi([]);
    const runner = runnerOf(fabric, s.ai);
    expect(await runner.advance(runId, owner.userId, null)).toBe('succeeded');
    expect(s.runTools).not.toHaveBeenCalled();
    expect(fabric.actions.map((a) => a.type).filter((t) => ['navigate', 'type', 'click'].includes(String(t)))).toEqual(['navigate', 'type', 'click']);
    const steps = await prisma.runStep.findMany({ where: { runId }, orderBy: { seq: 'asc' } });
    expect(steps.map((x) => x.action)).toEqual(expect.arrayContaining(['navigate', 'type', 'click']));
    expect(steps.every((x) => x.phase === 'done')).toBe(true);
    // The typed text is redacted in the step row exactly as for the agent.
    expect(JSON.stringify(steps)).not.toContain('blue pens');
    const run = await prisma.run.findUniqueOrThrow({ where: { id: runId } });
    expect([run.status, run.result, run.modelCalls]).toEqual(['succeeded', 'Done by the saved procedure.', 0]);
    expect((await prisma.kgRun.findUniqueOrThrow({ where: { runId } })).outcome).toBe('replayed');
  });

  it('a failing check hands over: the first model input holds the replayed steps and the note, and the loop finishes the run', async () => {
    const taskId = await task('reuse');
    await withVersion(taskId, [
      { ...pens[0]!, checks: [{ kind: 'location', host: 'shop.example.test', pathPattern: '/pens' }] },
      pens[1]!,
    ]);
    const runId = await newRun(taskId);
    const s = scriptedAi([[['finish', { success: true, result: 'Found by the agent.' }]]]);
    expect(await runnerOf(fabricAt(), s.ai).advance(runId, owner.userId, null)).toBe('succeeded');
    expect(s.runTools).toHaveBeenCalledTimes(1);
    const first = JSON.stringify(s.inputs[0]);
    expect(first).toContain('A saved procedure');
    expect(first).toContain('did not match');
    expect(first).toContain('/start');
    expect((await prisma.run.findUniqueOrThrow({ where: { id: runId } })).result).toBe('Found by the agent.');
    expect((await prisma.kgRun.findUniqueOrThrow({ where: { runId } })).outcome).toBe('fell_back');
  });

  it("a replayed navigate outside the task's allowed sites is refused by the site gate, and the agent takes over", async () => {
    const taskId = await task('reuse', { allowedDomains: ['other.example.test'] });
    await withVersion(taskId, pens);
    const runId = await newRun(taskId);
    const fabric = fabricAt();
    const s = scriptedAi([[['finish', { success: false, result: 'Not allowed.' }]]]);
    await runnerOf(fabric, s.ai).advance(runId, owner.userId, null);
    expect(fabric.actions.some((a) => a.type === 'navigate')).toBe(false);
    const steps = await prisma.runStep.findMany({ where: { runId }, orderBy: { seq: 'asc' } });
    expect(steps[0]).toMatchObject({ action: 'navigate', ok: false });
    expect(JSON.stringify(s.inputs[0])).toContain('a gate refused it');
  });

  it('with "confirm risky actions" on, a replayed Pay click is held by the risk gate exactly as for the agent', async () => {
    const taskId = await task('reuse', { confirmRiskyActions: true });
    await withVersion(taskId, [{ id: 's1', kind: 'call', label: 'pay', tool: 'click', commitClass: true, args: { selector: { kind: 'literal', value: '#pay' }, reason: { kind: 'literal', value: 'pay' } } }]);
    const runId = await newRun(taskId);
    const fabric = fabricAt();
    fabric.targets.set('#pay', { tag: 'button', label: 'Pay now', role: null });
    const s = scriptedAi([[['finish', { success: false, result: 'Needs the owner.' }]]]);
    await runnerOf(fabric, s.ai).advance(runId, owner.userId, null);
    // The gate refused the replayed click as it refuses the agent's: no click reached the page, and the agent took over.
    expect(fabric.actions.filter((a) => a.type === 'click')).toHaveLength(0);
    const step = await prisma.runStep.findFirstOrThrow({ where: { runId, action: 'click' } });
    expect([step.ok, step.summary]).toEqual([false, expect.stringContaining("needs a person's confirmation")]);
    expect(JSON.stringify(s.inputs[0])).toContain('a gate refused it');
  });

  it('Stop pressed before replay: no step runs and nothing is recorded', async () => {
    const taskId = await task('reuse');
    await withVersion(taskId, pens);
    const runId = await newRun(taskId);
    await prisma.run.update({ where: { id: runId }, data: { cancelRequested: true } as never });
    const fabric = fabricAt();
    const s = scriptedAi([]);
    expect(await runnerOf(fabric, s.ai).advance(runId, owner.userId, null)).toBe('cancelled');
    expect(fabric.actions.filter((a) => a.type === 'navigate')).toHaveLength(0);
    expect(await prisma.runStep.count({ where: { runId, kind: 'action' } })).toBe(0);
  });

  it('a commit step whose intent was left open (a crash) is never sent again: the agent takes over and the owner decides', async () => {
    const taskId = await task('reuse');
    const v = await withVersion(taskId, [pens[0]!, { ...pens[2]!, commitClass: true }]);
    const runId = await newRun(taskId);
    // A job crashed after s1 and after recording s2's intent.
    await prisma.run.update({ where: { id: runId }, data: { transcript: { log: [], chunks: 0, kgraphReplay: { version: v.id, done: ['s1'], intent: 's3', handedOver: false } } } as never });
    const fabric = fabricAt();
    const s = scriptedAi([[['finish', { success: false, result: 'Asked the owner.' }]]]);
    await runnerOf(fabric, s.ai).advance(runId, owner.userId, null);
    expect(fabric.actions.filter((a) => a.type === 'click')).toHaveLength(0);
    expect(fabric.actions.filter((a) => a.type === 'navigate')).toHaveLength(0);
    expect(JSON.stringify(s.inputs[0])).toContain('it needs the owner');
  });

  it('an executor error hands over and the run goes on under the loop', async () => {
    const taskId = await task('reuse');
    // s2 reads an output of a step that never ran: the executor reports an error.
    await withVersion(taskId, [pens[0]!, { id: 's2', kind: 'call', label: 'type', tool: 'type_text', args: { selector: { kind: 'literal', value: '#q' }, text: { kind: 'output', step: 'ghost' }, submit: { kind: 'literal', value: false } } }]);
    const runId = await newRun(taskId);
    const s = scriptedAi([[['finish', { success: true, result: 'Agent did it.' }]]]);
    expect(await runnerOf(fabricAt(), s.ai).advance(runId, owner.userId, null)).toBe('succeeded');
    expect(s.runTools).toHaveBeenCalledTimes(1);
  });

  it('with the mode off nothing is replayed even with an active version', async () => {
    const taskId = await task('off');
    await withVersion(taskId, pens);
    const runId = await newRun(taskId);
    const fabric = fabricAt();
    const s = scriptedAi([[['finish', { success: true, result: 'AI only.' }]]]);
    expect(await runnerOf(fabric, s.ai).advance(runId, owner.userId, null)).toBe('succeeded');
    expect(s.runTools).toHaveBeenCalledTimes(1);
    expect(fabric.actions.filter((a) => a.type === 'navigate')).toHaveLength(0);
    expect(await prisma.kgRun.count({ where: { runId } })).toBe(0);
  });

  it('learn, compile, then reuse: the second run replays what the first did', async () => {
    const taskId = await task('learn');
    const first = await newRun(taskId);
    const learn = scriptedAi([[['navigate', { url: 'https://shop.example.test/pens', reason: 'open' }], ['click', { selector: '#go', reason: 'search' }], ['finish', { success: true, result: 'Found.' }]]]);
    expect(await runnerOf(fabricAt(), learn.ai).advance(first, owner.userId, null)).toBe('succeeded');
    expect(await app.get(KgraphCompileService).compileRun(owner.userId, first)).toBe('compiled');
    await prisma.kgTaskSettings.update({ where: { taskId }, data: { mode: 'reuse' } });
    const second = await newRun(taskId);
    const fabric = fabricAt();
    const s = scriptedAi([]);
    expect(await runnerOf(fabric, s.ai).advance(second, owner.userId, null)).toBe('succeeded');
    expect(s.runTools).not.toHaveBeenCalled();
    expect(fabric.actions.map((a) => a.type).filter((t) => t === 'navigate' || t === 'click')).toEqual(['navigate', 'click']);
  });
});
