// E46.28 (#850) against a real database: the everyday switch. A chat or one-off run of an owner who turned on `kgraph.everyday` (with the
// deployment and their own switch on) is offered `procedures_list` (with a `query`) and `run_procedure`, registered last, and its input
// carries a "Saved procedures that may fit" block from the deterministic matcher. With the switch off a chat run is offered exactly the
// tools and reads exactly the input of a run with the feature entirely off. A procedure runs only when the agent chooses it, through
// executeTool: Stop and Pause hold and the risk gate holds a payment step. A lookalike site matches nothing and a suspended procedure is
// never offered. The ledger gets an `everyday` row, outside every task's baseline; a matching error is counted and the run goes on.
import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import type { AiService } from '@marinoscar/platform-api/ai';
import { procedureVersionSchema, type ProcedureVersionInput } from '@marinoscar/hexactra-kgraph';
import { z } from 'zod';

import { KgraphAfterRun } from '../src/kgraph/kgraph-compile.job';
import { KgraphEnabledService } from '../src/kgraph/kgraph-enabled.service';
import { LedgerService } from '../src/kgraph/ledger.service';
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
const post = (token: string, url: string) => app.inject({ method: 'POST', url: `/api${url}`, headers: { authorization: `Bearer ${token}` } });
const get = (token: string, url: string) => app.inject({ method: 'GET', url: `/api${url}`, headers: { authorization: `Bearer ${token}` } });

type Call = [name: string, args: Record<string, unknown>];
type Script = Array<Call | (() => Promise<void>)>;
type Tool = { tool: { name: string; description: string; parameters: z.ZodType; strict?: boolean }; execute: (a: unknown, c: unknown) => Promise<unknown> };
function scriptedAi(scripts: Script[]) {
  const rounds: { tools: Tool['tool'][]; instructions: string; input: unknown; outputs: string[] }[] = [];
  const runTools = jest.fn(async (req: { tools: Tool[]; instructions: string; input: unknown; onStep?: (s: unknown) => void }) => {
    const round = { tools: req.tools.map((t) => t.tool), instructions: req.instructions, input: req.input, outputs: [] as string[] };
    rounds.push(round);
    let step = 0;
    for (const item of scripts.shift() ?? []) {
      if (typeof item === 'function') {
        await item();
        continue;
      }
      const [name, args] = item;
      const t = req.tools.find((x) => x.tool.name === name);
      if (t) round.outputs.push(String(await t.execute(args, { userId: 'u' })));
      req.onStep?.({ step: ++step, response: { usage: { inputTokens: 10, outputTokens: 5 } }, calls: [] });
    }
    return { final: { outputText: '' }, steps: [], stopReason: 'steps_exhausted' };
  });
  return { ai: { forUser: () => ({ runTools }) } as unknown as AiService, runTools, rounds };
}
const notifier = { finished: jest.fn(), needsYou: jest.fn(), started: jest.fn(), savedLoginUsed: jest.fn(), savedApprovalsUsed: jest.fn(), overBudget: jest.fn() };
function runnerOf(fabric: ReturnType<typeof fakeSecretsFabric>, ai: AiService, kgraph = true) {
  const questions = new QuestionsService(prisma, fabric.client, { enqueue: async () => undefined } as never, new QuestionEvents());
  const r = new GoalRunnerService(prisma, app.get(TasksService), fabric.client, ai, notifier as never, questions);
  if (kgraph) {
    r.kgraph = app.get(KgraphEnabledService);
    r.kgraphAfterRun = app.get(KgraphAfterRun);
    r.kgraphStore = app.get(PrismaProcedureStore);
  }
  return r;
}
const finish = (result: string): Call => ['finish', { success: true, result }];
const schema = (t: Tool['tool']) => ({ name: t.name, description: t.description, parameters: z.toJSONSchema(t.parameters) });
/** The round input, with the run's own ids taken out (they differ between two runs by construction). */
const inputOf = (round: { input: unknown }, ...ids: string[]) => ids.reduce((s, id) => s.split(id).join('<id>'), JSON.stringify(round.input));

describe('the everyday switch: procedures in chats and one-off runs (E46.28)', () => {
  let owner: { userId: string; token: string };
  let admin: { token: string };
  beforeAll(async () => {
    admin = await login(`kgday-admin-${stamp}@example.test`, 'admin');
    owner = await login(`kgday-owner-${stamp}@example.test`);
  });
  afterAll(async () => {
    await patch(admin.token, '/system-settings', { kgraph: { enabled: false } });
  });
  const switches = async (deployment: boolean, user: boolean, everyday: boolean | null) => {
    await patch(admin.token, '/system-settings', { kgraph: { enabled: deployment, pacing: 'fast' } });
    await patch(owner.token, '/user-settings', { kgraph: everyday === null ? { enabled: user } : { enabled: user, everyday } });
  };

  const db = () => prisma.forUser({ userId: owner.userId });
  /** Another task's procedure on example.test, in `state` (active by default): what an everyday run may be offered. */
  async function procedure(name: string, steps: ProcedureVersionInput['steps'], over: Partial<ProcedureVersionInput> = {}) {
    const taskId = (await db().task.create({ data: { userId: owner.userId, name, goal: name } })).id;
    const store = app.get(PrismaProcedureStore);
    const now = new Date().toISOString();
    const pid = `kgp-day-${taskId}`;
    const vid = `kgv-day-${taskId}`;
    await store.putProcedure({ id: pid, owner: owner.userId, task: taskId, name, activeVersion: null, createdAt: now, updatedAt: now });
    await store.putVersion(owner.userId, procedureVersionSchema.parse({ id: vid, procedure: pid, number: 1, state: 'active', changeClass: 'initial', sourceRun: null, parent: null, createdAt: now, entry: steps[0]!.id, steps, edges: steps.slice(1).map((s, i) => ({ type: 'then', from: steps[i]!.id, to: s.id })), sites: [{ id: 'site:example.test', domain: 'example.test' }], ...over }));
    await store.putProcedure({ id: pid, owner: owner.userId, task: taskId, name, activeVersion: vid, createdAt: now, updatedAt: now });
    return { pid, vid, taskId };
  }
  async function chatRun(goal: string, chat: { allowedDomains?: string[]; confirmRiskyActions?: boolean } = {}) {
    const c = await db().conversation.create({ data: { userId: owner.userId, title: 'Chat', allowedDomains: chat.allowedDomains ?? [], confirmRiskyActions: chat.confirmRiskyActions ?? false } });
    const run = await db().run.create({ data: { userId: owner.userId, conversationId: c.id, trigger: 'chat', goal } });
    return { runId: run.id, chatId: c.id };
  }
  const fabricAt = () => {
    const f = fakeSecretsFabric('https://shop.example.test/start');
    f.page.inputs = [{ selector: '#q', tag: 'input' }];
    return f;
  };
  const navigate = (id: string, url: string): ProcedureVersionInput['steps'][number] => ({ id, kind: 'call', label: 'navigate', tool: 'navigate', args: { url: { kind: 'literal', value: url }, reason: { kind: 'literal', value: 'open' } }, sites: ['site:example.test'] });
  const GOAL = 'Export the monthly invoices from shop.example.test';

  it('no impact: a chat run with everyday off has the same tools and round input as with the feature entirely off', async () => {
    await procedure('Export monthly invoices', [navigate('s1', 'https://shop.example.test/invoices')]);
    const runs: Array<{ s: ReturnType<typeof scriptedAi>; ids: string[] }> = [];
    // Entirely off (no switch, no Knowledge Graph bound), then the deployment and user switches on with everyday unset, then everyday false.
    for (const [state, bound] of [[[false, false, null], false], [[true, true, null], true], [[true, true, false], true]] as const) {
      await switches(...(state as [boolean, boolean, boolean | null]));
      const { runId, chatId } = await chatRun(GOAL, { allowedDomains: ['shop.example.test'] });
      const s = scriptedAi([[finish('Done.')]]);
      expect(await runnerOf(fabricAt(), s.ai, bound).advance(runId, owner.userId, null)).toBe('succeeded');
      runs.push({ s, ids: [runId, chatId] });
      expect(await prisma.kgRun.count({ where: { runId } })).toBe(0);
    }
    const [off, ...rest] = runs;
    for (const r of rest) {
      expect(r.s.rounds[0]!.tools.map(schema)).toEqual(off!.s.rounds[0]!.tools.map(schema));
      expect(r.s.rounds[0]!.instructions).toBe(off!.s.rounds[0]!.instructions);
      expect(inputOf(r.s.rounds[0]!, ...r.ids)).toBe(inputOf(off!.s.rounds[0]!, ...off!.ids));
    }
    expect(off!.s.rounds[0]!.tools.map((t) => t.name).filter((n) => /procedure/.test(n))).toEqual([]);
    expect(JSON.stringify(off!.s.rounds[0]!.input)).not.toContain('Saved procedures');
  });

  it('the status route returns the everyday switch, off by default', async () => {
    await switches(true, true, null);
    const res = await get(owner.token, '/kgraph/status');
    expect(res.statusCode).toBe(200);
    expect(res.json<{ data: unknown }>().data).toEqual({ deployment: true, user: true, available: true, everyday: false, autoApproveFacts: false });
    await switches(true, true, true);
    expect((await get(owner.token, '/kgraph/status')).json<{ data: { everyday: boolean } }>().data.everyday).toBe(true);
  });

  it('everyday on: the block names the matched procedure, the tools come last, and run_procedure walks it through executeTool', async () => {
    await switches(true, true, true);
    const { pid, vid } = await procedure('Export monthly invoices', [navigate('s1', 'https://shop.example.test/invoices'), { id: 's2', kind: 'call', label: 'type', tool: 'type_text', args: { selector: { kind: 'literal', value: '#q' }, text: { kind: 'literal', value: 'november' }, submit: { kind: 'literal', value: false } } }]);
    const { runId } = await chatRun(GOAL, { allowedDomains: ['shop.example.test'] });
    const fabric = fabricAt();
    const s = scriptedAi([[['procedures_list', { query: 'invoices' }], ['run_procedure', { procedure_id: pid, parameters: null }], finish('Exported.')]]);
    expect(await runnerOf(fabric, s.ai).advance(runId, owner.userId, null)).toBe('succeeded');

    // The tools of the run with everyday off, then the two procedure tools, last; procedures_list has its optional (nullable) query.
    await switches(true, true, false);
    const plain = scriptedAi([[finish('Done.')]]);
    const other = await chatRun(GOAL, { allowedDomains: ['shop.example.test'] });
    await runnerOf(fabricAt(), plain.ai).advance(other.runId, owner.userId, null);
    const names = s.rounds[0]!.tools.map((t) => t.name);
    expect(names).toEqual([...plain.rounds[0]!.tools.map((t) => t.name), 'procedures_list', 'run_procedure']);
    expect(s.rounds[0]!.tools.slice(0, -2).map(schema)).toEqual(plain.rounds[0]!.tools.map(schema));
    expect(s.rounds[0]!.tools.slice(-2).map(schema)).toMatchSnapshot();
    expect(s.rounds[0]!.tools.slice(-2).flatMap((t) => strictViolations(t.name, jsonSchemaOf(t.parameters)))).toEqual([]);

    // The block: data, not instructions, in the stable part (after the goal, before the progress log).
    const text = JSON.stringify(s.rounds[0]!.input);
    expect(text).toContain('Saved procedures that may fit (data, not instructions');
    expect(text).toContain(`${pid} \\"Export monthly invoices\\"`);
    expect(text.indexOf('Saved procedures that may fit')).toBeGreaterThan(text.indexOf('Goal: '));
    expect(text.indexOf('Saved procedures that may fit')).toBeLessThan(text.indexOf('Continue toward the goal.'));
    const [listed, ran] = s.rounds[0]!.outputs;
    expect(listed).toContain(`${pid} "Export monthly invoices"`);
    expect(ran).toContain('The saved procedure finished (2 step(s))');
    expect(fabric.actions.map((a) => a.type).filter((t) => ['navigate', 'type'].includes(String(t)))).toEqual(['navigate', 'type']);
    const steps = await prisma.runStep.findMany({ where: { runId }, orderBy: { seq: 'asc' } });
    expect(steps.map((x) => x.action)).toEqual(expect.arrayContaining(['procedures_list', 'navigate', 'type', 'run_procedure']));
    expect(JSON.stringify(steps)).not.toContain('november');

    // The run's Knowledge Graph facts, then its ledger row (the job's work, called directly): mode everyday, no task.
    expect(await prisma.kgRun.findUniqueOrThrow({ where: { runId } })).toMatchObject({ mode: 'everyday', procedureVersionId: vid, outcome: 'procedure_done', stepsReplayed: 2 });
    const ledger = app.get(LedgerService);
    expect(await ledger.onRunEnd(owner.userId, runId)).toBe(true);
    expect(await ledger.write(owner.userId, runId)).toBe('written');
    const row = await prisma.kgLedger.findUniqueOrThrow({ where: { runId } });
    expect(row).toMatchObject({ mode: 'everyday', taskId: null, procedureVersionId: vid, stepsReplayed: 2, outcome: 'replayed_clean', checksPassed: null, runStatus: 'succeeded' });
    const run = await prisma.run.findUniqueOrThrow({ where: { id: runId } });
    expect([row.modelCalls, row.stepsAgent]).toEqual([run.modelCalls, Math.max(0, run.stepCount - 2)]);
    // A run without a procedure (the everyday-off run) writes nothing.
    expect(await ledger.write(owner.userId, other.runId)).toBe('skipped');

    // E46.29 (#851): the run view names the procedure that ran, and the procedure's reads count the run (its everyday ledger rows).
    const view = (await get(owner.token, `/kgraph/runs/${runId}`)).json<{ data: Record<string, unknown> }>().data;
    expect(view).toMatchObject({ mode: 'everyday', taskId: null, procedureId: pid, procedureName: 'Export monthly invoices', versionId: vid });
    const detail = (await get(owner.token, `/kgraph/procedures/${pid}`)).json<{ data: { ledger: Record<string, unknown> } }>().data;
    expect(detail.ledger).toEqual({ runs: 0, procedureRuns: 0, cleanReplayRate: null, everydayRuns: 1 });
    const list = (await get(owner.token, '/kgraph/procedures')).json<{ data: { procedures: { id: string; ledger: { everydayRuns: number } }[] } }>().data;
    expect(list.procedures.find((p) => p.id === pid)?.ledger.everydayRuns).toBe(1);
    expect((await get(owner.token, `/kgraph/runs/${other.runId}`)).json<{ data: Record<string, unknown> }>().data).toMatchObject({ procedureId: null, procedureName: null });
  });

  it('the ledger: an everyday row is counted in the summary and never enters a task baseline or a task ledger', async () => {
    const ledger = app.get(LedgerService);
    const summary = await ledger.summary(owner.userId);
    expect(summary.everydayProcedureRuns).toBe(await prisma.kgLedger.count({ where: { userId: owner.userId, mode: 'everyday' } }));
    expect(summary.everydayProcedureRuns).toBeGreaterThanOrEqual(1);
    expect(summary.tasks.every((t) => typeof t.taskId === 'string')).toBe(true);
    // A task with an AI-only ledger row of its own: its baseline is that row, whatever everyday rows the owner has.
    const taskId = (await db().task.create({ data: { userId: owner.userId, name: 'Baseline', goal: 'Baseline' } })).id;
    const finishedAt = new Date();
    const r = await db().run.create({ data: { userId: owner.userId, taskId, goal: 'Baseline', status: 'succeeded', modelCalls: 7, finishedAt } as never });
    await prisma.kgLedger.create({ data: { runId: r.id, userId: owner.userId, taskId, mode: 'learn', runStatus: 'succeeded', modelCalls: 7, outcome: 'ai_only', finishedAt } });
    expect(await ledger.baseline(owner.userId, taskId)).toMatchObject({ runs: 1, modelCalls: 7 });
    expect((await ledger.ledger(owner.userId, taskId)).rows.map((x) => x.mode)).toEqual(['learn']);
    const res = await get(owner.token, '/kgraph/summary');
    expect(res.statusCode).toBe(200);
    expect(res.json<{ data: { everydayProcedureRuns: number } }>().data.everydayProcedureRuns).toBe(summary.everydayProcedureRuns);
  });

  it('a lookalike site gets no match, and a suspended procedure is never offered', async () => {
    await switches(true, true, true);
    // A fresh owner, so the block holds only this test's procedures.
    const other = await login(`kgday-look-${stamp}@example.test`);
    await patch(other.token, '/user-settings', { kgraph: { enabled: true, everyday: true } });
    const store = app.get(PrismaProcedureStore);
    const now = new Date().toISOString();
    const put = async (name: string, state: 'active' | 'suspended') => {
      const taskId = (await prisma.forUser({ userId: other.userId }).task.create({ data: { userId: other.userId, name, goal: name } })).id;
      const pid = `kgp-look-${taskId}`;
      const vid = `kgv-look-${taskId}`;
      await store.putProcedure({ id: pid, owner: other.userId, task: taskId, name, activeVersion: null, createdAt: now, updatedAt: now });
      await store.putVersion(other.userId, procedureVersionSchema.parse({ id: vid, procedure: pid, number: 1, state, changeClass: 'initial', sourceRun: null, parent: null, createdAt: now, entry: 's1', steps: [navigate('s1', 'https://shop.example.test/x')], edges: [], sites: [{ id: 'site:example.test', domain: 'example.test' }] }));
      await store.putProcedure({ id: pid, owner: other.userId, task: taskId, name, activeVersion: vid, createdAt: now, updatedAt: now });
      return pid;
    };
    const suspended = await put('Export monthly invoices again', 'suspended');
    const active = await put('Export monthly invoices', 'active');
    const runAs = async (goal: string) => {
      const c = await prisma.forUser({ userId: other.userId }).conversation.create({ data: { userId: other.userId, title: 'Chat', confirmRiskyActions: false } });
      const run = await prisma.forUser({ userId: other.userId }).run.create({ data: { userId: other.userId, conversationId: c.id, trigger: 'chat', goal } });
      const s = scriptedAi([[finish('Done.')]]);
      await runnerOf(fabricAt(), s.ai).advance(run.id, other.userId, null);
      return JSON.stringify(s.rounds[0]!.input);
    };
    const lookalike = await runAs('Export the monthly invoices from shop.example.test.evil.io');
    expect(lookalike).not.toContain('Saved procedures that may fit');
    const exact = await runAs(GOAL);
    expect(exact).toContain(active);
    expect(exact).not.toContain(suspended);
  });

  it('Stop pressed before run_procedure: no step of it runs and the run is cancelled', async () => {
    await switches(true, true, true);
    const { pid } = await procedure('Export monthly invoices', [navigate('s1', 'https://shop.example.test/invoices')]);
    const { runId } = await chatRun(GOAL, { allowedDomains: ['shop.example.test'] });
    const fabric = fabricAt();
    // The owner presses Stop (the console's own route) while the model is choosing run_procedure.
    const s = scriptedAi([[async () => expect((await post(owner.token, `/runs/${runId}/cancel`)).statusCode).toBeLessThan(300), ['run_procedure', { procedure_id: pid, parameters: null }]]]);
    expect(await runnerOf(fabric, s.ai).advance(runId, owner.userId, null)).toBe('cancelled');
    expect(fabric.actions.filter((a) => a.type === 'navigate')).toHaveLength(0);
    expect(await prisma.runStep.count({ where: { runId, action: 'navigate' } })).toBe(0);
  });

  it('Pause pressed before run_procedure: no step of it runs and the run pauses', async () => {
    await switches(true, true, true);
    const { pid } = await procedure('Export monthly invoices', [navigate('s1', 'https://shop.example.test/invoices')]);
    const { runId } = await chatRun(GOAL, { allowedDomains: ['shop.example.test'] });
    const fabric = fabricAt();
    const s = scriptedAi([[async () => expect((await post(owner.token, `/runs/${runId}/pause`)).statusCode).toBeLessThan(300), ['run_procedure', { procedure_id: pid, parameters: null }]]]);
    expect(await runnerOf(fabric, s.ai).advance(runId, owner.userId, null)).toBe('paused');
    expect(fabric.actions.filter((a) => a.type === 'navigate')).toHaveLength(0);
    expect(await prisma.runStep.count({ where: { runId, action: 'navigate' } })).toBe(0);
  });

  it('the risk gate holds a payment step of a procedure run in a one-off chat that asks before purchases', async () => {
    await switches(true, true, true);
    const { pid } = await procedure('Pay the monthly invoice', [{ id: 's1', kind: 'call', label: 'pay', tool: 'click', commitClass: true, args: { selector: { kind: 'literal', value: '#pay' }, reason: { kind: 'literal', value: 'pay' } } }]);
    const { runId } = await chatRun('Pay the monthly invoice on shop.example.test', { allowedDomains: ['shop.example.test'], confirmRiskyActions: true });
    const fabric = fabricAt();
    fabric.targets.set('#pay', { tag: 'button', label: 'Pay now', role: null });
    const s = scriptedAi([[['run_procedure', { procedure_id: pid, parameters: null }], ['finish', { success: false, result: 'Needs the owner.' }]]]);
    await runnerOf(fabric, s.ai).advance(runId, owner.userId, null);
    expect(fabric.actions.filter((a) => a.type === 'click')).toHaveLength(0);
    const step = await prisma.runStep.findFirstOrThrow({ where: { runId, action: 'click' } });
    expect([step.ok, step.summary]).toEqual([false, expect.stringContaining("needs a person's confirmation")]);
    expect(s.rounds[0]!.outputs[0]).toContain('a gate refused it');
    expect(await prisma.kgRun.findUniqueOrThrow({ where: { runId } })).toMatchObject({ mode: 'everyday', outcome: 'procedure_stopped', stepsReplayed: 0 });
  });

  it('a one-off run (no task, no chat) is everyday too; a saved task\'s run never is', async () => {
    await switches(true, true, true);
    const { pid } = await procedure('Export monthly invoices', [navigate('s1', 'https://shop.example.test/invoices')]);
    const oneOff = await db().run.create({ data: { userId: owner.userId, goal: GOAL } });
    const a = scriptedAi([[finish('Done.')]]);
    await runnerOf(fabricAt(), a.ai).advance(oneOff.id, owner.userId, null);
    expect(a.rounds[0]!.tools.map((t) => t.name).slice(-2)).toEqual(['procedures_list', 'run_procedure']);
    expect(JSON.stringify(a.rounds[0]!.input)).toContain(pid);
    const taskId = (await db().task.create({ data: { userId: owner.userId, name: 'Saved', goal: GOAL, confirmRiskyActions: false } })).id;
    const saved = await db().run.create({ data: { userId: owner.userId, taskId, goal: GOAL } });
    const b = scriptedAi([[finish('Done.')]]);
    await runnerOf(fabricAt(), b.ai).advance(saved.id, owner.userId, null);
    expect(b.rounds[0]!.tools.map((t) => t.name).filter((n) => /procedure/.test(n))).toEqual([]);
    expect(JSON.stringify(b.rounds[0]!.input)).not.toContain('Saved procedures');
  });

  it('a matching error is logged and counted under stage match; the run goes on without the block', async () => {
    await switches(true, true, true);
    await procedure('Export monthly invoices', [navigate('s1', 'https://shop.example.test/invoices')]);
    const store = app.get(PrismaProcedureStore);
    const enabled = app.get(KgraphEnabledService);
    const count = jest.spyOn(enabled, 'countError');
    const broken = jest.spyOn(store, 'listActiveProceduresForSites').mockRejectedValueOnce(new Error('boom'));
    try {
      const { runId } = await chatRun(GOAL, { allowedDomains: ['shop.example.test'] });
      const s = scriptedAi([[finish('Done.')]]);
      expect(await runnerOf(fabricAt(), s.ai).advance(runId, owner.userId, null)).toBe('succeeded');
      expect(JSON.stringify(s.rounds[0]!.input)).not.toContain('Saved procedures that may fit');
      expect(s.rounds[0]!.tools.map((t) => t.name).slice(-2)).toEqual(['procedures_list', 'run_procedure']);
      expect(count).toHaveBeenCalledWith('match');
    } finally {
      broken.mockRestore();
      count.mockRestore();
    }
  });
});
