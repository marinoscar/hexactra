// Crash safety of a run (E38.3, #584): the runner against a real database, a scripted model and an in-memory fabric whose
// transport can hang for good (the process died). A "crash" is an advance that never finishes: its promise is abandoned and a
// second runner takes the run, as the job queue does with a retried job. Progress is saved after every action, a step that may
// have happened is never repeated, and only one job acts on a run.
import { randomUUID } from 'node:crypto';
import { Logger } from '@nestjs/common';
import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import type { AiService } from '@marinoscar/platform-api/ai';

import { createApp } from '../src/main';
import { PrismaService } from '../src/prisma/prisma.service';
import type { FabricClient } from '../src/fabric/fabric.client';
import { GoalRunnerService, type RunMemory } from '../src/runner/goal-runner.service';
import { QuestionEvents } from '../src/questions/question-events';
import { QuestionsService } from '../src/questions/questions.service';
import { TasksService } from '../src/tasks/tasks.service';
import { ApprovalRulesService } from '../src/approvals/approval-rules.service';
import { HexactraAlertsService } from '../src/alerts/hexactra-alerts.service';
import { HEXACTRA_ALERT_KINDS, runRecoveredKind, setAlertSources } from '../src/alerts/hexactra-alert-kinds';
import { RUN_READING_ALERT_KINDS } from '../src/alerts/run-alert-kinds';
import { defineRunTool, inCommitTool } from '../src/runner/intent';
import { RunStopSignal } from '../src/runner/stop-signal';
import { z } from 'zod';

let app: NestFastifyApplication;
const stamp = `${Date.now()}`;
const SITE = 'https://secure.pay.example.com/review';

// An abandoned job (the simulated crash) never disposes its stop signal (E38.1): its poll is stopped here, before the app closes.
const stopSignals: RunStopSignal[] = [];

beforeAll(async () => {
  const start = RunStopSignal.start.bind(RunStopSignal);
  jest.spyOn(RunStopSignal, 'start').mockImplementation((source) => {
    const signal = start(source);
    stopSignals.push(signal);
    return signal;
  });
  app = await createApp();
  await app.init();
  await app.getHttpAdapter().getInstance().ready();
});
afterAll(async () => {
  for (const s of stopSignals) s.dispose();
  await app?.close();
});

async function login(email: string): Promise<string> {
  const res = await app.inject({ method: 'POST', url: '/api/auth/test/login', payload: { email, role: 'contributor' } });
  const token = new URL(String(res.headers.location)).searchParams.get('token')!;
  const me = await app.inject({ method: 'GET', url: '/api/auth/me', headers: { authorization: `Bearer ${token}` } });
  return me.json<{ data: { id: string } }>().data.id;
}

type Handoff = { id: string; status: string; input: string; kind: string; response?: Record<string, unknown> };

/** An in-memory fabric: one page, click targets the page describes, handoffs. `hangOn` makes the transport never answer (the process died). */
function fakeFabric(url: string = SITE) {
  const actions: Record<string, unknown>[] = [];
  const handoffs = new Map<string, Handoff>();
  const targets = new Map<string, Record<string, unknown> | null>([['#pay', { tag: 'button', label: 'Pay' }]]);
  const page = { url };
  const hook: { hangOn: ((action: Record<string, unknown>) => boolean) | null; hung: Promise<void>; onHang: () => void } = { hangOn: null, hung: Promise.resolve(), onHang: () => undefined };
  const armHang = (when: (action: Record<string, unknown>) => boolean) => {
    hook.hangOn = when;
    hook.hung = new Promise<void>((resolve) => (hook.onHang = resolve));
  };
  const request = jest.fn(async (method: string, path: string, opts: { body?: Record<string, unknown> } = {}) => {
    if (method === 'POST' && path === '/v1/sessions') return { id: '00000000-0000-4000-8000-00000000000c' };
    if (method === 'DELETE' && path.startsWith('/v1/sessions/')) return undefined;
    if (method === 'POST' && path.endsWith('/actions')) {
      const action = opts.body!.action as Record<string, unknown>;
      if (action.type === 'evaluate' && String(action.script).startsWith('/* hexactra:describe-target */')) {
        const where = JSON.parse(/const where = (.*);/.exec(String(action.script))![1]!) as { selector?: string; x?: number; y?: number };
        return { id: 'op', state: 'succeeded', result: { type: 'object', value: targets.get(where.selector ?? `${where.x},${where.y}`) ?? null } };
      }
      if (hook.hangOn?.(action)) {
        // The action reached the page, then the process died: the request never comes back.
        actions.push(action);
        hook.hangOn = null;
        hook.onHang();
        return new Promise(() => undefined);
      }
      actions.push(action);
      if (action.type === 'tabs') return { id: 'op', state: 'succeeded', result: { tabs: [{ id: 1, active: true, url: page.url, title: 'Review' }] } };
      if (action.type === 'navigate') return { id: 'op', state: 'succeeded', result: { url: action.url, title: 'Shop' } };
      return { id: 'op', state: 'succeeded', result: {} };
    }
    if (method === 'POST' && path.endsWith('/handoffs')) {
      const id = randomUUID();
      handoffs.set(id, { id, status: 'pending', input: String(opts.body!.input), kind: String(opts.body!.kind) });
      return { handoff: { id } };
    }
    if (method === 'POST' && /\/v1\/handoffs\/[^/]+\/respond$/.test(path)) {
      const h = handoffs.get(path.split('/')[3]!);
      if (!h) return {};
      Object.assign(h, { status: 'completed', response: { outcome: opts.body!.outcome, value: opts.body!.value, value_withheld: false } });
      return {};
    }
    if (method === 'GET' && path.startsWith('/v1/handoffs/')) return handoffs.get(path.split('/')[3]!);
    throw new Error(`unexpected ${method} ${path}`);
  });
  const client = { request, config: async () => ({ url: 'http://f', token: 't' }) } as unknown as FabricClient;
  return { client, actions, handoffs, targets, page, hook, armHang, clicks: () => actions.filter((a) => a.type === 'click') };
}
type Fabric = ReturnType<typeof fakeFabric>;

type Call = [name: string, args: Record<string, unknown>];

/**
 * A model that makes the scripted tool calls, one script per round. `hangAfter`: after that many tool calls the model never
 * answers (the process died between two actions). `gate`: the round starts only when it opens.
 */
function scriptedAi(scripts: Call[][], opts: { hangAfter?: number; gate?: Promise<void>; started?: () => void } = {}) {
  const outputs: string[] = [];
  const inputs: string[] = [];
  let executed = 0;
  const runTools = jest.fn(async (req: { tools: { tool: { name: string }; execute: (a: unknown, c: unknown) => Promise<unknown> }[]; onStep?: (s: unknown) => void; input: unknown }) => {
    inputs.push(typeof req.input === 'string' ? req.input : JSON.stringify(req.input));
    opts.started?.();
    if (opts.gate) await opts.gate;
    const script = scripts.shift() ?? [];
    let step = 0;
    for (const [name, args] of script) {
      const t = req.tools.find((x) => x.tool.name === name)!;
      outputs.push(String(await t.execute(args, { userId: 'u' })));
      executed += 1;
      if (opts.hangAfter !== undefined && executed >= opts.hangAfter) await new Promise(() => undefined);
      req.onStep?.({ step: ++step, response: { usage: { inputTokens: 10, outputTokens: 5 } }, calls: [] });
    }
    return { final: { outputText: '' }, steps: [], stopReason: 'steps_exhausted' };
  });
  return { ai: { forUser: () => ({ runTools }) } as unknown as AiService, outputs, inputs, runTools };
}

/** `request_human` with every field the tool takes (nulls where they do not apply). */
function ask(prompt: string): Call {
  return ['request_human', { kind: 'confirmation', prompt, input: 'confirm', choices: null, options: null, constraints: null, confirm_label: null, deny_label: null, risk: 'low', remember_label: null, topic: null }];
}
const pay: Call = ['click', { selector: '#pay', reason: 'pay' }];
const nav = (n: number): Call[] => Array.from({ length: n }, (_, i): Call => ['navigate', { url: `https://secure.pay.example.com/${i}`, reason: 'go' }]);
/** Lets the abandoned job's promise be: it never settles, as a dead process never does. */
const abandon = (p: Promise<unknown>) => void p.catch(() => undefined);

describe('crash safety of a run (E38.3)', () => {
  const notifier = { finished: jest.fn(), needsYou: jest.fn(), started: jest.fn(), savedApprovalsUsed: jest.fn() };
  let prisma: PrismaService;
  let approvals: ApprovalRulesService;
  const enqueued: { reason: string; payload: unknown }[] = [];
  const brokers = new WeakMap<object, QuestionsService>();
  beforeAll(() => {
    prisma = app.get(PrismaService);
    approvals = app.get(ApprovalRulesService);
  });
  const brokerOf = (fabric: Fabric) => {
    let b = brokers.get(fabric);
    if (!b) {
      const jobs = { enqueue: async (j: { reason: string; payload: unknown }) => void enqueued.push({ reason: j.reason, payload: j.payload }) };
      brokers.set(fabric, (b = new QuestionsService(prisma, fabric.client, jobs as never, new QuestionEvents(), undefined, undefined, approvals)));
    }
    return b;
  };
  const runnerOf = (fabric: Fabric, ai: AiService, prismaOverride?: PrismaService) => {
    const r = new GoalRunnerService(prismaOverride ?? prisma, app.get(TasksService), fabric.client, ai, notifier as never, brokerOf(fabric));
    r.approvals = approvals;
    return r;
  };

  /** An owner with a task that asks before commitments, and one run of it. */
  async function owner(label: string) {
    const userId = await login(`crash-${label}-${stamp}@example.test`);
    const db = prisma.forUser({ userId });
    const task = await db.task.create({ data: { userId, name: `Pay ${label}`, goal: 'Pay the bill', confirmRiskyActions: true } });
    const run = await db.run.create({ data: { userId, taskId: task.id, goal: 'Pay the bill' } });
    return { userId, db, task, run };
  }
  const stepsOf = (runId: string) => prisma.runStep.findMany({ where: { runId }, orderBy: { seq: 'asc' } });
  const memoryOf = async (runId: string) => (await prisma.run.findUniqueOrThrow({ where: { id: runId } })).transcript as unknown as RunMemory;
  const approve = (fabric: Fabric) => Object.assign([...fabric.handoffs.values()].at(-1)!, { status: 'completed', response: { outcome: 'completed', value: 'approve', value_withheld: false } });

  it('saves progress after every action: a job killed after the third action leaves a run the next job continues without repeating them', async () => {
    const o = await owner('three');
    const fabric = fakeFabric();
    const first = scriptedAi([[...nav(3), ...nav(1)]], { hangAfter: 3 });
    abandon(runnerOf(fabric, first.ai).advance(o.run.id, o.userId, null));
    await new Promise((r) => setTimeout(r, 1_500));
    expect(first.outputs).toHaveLength(3);

    // What the database holds with the process gone: three steps, and a memory that already tells the model about them.
    const crashed = await prisma.run.findUniqueOrThrow({ where: { id: o.run.id } });
    expect(crashed.stepCount).toBe(3);
    expect(crashed.workerToken).not.toBeNull();
    expect((crashed.transcript as unknown as RunMemory).lastSeq).toBe(3);
    expect((crashed.transcript as unknown as RunMemory).log.filter((l) => /^\d\. navigate/.test(l))).toHaveLength(3);

    const second = scriptedAi([[['finish', { success: true, result: 'Done.' }]]]);
    expect(await runnerOf(fabric, second.ai).advance(o.run.id, o.userId, null)).toBe('succeeded');
    for (const n of [1, 2, 3]) expect(second.inputs[0]).toContain(`${n}. navigate`);
    expect(second.inputs[0]).toContain('The run was interrupted and continued. Look at the page before acting.');
    // Nothing was sent to the fabric again.
    expect(fabric.actions.filter((a) => a.type === 'navigate')).toHaveLength(3);
    const done = await prisma.run.findUniqueOrThrow({ where: { id: o.run.id } });
    expect(done.recoveries).toBe(1);
    expect(done.workerToken).toBeNull();
    expect((await stepsOf(o.run.id)).filter((s) => s.kind === 'action').map((s) => s.phase)).toEqual(['done', 'done', 'done']);
  });

  it('reconciles steps the memory lacks (killed between the step row and the memory) from the step rows', async () => {
    const o = await owner('lag');
    const fabric = fakeFabric();
    const first = scriptedAi([nav(2)], { hangAfter: 2 });
    abandon(runnerOf(fabric, first.ai).advance(o.run.id, o.userId, null));
    await new Promise((r) => setTimeout(r, 1_000));
    // Rewind the memory and the count to after the first action, as if the process died right after the second step row.
    const memory = await memoryOf(o.run.id);
    memory.log = memory.log.filter((l) => !l.startsWith('2. '));
    memory.lastSeq = 1;
    await prisma.run.update({ where: { id: o.run.id }, data: { transcript: memory as never, stepCount: 1 } });

    const second = scriptedAi([[['finish', { success: true, result: 'Done.' }]]]);
    expect(await runnerOf(fabric, second.ai).advance(o.run.id, o.userId, null)).toBe('succeeded');
    expect(second.inputs[0]).toContain('1. navigate');
    expect(second.inputs[0]).toContain('2. navigate');
    // The reconciled step counts as an action.
    expect((await prisma.run.findUniqueOrThrow({ where: { id: o.run.id } })).stepCount).toBe(3);
  });

  describe('a confirmed step is never carried out twice', () => {
    /** Stopped at "Pay", asked, approved: the next click on "Pay" is the confirmed one. */
    async function approvedRun(label: string, fabric: Fabric) {
      const o = await owner(label);
      const { ai } = scriptedAi([[pay, ask('Pressing Pay sends $10. May I?')]]);
      expect(await runnerOf(fabric, ai).advance(o.run.id, o.userId, null)).toBe('waiting_human');
      approve(fabric);
      return o;
    }

    it('killed between the intent record and the result of the confirmed click: the step is unknown, the model is told, the gate asks again', async () => {
      const fabric = fakeFabric();
      const o = await approvedRun('intent', fabric);
      fabric.armHang((a) => a.type === 'click');
      const dying = scriptedAi([[pay, ['finish', { success: true, result: 'Paid.' }]]]);
      abandon(runnerOf(fabric, dying.ai).advance(o.run.id, o.userId, null));
      await fabric.hook.hung;
      await new Promise((r) => setTimeout(r, 300));

      // The click reached the page; its result was never recorded. The intent says so.
      const before = (await stepsOf(o.run.id)).filter((s) => s.action === 'click');
      expect(before.map((s) => s.phase)).toEqual(['done', 'intent']);
      expect(before[1]!.args).toMatchObject({ gate: { category: 'payment', label: 'Pay' }, what: "press 'Pay'" });
      expect(fabric.clicks()).toHaveLength(1);

      // The retried job: the model would press Pay again, and a question is the answer.
      const retry = scriptedAi([[pay, ask('Did the payment go through? Press Pay again?')]]);
      expect(await runnerOf(fabric, retry.ai).advance(o.run.id, o.userId, null)).toBe('waiting_human');
      const after = (await stepsOf(o.run.id)).filter((s) => s.action === 'click');
      expect(after.map((s) => [s.phase, s.ok])).toEqual([['done', false], ['unknown', false], ['done', false]]);
      expect(retry.inputs[0]).toMatch(/Step \d+ \(press 'Pay'\) may or may not have happened\. Do not repeat it\. Check the page and the account's recent activity; if you cannot tell, ask the owner\./);
      expect(retry.inputs[0]).toContain('The run was interrupted and continued.');
      // The second click was refused by the gate, not sent; the approval was spent.
      expect(retry.outputs[0]).toMatch(/^Refused:/);
      expect(fabric.clicks()).toHaveLength(1);
      const memory = await memoryOf(o.run.id);
      expect(memory.confirmedTarget ?? null).toBeNull();
      expect(memory.unknownSteps).toEqual([expect.objectContaining({ category: 'payment', label: 'Pay', host: 'secure.pay.example.com' })]);
      // The owner is asked again, and her fresh approval lets one more press through (the attempt is no longer unknown).
      expect(await prisma.question.count({ where: { runId: o.run.id, status: 'pending' } })).toBe(1);
      approve(fabric);
      const last = scriptedAi([[pay, ['finish', { success: true, result: 'Paid.' }]]]);
      expect(await runnerOf(fabric, last.ai).advance(o.run.id, o.userId, null)).toBe('succeeded');
      expect(fabric.clicks()).toHaveLength(2);
      expect((await memoryOf(o.run.id)).unknownSteps ?? []).toEqual([]);
    });

    it('a saved approval for that button does not apply to a target whose last attempt is unknown', async () => {
      const fabric = fakeFabric();
      const o = await owner('saved');
      // The owner ticked "Don't ask again" for Pay on this site.
      const first = scriptedAi([[pay, ask('Pressing Pay sends $10. May I?')], [pay, ['finish', { success: true, result: 'Paid.' }]]]);
      const seed = runnerOf(fabric, first.ai);
      expect(await seed.advance(o.run.id, o.userId, null)).toBe('waiting_human');
      const q = await o.db.question.findFirstOrThrow({ where: { runId: o.run.id, status: 'pending' } });
      await brokerOf(fabric).answer({ id: o.userId }, q.id, { outcome: 'completed', value: 'approve', rememberRule: { enabled: true } as never }, { channel: 'web', rememberAllowed: true });
      expect(await seed.advance(o.run.id, o.userId, null)).toBe('succeeded');

      // A second run: the rule lets Pay through, and the process dies while the click is out.
      const run2 = await o.db.run.create({ data: { userId: o.userId, taskId: o.task.id, goal: 'Pay the bill' } });
      fabric.armHang((a) => a.type === 'click');
      abandon(runnerOf(fabric, scriptedAi([[pay]]).ai).advance(run2.id, o.userId, null));
      await fabric.hook.hung;
      await new Promise((r) => setTimeout(r, 300));
      expect((await stepsOf(run2.id)).filter((s) => s.action === 'click').map((s) => s.phase)).toEqual(['intent']);
      const clicksBefore = fabric.clicks().length;

      const retry = scriptedAi([[pay]]);
      await runnerOf(fabric, retry.ai).advance(run2.id, o.userId, null);
      // The rule would have allowed it; the server asks instead.
      expect(retry.outputs[0]).toMatch(/^Refused:/);
      expect(fabric.clicks()).toHaveLength(clicksBefore);
      expect((await stepsOf(run2.id)).filter((s) => s.action === 'click').map((s) => s.phase)).toEqual(['unknown', 'done']);
    });

    it('killed after the result was recorded: the step is done, nothing is repeated and the run continues', async () => {
      const fabric = fakeFabric();
      const o = await approvedRun('done', fabric);
      const dying = scriptedAi([[pay, ...nav(1)]], { hangAfter: 2 });
      abandon(runnerOf(fabric, dying.ai).advance(o.run.id, o.userId, null));
      await new Promise((r) => setTimeout(r, 1_500));
      expect(fabric.clicks()).toHaveLength(1);
      const mid = await memoryOf(o.run.id);
      expect(mid.confirmedTarget ?? null).toBeNull();
      expect(mid.pendingConfirmation ?? null).toBeNull();

      const retry = scriptedAi([[['finish', { success: true, result: 'Paid.' }]]]);
      expect(await runnerOf(fabric, retry.ai).advance(o.run.id, o.userId, null)).toBe('succeeded');
      const clicks = (await stepsOf(o.run.id)).filter((s) => s.action === 'click');
      expect(clicks.map((s) => [s.phase, s.ok])).toEqual([['done', false], ['done', true]]);
      expect(retry.inputs[0]).not.toMatch(/may or may not have happened/);
      expect(fabric.clicks()).toHaveLength(1);
      // The confirmed action was recorded once.
      expect(await prisma.run.findUniqueOrThrow({ where: { id: o.run.id } }).then((r) => (r.confirmedActions as unknown[]).length)).toBe(1);
    });
  });

  it('commit-class tools: a tool that declares `commits: true` gets an intent record before its action, and a plain tool does not', async () => {
    const seen: boolean[] = [];
    const mk = (commits: boolean) => defineRunTool({ name: commits ? 'sends_something' : 'reads_something', description: 'x', parameters: z.object({}), commits, execute: async () => void seen.push(inCommitTool()) });
    await mk(true).execute({}, { userId: 'u' } as never);
    await mk(false).execute({}, { userId: 'u' } as never);
    expect(seen).toEqual([true, false]);
    expect(inCommitTool()).toBe(false);

    // A typed secret is commit-class: the fabric types it, and its intent row is written first.
    const fabric = fakeFabric();
    const o = await owner('secret');
    const handoffId = randomUUID();
    fabric.handoffs.set(handoffId, { id: handoffId, status: 'completed', input: 'secret', kind: 'code', response: { outcome: 'completed' } });
    await prisma.run.update({ where: { id: o.run.id }, data: { transcript: { log: [], chunks: 0, secretHandoffId: handoffId } as never } });
    const rows: string[] = [];
    const real = fabric.client.request.bind(fabric.client) as (...a: unknown[]) => Promise<unknown>;
    (fabric.client as unknown as { request: unknown }).request = async (...a: unknown[]) => {
      const body = (a[2] as { body?: { action?: { type?: string } } } | undefined)?.body;
      if (body?.action?.type === 'type_secret') rows.push(...(await stepsOf(o.run.id)).map((s) => `${s.action}:${s.phase}`));
      return real(...a);
    };
    const typed = scriptedAi([[['type_handoff_secret', { selector: '#code', submit: false }], ['finish', { success: true, result: 'Done.' }]]]);
    expect(await runnerOf(fabric, typed.ai).advance(o.run.id, o.userId, null)).toBe('succeeded');
    // While the fabric was typing, the intent was already in the database.
    expect(rows).toContain('type:intent');
    expect((await stepsOf(o.run.id)).find((s) => s.action === 'type')).toMatchObject({ phase: 'done' });
  });

  it('two jobs for one run: the one that no longer holds the run stops without sending or writing anything', async () => {
    const o = await owner('lease');
    const fabric = fakeFabric();
    let open!: () => void;
    const gate = new Promise<void>((r) => (open = r));
    let started!: () => void;
    const hasStarted = new Promise<void>((r) => (started = r));
    const slow = scriptedAi([nav(2)], { gate, started });
    const jobA = runnerOf(fabric, slow.ai).advance(o.run.id, o.userId, null);
    await hasStarted;
    // Job B claims the run while A is still in its model call, and does the work.
    const quick = scriptedAi([[...nav(1), ['finish', { success: true, result: 'Done.' }]]]);
    expect(await runnerOf(fabric, quick.ai).advance(o.run.id, o.userId, null)).toBe('succeeded');
    const stepsAfterB = await stepsOf(o.run.id);
    const memoryAfterB = await memoryOf(o.run.id);
    open();
    expect(await jobA).toBe('superseded');
    // A sent nothing and wrote nothing.
    expect(fabric.actions.filter((a) => a.type === 'navigate')).toHaveLength(1);
    expect(slow.outputs.every((t) => t.startsWith('Stop: another job took over this run'))).toBe(true);
    expect((await stepsOf(o.run.id)).map((s) => s.seq)).toEqual(stepsAfterB.map((s) => s.seq));
    expect(await memoryOf(o.run.id)).toEqual(memoryAfterB);
    expect((await prisma.run.findUniqueOrThrow({ where: { id: o.run.id } })).status).toBe('succeeded');
  });

  it('two advance calls started together: both finish, and exactly one acts per action', async () => {
    const o = await owner('race');
    const fabric = fakeFabric();
    const finish: Call = ['finish', { success: true, result: 'Done.' }];
    const a = scriptedAi([[...nav(2), finish]]);
    const b = scriptedAi([[...nav(2), finish]]);
    const outcomes = await Promise.all([runnerOf(fabric, a.ai).advance(o.run.id, o.userId, null), runnerOf(fabric, b.ai).advance(o.run.id, o.userId, null)]);
    // The job that claimed last owns the run; the other stops as superseded, or finds the run already finished.
    for (const r of outcomes) expect(['succeeded', 'superseded']).toContain(r);
    expect(outcomes).toContain('succeeded');
    const rows = await stepsOf(o.run.id);
    // No step was written twice, and the run ended once.
    expect(new Set(rows.map((s) => s.seq)).size).toBe(rows.length);
    expect(rows.filter((s) => s.kind === 'finish')).toHaveLength(1);
    expect((await prisma.run.findUniqueOrThrow({ where: { id: o.run.id } })).workerToken).toBeNull();
  });

  it('an answer that arrives while the worker is down is applied exactly once after the restart', async () => {
    const fabric = fakeFabric();
    const o = await owner('answer');
    enqueued.length = 0;
    const first = scriptedAi([[pay, ask('Pressing Pay sends $10. May I?')]]);
    expect(await runnerOf(fabric, first.ai).advance(o.run.id, o.userId, null)).toBe('waiting_human');
    const waitingMemory = (await prisma.run.findUniqueOrThrow({ where: { id: o.run.id } })).transcript;
    const waiting = await prisma.run.findUniqueOrThrow({ where: { id: o.run.id } });
    // The worker is down: the owner answers, and the answer enqueues one job.
    const q = await o.db.question.findFirstOrThrow({ where: { runId: o.run.id, status: 'pending' } });
    await brokerOf(fabric).answer({ id: o.userId }, q.id, { outcome: 'completed', value: 'approve' }, { channel: 'web', rememberAllowed: false });
    expect(enqueued.filter((j) => j.reason === 'handoff_answered')).toHaveLength(1);

    // The job starts, folds the answer, and the process dies in its first model call.
    const dying = scriptedAi([[...nav(1)]], { hangAfter: 1 });
    abandon(runnerOf(fabric, dying.ai).advance(o.run.id, o.userId, null));
    await new Promise((r) => setTimeout(r, 1_000));
    const mid = await prisma.run.findUniqueOrThrow({ where: { id: o.run.id } });
    expect(mid.status).toBe('running');

    // The retried job does not fold it again.
    const retry = scriptedAi([[['finish', { success: true, result: 'Done.' }]]]);
    expect(await runnerOf(fabric, retry.ai).advance(o.run.id, o.userId, null)).toBe('succeeded');
    const memory = await memoryOf(o.run.id);
    expect(memory.log.filter((l) => l === 'The person approved.')).toHaveLength(1);
    expect(await prisma.runStep.count({ where: { runId: o.run.id, kind: 'handoff', action: 'answered' } })).toBe(1);
    expect(enqueued.filter((j) => j.reason === 'handoff_answered')).toHaveLength(1);

    // And a job that died before the run left `waiting_human` folds the same answer again without a second `answered` step.
    await prisma.run.update({ where: { id: o.run.id }, data: { status: 'waiting_human', handoffId: waiting.handoffId, transcript: waitingMemory as never, finishedAt: null, result: null, stopReason: null } });
    const again = scriptedAi([[['finish', { success: true, result: 'Done.' }]]]);
    await runnerOf(fabric, again.ai).advance(o.run.id, o.userId, null);
    expect(await prisma.runStep.count({ where: { runId: o.run.id, kind: 'handoff', action: 'answered' } })).toBe(1);
  });

  it('the per-action save is one write: the step row and the run update share one transaction, and nothing else per action', async () => {
    const o = await owner('count');
    await prisma.task.update({ where: { id: o.task.id }, data: { confirmRiskyActions: false } });
    const log: string[] = [];
    const WRITES = new Set(['create', 'createMany', 'update', 'updateMany', 'upsert', 'delete', 'deleteMany']);
    const wrap = (target: object, path: string): unknown =>
      new Proxy(target, {
        get(t, p) {
          const v = Reflect.get(t, p, t) as unknown;
          if (typeof p !== 'string') return v;
          if (typeof v === 'function') {
            const fn = (v as (...a: unknown[]) => unknown).bind(t);
            if (p === '$transaction') return (cb: unknown, ...rest: unknown[]) => (typeof cb === 'function' ? fn((tx: object) => (cb as (x: unknown) => unknown)(wrap(tx, 'tx:'))) : fn(cb, ...rest));
            if (p === 'forUser') return (...a: unknown[]) => wrap(fn(...a) as object, path);
            if (WRITES.has(p)) return (...a: unknown[]) => (log.push(`${path}${p}${(a[0] as { data?: { transcript?: unknown } } | undefined)?.data?.transcript !== undefined ? ':memory' : ''}`), fn(...a));
            return fn;
          }
          if (v && typeof v === 'object' && !p.startsWith('$')) return wrap(v as object, `${path}${p}.`);
          return v;
        },
      });
    const counted = wrap(prisma, '') as PrismaService;
    const fabric = fakeFabric();
    const { ai } = scriptedAi([[...nav(3), ['finish', { success: true, result: 'Done.' }]]]);
    expect(await runnerOf(fabric, ai, counted).advance(o.run.id, o.userId, null)).toBe('succeeded');
    // Per recorded action (three navigations and the finish): one run update and one step row, inside one transaction.
    expect(log.filter((l) => l === 'tx:run.updateMany:memory')).toHaveLength(4);
    expect(log.filter((l) => l === 'tx:runStep.create')).toHaveLength(4);
    // No separate memory save per action: outside the transactions the memory is written only at the chunk's boundaries.
    expect(log.filter((l) => l === 'run.updateMany:memory').length).toBeLessThanOrEqual(2);
    // The only step rows outside the transactions are the trace's own (the closing step), never an action's.
    expect(log.filter((l) => l === 'runStep.create').length).toBeLessThanOrEqual(1);
  });

  describe('observability', () => {
    it('counts a recovery with its unknown steps, logs it, and counts it on the run', async () => {
      const metrics = app.get(TasksService).metrics;
      const recovered = jest.spyOn(metrics, 'recovered');
      const warn = jest.spyOn(Logger.prototype, 'warn');
      try {
        const fabric = fakeFabric();
        const o = await owner('metric');
        abandon(runnerOf(fabric, scriptedAi([nav(2)], { hangAfter: 2 }).ai).advance(o.run.id, o.userId, null));
        await new Promise((r) => setTimeout(r, 1_000));
        await runnerOf(fabric, scriptedAi([[['finish', { success: true, result: 'Done.' }]]]).ai).advance(o.run.id, o.userId, null);
        expect(recovered).toHaveBeenCalledWith(0);
        expect(warn.mock.calls.some(([m]) => String(m).includes(`run ${o.run.id}: recovered after an interruption, 0 step(s) reconciled, 0 unknown`))).toBe(true);
        expect((await prisma.run.findUniqueOrThrow({ where: { id: o.run.id } })).recoveries).toBe(1);

        // With a step left unknown the label is 1+.
        const withUnknown = await approvedRun('metric-unknown', fabric);
        fabric.armHang((a) => a.type === 'click');
        abandon(runnerOf(fabric, scriptedAi([[pay]]).ai).advance(withUnknown.run.id, withUnknown.userId, null));
        await fabric.hook.hung;
        await new Promise((r) => setTimeout(r, 300));
        await runnerOf(fabric, scriptedAi([[['finish', { success: false, result: 'Unsure.' }]]]).ai).advance(withUnknown.run.id, withUnknown.userId, null);
        expect(recovered).toHaveBeenCalledWith(1);
      } finally {
        recovered.mockRestore();
        warn.mockRestore();
      }
    });
    async function approvedRun(label: string, fabric: Fabric) {
      const o = await owner(label);
      expect(await runnerOf(fabric, scriptedAi([[pay, ask('Pressing Pay sends $10. May I?')]]).ai).advance(o.run.id, o.userId, null)).toBe('waiting_human');
      approve(fabric);
      return o;
    }

    it('the alert fires for a run recovered more than three times, and the rule is seeded', async () => {
      const o = await owner('alert');
      await prisma.run.update({ where: { id: o.run.id }, data: { recoveries: 4 } });
      const service = app.get(HexactraAlertsService);
      setAlertSources(service.sources);
      try {
        const out = await runRecoveredKind.evaluate({ now: new Date() } as never, { name: 'Run keeps being interrupted', config: { minRecoveries: 4, windowHours: 24 } } as never);
        const mine = (out as { labels: Record<string, string>; breached: boolean; value: number; summary: string }[]).find((x) => x.labels['run.id'] === o.run.id);
        expect(mine).toMatchObject({ breached: true, value: 4 });
        expect(mine!.summary).toContain('was recovered after an interruption 4 times');
      } finally {
        setAlertSources(null);
      }
      expect(await prisma.alertRule.findUnique({ where: { key: 'hexactra.run_recovered' } })).toMatchObject({ kind: HEXACTRA_ALERT_KINDS.RUN_RECOVERED, enabled: true, config: { minRecoveries: 4, windowHours: 24 } });
      // Run retention keeps the runs this rule reads.
      expect(RUN_READING_ALERT_KINDS).toContain('hexactra_run_recovered');
    });
  });
});
