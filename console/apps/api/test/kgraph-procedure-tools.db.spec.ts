// E46.22 (#796) against a real database: the owner's learned procedures as tools of a run. A run in `reuse` mode is offered exactly the tools
// of a run with the feature off, then `procedures_list` and `run_procedure` (pinned here, with their schemas); a run with the mode off or
// `learn` is offered neither. `run_procedure` walks another ACTIVE procedure of the owner through executeTool (fabric actions and ordinary
// step rows), the site gate refuses a step outside the run's allowed sites, and a sub-procedure that calls run_procedure again is refused.
import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import type { AiService } from '@marinoscar/platform-api/ai';
import { procedureVersionSchema, type ProcedureVersionInput } from '@marinoscar/hexactra-kgraph';
import { z } from 'zod';

import { KgraphAfterRun } from '../src/kgraph/kgraph-compile.job';
import { KgraphEnabledService } from '../src/kgraph/kgraph-enabled.service';
import { PrismaProcedureStore } from '../src/kgraph/prisma-procedure-store';
import { createApp } from '../src/main';
import { PrismaService } from '../src/prisma/prisma.service';
import { QuestionEvents } from '../src/questions/question-events';
import { QuestionsService } from '../src/questions/questions.service';
import { GoalRunnerService } from '../src/runner/goal-runner.service';
import { TasksService } from '../src/tasks/tasks.service';
import { jsonSchemaOf, strictViolations } from './helpers/strict-schema';
import { fakeSecretsFabric } from './support/fake-secrets-fabric';

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
type Tool = { tool: { name: string; description: string; parameters: z.ZodType; strict?: boolean }; execute: (a: unknown, c: unknown) => Promise<unknown> };
function scriptedAi(scripts: Call[][]) {
  const rounds: { tools: Tool['tool'][]; instructions: string; outputs: string[] }[] = [];
  const runTools = jest.fn(async (req: { tools: Tool[]; instructions: string; onStep?: (s: unknown) => void }) => {
    const round = { tools: req.tools.map((t) => t.tool), instructions: req.instructions, outputs: [] as string[] };
    rounds.push(round);
    let step = 0;
    for (const [name, args] of scripts.shift() ?? []) {
      const t = req.tools.find((x) => x.tool.name === name);
      if (t) round.outputs.push(String(await t.execute(args, { userId: 'u' })));
      req.onStep?.({ step: ++step, response: { usage: { inputTokens: 10, outputTokens: 5 } }, calls: [] });
    }
    return { final: { outputText: '' }, steps: [], stopReason: 'steps_exhausted' };
  });
  return { ai: { forUser: () => ({ runTools }) } as unknown as AiService, runTools, rounds };
}
const notifier = { finished: jest.fn(), needsYou: jest.fn(), started: jest.fn(), savedLoginUsed: jest.fn(), savedApprovalsUsed: jest.fn(), overBudget: jest.fn() };
function runnerOf(fabric: ReturnType<typeof fakeSecretsFabric>, ai: AiService) {
  const questions = new QuestionsService(prisma, fabric.client, { enqueue: async () => undefined } as never, new QuestionEvents());
  const r = new GoalRunnerService(prisma, app.get(TasksService), fabric.client, ai, notifier as never, questions);
  r.kgraph = app.get(KgraphEnabledService);
  r.kgraphAfterRun = app.get(KgraphAfterRun);
  r.kgraphStore = app.get(PrismaProcedureStore);
  return r;
}

describe('the learned procedures as tools of a run (E46.22)', () => {
  let owner: { userId: string; token: string };
  let admin: { token: string };
  beforeAll(async () => {
    admin = await login(`kgtools-admin-${stamp}@example.test`, 'admin');
    owner = await login(`kgtools-owner-${stamp}@example.test`);
    await patch(admin.token, '/system-settings', { kgraph: { enabled: true, pacing: 'fast' } });
    await patch(owner.token, '/user-settings', { kgraph: { enabled: true } });
  });
  afterAll(async () => {
    await patch(admin.token, '/system-settings', { kgraph: { enabled: false } });
  });

  const db = () => prisma.forUser({ userId: owner.userId });
  async function task(mode: 'off' | 'learn' | 'reuse', extra: Record<string, unknown> = {}) {
    const t = await db().task.create({ data: { userId: owner.userId, name: `Report ${mode}`, goal: 'Export the monthly report', confirmRiskyActions: false, ...extra } });
    await prisma.kgTaskSettings.create({ data: { taskId: t.id, userId: owner.userId, mode } });
    return t.id;
  }
  /** Another task's ACTIVE procedure: the sub-procedure a reuse run may call. */
  async function procedure(steps: ProcedureVersionInput['steps'], over: Partial<ProcedureVersionInput> = {}) {
    const taskId = (await db().task.create({ data: { userId: owner.userId, name: 'Sign in to the shop', goal: 'Sign in to the shop' } })).id;
    const store = app.get(PrismaProcedureStore);
    const now = new Date().toISOString();
    const pid = `kgp-sub-${taskId}`;
    const vid = `kgv-sub-${taskId}`;
    await store.putProcedure({ id: pid, owner: owner.userId, task: taskId, name: 'Sign in to the shop', activeVersion: null, createdAt: now, updatedAt: now });
    await store.putVersion(owner.userId, procedureVersionSchema.parse({ id: vid, procedure: pid, number: 1, state: 'active', changeClass: 'initial', sourceRun: null, parent: null, createdAt: now, entry: steps[0]!.id, steps, edges: steps.slice(1).map((s, i) => ({ type: 'then', from: steps[i]!.id, to: s.id })), sites: [{ id: 'site:example.test', domain: 'example.test' }], ...over }));
    await store.putProcedure({ id: pid, owner: owner.userId, task: taskId, name: 'Sign in to the shop', activeVersion: vid, createdAt: now, updatedAt: now });
    return pid;
  }
  const newRun = async (taskId: string) => (await db().run.create({ data: { userId: owner.userId, taskId, goal: 'Export the monthly report' } })).id;
  const fabricAt = () => {
    const f = fakeSecretsFabric('https://shop.example.test/start');
    f.page.inputs = [{ selector: '#q', tag: 'input' }];
    return f;
  };
  const navigate = (id: string, url: string): ProcedureVersionInput['steps'][number] => ({ id, kind: 'call', label: 'navigate', tool: 'navigate', args: { url: { kind: 'literal', value: url }, reason: { kind: 'literal', value: 'open' } }, sites: ['site:example.test'] });
  const finish = (result: string): Call => ['finish', { success: true, result }];

  it('pins the tool list of a reuse run: the tools of a run with the feature off, then procedures_list and run_procedure; their family line', async () => {
    const off = scriptedAi([[finish('off')]]);
    expect(await runnerOf(fabricAt(), off.ai).advance(await newRun(await task('off')), owner.userId, null)).toBe('succeeded');
    const learn = scriptedAi([[finish('learn')]]);
    expect(await runnerOf(fabricAt(), learn.ai).advance(await newRun(await task('learn')), owner.userId, null)).toBe('succeeded');
    const reuse = scriptedAi([[finish('reuse')]]);
    expect(await runnerOf(fabricAt(), reuse.ai).advance(await newRun(await task('reuse')), owner.userId, null)).toBe('succeeded');

    const names = (r: typeof off) => r.rounds[0]!.tools.map((t) => t.name);
    // Off and learn: exactly the same list, with no procedure tool.
    expect(names(learn)).toEqual(names(off));
    expect(names(off).filter((n) => /procedure/.test(n))).toEqual([]);
    // Reuse: the same list, the same schemas and descriptions, then the two tools, last.
    expect(names(reuse)).toEqual([...names(off), 'procedures_list', 'run_procedure']);
    const schema = (t: Tool['tool']) => ({ name: t.name, description: t.description, parameters: z.toJSONSchema(t.parameters) });
    expect(reuse.rounds[0]!.tools.slice(0, -2).map(schema)).toEqual(off.rounds[0]!.tools.map(schema));
    expect(reuse.rounds[0]!.tools.slice(-2).map(schema)).toMatchSnapshot();
    expect(reuse.rounds[0]!.tools.slice(-2).flatMap((t) => strictViolations(t.name, jsonSchemaOf(t.parameters)))).toEqual([]);
    expect(reuse.rounds[0]!.instructions).toContain("- The owner's saved procedures: Steps learned from the owner's earlier runs");
    expect(off.rounds[0]!.instructions).not.toContain('saved procedures');
  });

  it('run_procedure walks another active procedure through executeTool: fabric actions, ordinary step rows; procedures_list names it', async () => {
    const pid = await procedure([navigate('s1', 'https://shop.example.test/login'), { id: 's2', kind: 'call', label: 'type', tool: 'type_text', args: { selector: { kind: 'literal', value: '#q' }, text: { kind: 'parameter', parameter: 'p:who' }, submit: { kind: 'literal', value: false } } }], {
      parameters: [{ id: 'p:who', name: 'Customer', type: 'string', sensitive: false, required: true }],
    });
    const runId = await newRun(await task('reuse'));
    const fabric = fabricAt();
    const s = scriptedAi([[['procedures_list', {}], ['run_procedure', { procedure_id: pid, parameters: [{ name: 'Customer', value: 'ACME' }] }], finish('Done.')]]);
    expect(await runnerOf(fabric, s.ai).advance(runId, owner.userId, null)).toBe('succeeded');
    const [listed, ran] = s.rounds[0]!.outputs;
    expect(listed).toContain(`${pid} "Sign in to the shop": parameters Customer; returns nothing`);
    expect(ran).toContain('The saved procedure finished (2 step(s))');
    expect(fabric.actions.map((a) => a.type).filter((t) => ['navigate', 'type'].includes(String(t)))).toEqual(['navigate', 'type']);
    const steps = await prisma.runStep.findMany({ where: { runId }, orderBy: { seq: 'asc' } });
    expect(steps.map((x) => x.action)).toEqual(expect.arrayContaining(['procedures_list', 'navigate', 'type', 'run_procedure']));
    // The step of run_procedure names the parameters, never their values; the typed value is redacted as for the agent.
    expect(JSON.stringify(steps)).not.toContain('ACME');
  });

  it('the gates apply: a step outside the run\'s allowed sites is refused by the site gate and nothing after it runs', async () => {
    const pid = await procedure([navigate('s1', 'https://shop.example.test/login'), navigate('s2', 'https://shop.example.test/after')]);
    const runId = await newRun(await task('reuse', { allowedDomains: ['other.example.test'] }));
    const fabric = fabricAt();
    const s = scriptedAi([[['run_procedure', { procedure_id: pid, parameters: null }], finish('Not allowed.')]]);
    await runnerOf(fabric, s.ai).advance(runId, owner.userId, null);
    expect(s.rounds[0]!.outputs[0]).toContain('a gate refused it');
    expect(fabric.actions.filter((a) => a.type === 'navigate')).toHaveLength(0);
  });

  it('depth 2 is refused: a sub-procedure whose step is run_procedure gets the refusal and its inner procedure never runs', async () => {
    const inner = await procedure([navigate('i1', 'https://shop.example.test/inner')]);
    const outer = await procedure([{ id: 'o1', kind: 'call', label: 'run another', tool: 'run_procedure', args: { procedure_id: { kind: 'literal', value: inner }, parameters: { kind: 'literal', value: null } } }]);
    const runId = await newRun(await task('reuse'));
    const fabric = fabricAt();
    const s = scriptedAi([[['run_procedure', { procedure_id: outer, parameters: null }], finish('Done.')]]);
    await runnerOf(fabric, s.ai).advance(runId, owner.userId, null);
    expect(fabric.actions.filter((a) => a.type === 'navigate')).toHaveLength(0);
    const steps = await prisma.runStep.findMany({ where: { runId, action: 'run_procedure' }, orderBy: { seq: 'asc' } });
    // The inner call is refused (a failed run_procedure row), so the outer procedure stops there: both rows failed, and the model is told.
    expect(steps.map((x) => x.ok)).toEqual([false, false]);
    expect(s.rounds[0]!.outputs[0]).toContain('The saved procedure did 0 step(s) and stopped at "run another"');
  });

  it('this task\'s own procedure, an inactive one or another owner\'s is not offered and cannot be run', async () => {
    const taskId = await task('reuse');
    const store = app.get(PrismaProcedureStore);
    const now = new Date().toISOString();
    const own = `kgp-own-${taskId}`;
    await store.putProcedure({ id: own, owner: owner.userId, task: taskId, name: 'Own', activeVersion: null, createdAt: now, updatedAt: now });
    const runId = await newRun(taskId);
    const s = scriptedAi([[['procedures_list', {}], ['run_procedure', { procedure_id: own, parameters: null }], finish('Done.')]]);
    await runnerOf(fabricAt(), s.ai).advance(runId, owner.userId, null);
    expect(s.rounds[0]!.outputs[0]).not.toContain(own);
    expect(s.rounds[0]!.outputs[1]).toContain('No saved procedure');
  });
});
