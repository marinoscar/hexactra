// Pause and Resume (E38.2, #583), against a real database with a scripted model and an in-memory fabric: a pause during a chunk
// stops further actions and keeps the browser, active time and budgets do not move while paused, Resume continues from the
// saved memory with a fresh look, a pause while waiting for a person takes effect once the answer is in, a dead session is
// replaced, a run paused too long is cancelled, and the two routes' errors and permissions.
import { randomUUID } from 'node:crypto';
import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import { AiError, type AiService } from '@marinoscar/platform-api/ai';
import { SystemSettingsService } from '@marinoscar/platform-api/settings';

import { createApp } from '../src/main';
import { PrismaService } from '../src/prisma/prisma.service';
import type { FabricClient } from '../src/fabric/fabric.client';
import { FabricError } from '../src/fabric/fabric.client';
import { GoalRunnerService, pausedFor } from '../src/runner/goal-runner.service';
import { PAUSED_TEXT } from '../src/runner/stop-signal';
import { activeElapsedMs } from '../src/runner/active-time';
import { RunPauseService, STILL_PAUSED_AFTER_MS } from '../src/tasks/run-pause.service';
import { TasksService } from '../src/tasks/tasks.service';

let app: NestFastifyApplication;
const stamp = `${Date.now()}`;
const tick = (ms: number) => new Promise((r) => setTimeout(r, ms));

beforeAll(async () => {
  app = await createApp();
  await app.init();
  await app.getHttpAdapter().getInstance().ready();
});
afterAll(async () => {
  await app?.close();
});

async function loginAs(email: string, role = 'contributor'): Promise<{ id: string; token: string }> {
  const res = await app.inject({ method: 'POST', url: '/api/auth/test/login', payload: { email, role } });
  const token = new URL(String(res.headers.location)).searchParams.get('token')!;
  const me = await app.inject({ method: 'GET', url: '/api/auth/me', headers: { authorization: `Bearer ${token}` } });
  return { id: me.json<{ data: { id: string } }>().data.id, token };
}

/** An in-memory fabric with sessions that can end, actions and handoffs. */
function fakeFabric() {
  const actions: Record<string, unknown>[] = [];
  const handoffs = new Map<string, { id: string; status: string; input: string; kind: string; response?: { outcome?: string; value?: string; value_withheld: boolean } }>();
  const created: Record<string, unknown>[] = [];
  const shots: Record<string, unknown>[] = [];
  const sessions = new Map<string, string>();
  let ended = 0;
  const request = jest.fn(async (method: string, path: string, opts: { body?: Record<string, unknown>; signal?: AbortSignal } = {}) => {
    if (method === 'POST' && path === '/v1/sessions') {
      const id = randomUUID();
      sessions.set(id, 'active');
      created.push(opts.body ?? {});
      return { id };
    }
    if (method === 'GET' && path.startsWith('/v1/sessions/')) {
      const status = sessions.get(path.split('/')[3]!);
      if (!status) throw new FabricError('api', 'unknown session', 404, 'not_found');
      return { id: path.split('/')[3], status };
    }
    if (method === 'DELETE' && path.startsWith('/v1/sessions/')) return void (ended += 1);
    if (method === 'POST' && path.endsWith('/actions')) {
      const action = opts.body!.action as Record<string, unknown>;
      if (action.type === 'screenshot') shots.push(action);
      else actions.push(action);
      if (action.type === 'navigate') return { id: 'op', state: 'succeeded', result: { url: action.url, title: 'Shop' } };
      return { id: 'op', state: 'succeeded', result: {} };
    }
    if (method === 'POST' && path.endsWith('/handoffs')) {
      const id = randomUUID();
      handoffs.set(id, { id, status: 'pending', input: String(opts.body!.input), kind: String(opts.body!.kind) });
      return { handoff: { id } };
    }
    if (method === 'GET' && path.startsWith('/v1/handoffs/')) return handoffs.get(path.split('/')[3]!);
    throw new Error(`unexpected ${method} ${path}`);
  });
  return { client: { request, config: async () => ({ url: 'http://f', token: 't' }) } as unknown as FabricClient, actions, shots, handoffs, created, sessions, ended: () => ended };
}

type Call = [name: string, args: Record<string, unknown>];
type Tool = { tool: { name: string }; execute: (a: unknown, c: unknown) => Promise<unknown> };
type Req = { tools: Tool[]; onStep?: (s: unknown) => void; input?: unknown };
type Opts = { signal?: AbortSignal } | undefined;

const abortedAfter = (signal: AbortSignal | undefined, from: number, ms: number) =>
  new Promise<number>((resolve, reject) => {
    if (!signal) return reject(new Error('the runner passed no signal'));
    if (signal.aborted) return resolve(Date.now() - from);
    const timer = setTimeout(() => reject(new Error(`not aborted within ${ms} ms`)), ms);
    signal.addEventListener('abort', () => {
      clearTimeout(timer);
      resolve(Date.now() - from);
    });
  });

/** A model making the scripted tool calls, one script per runTools call, each followed by a model step of 10 + 5 tokens. It records every input. */
function scriptedAi(scripts: Call[][], hooks: { afterTool?: (index: number, signal: AbortSignal | undefined) => Promise<void>; before?: (req: Req, opts: Opts) => Promise<void> } = {}) {
  const outputs: string[] = [];
  const inputs: string[] = [];
  const runTools = jest.fn(async (req: Req, opts: Opts) => {
    inputs.push(JSON.stringify(req.input));
    await hooks.before?.(req, opts);
    const script = scripts.shift() ?? [];
    let step = 0;
    for (const [name, args] of script) {
      const t = req.tools.find((x) => x.tool.name === name)!;
      outputs.push(String(await t.execute(args, { userId: 'u' })));
      req.onStep?.({ step: ++step, response: { usage: { inputTokens: 10, outputTokens: 5 } }, calls: [] });
      await hooks.afterTool?.(step, opts?.signal);
    }
    return { final: { outputText: '' }, steps: [], stopReason: 'steps_exhausted' };
  });
  return { ai: { forUser: () => ({ runTools }) } as unknown as AiService, runTools, outputs, inputs };
}

/** An `afterTool` hook: the owner presses Pause after tool `n`, and the hook waits for the model call in flight to be aborted. */
const pauseAfter = (n: number, pauses: RunPauseService, userId: string, runId: string) => async (step: number, signal: AbortSignal | undefined) => {
  if (step !== n) return;
  await pauses.pause(userId, runId);
  await abortedAfter(signal, Date.now(), 3_000);
};

const nav = (n: number, from = 0): Call[] => Array.from({ length: n }, (_, i): Call => ['navigate', { url: `https://shop.example.test/${from + i}`, reason: 'go' }]);
const finish = (): Call => ['finish', { success: true, result: 'Done.' }];

async function setup(label: string, columns: Record<string, unknown> = {}) {
  const user = await loginAs(`pause-${label}-${stamp}@example.test`);
  const prisma = app.get(PrismaService);
  const db = prisma.forUser({ userId: user.id });
  const run = await db.run.create({ data: { userId: user.id, goal: 'Browse the shop', ...columns } });
  const tasks = app.get(TasksService);
  const fabric = fakeFabric();
  const enqueued: { type: string; reason: string }[] = [];
  const notifier = { needsYou: jest.fn(async () => undefined), finished: jest.fn(async () => undefined), started: jest.fn(async () => undefined), stillPaused: jest.fn(async () => undefined) };
  // The API's own service, over this test's fabric and a queue that only records (the app's worker would run a real job).
  const pauses = new RunPauseService(prisma, tasks, { enqueue: async (j: { type: string; reason: string }) => void enqueued.push(j) } as never, notifier as never, fabric.client, app.get(SystemSettingsService));
  const runnerWith = (ai: AiService) => new GoalRunnerService(prisma, tasks, fabric.client, ai, notifier as never, undefined, app.get(SystemSettingsService));
  return { userId: user.id, token: user.token, prisma, db, run, tasks, fabric, pauses, enqueued, notifier, runnerWith };
}

describe('Pause and Resume (E38.2)', () => {
  it('stops further actions of a chunk, pauses the run, keeps the browser, and neither active time nor budgets move while paused', async () => {
    const { userId, db, run, pauses, fabric, runnerWith } = await setup('chunk');
    let heard = -1;
    const { ai, outputs } = scriptedAi([nav(5)], {
      afterTool: async (step, signal) => {
        if (step !== 2) return;
        const pressed = Date.now();
        await pauses.pause(userId, run.id);
        // The model call in flight is aborted by the pause (the haltSignal), well inside the poll interval.
        heard = await abortedAfter(signal, pressed, 3_000);
      },
    });
    expect(await runnerWith(ai).advance(run.id, userId, null)).toBe('paused');
    expect(heard).toBeLessThan(1_500);

    // Only the first two actions reached the browser; the third came back as paused, and the fourth and fifth never started.
    expect(fabric.actions.map((a) => a.type)).toEqual(['navigate', 'navigate']);
    expect(outputs[2]).toBe(PAUSED_TEXT);
    expect(outputs).toHaveLength(3);

    const paused = await db.run.findFirstOrThrow({ where: { id: run.id } });
    expect(paused).toMatchObject({ status: 'paused', pauseRequested: true, stepCount: 2, activeSince: null, cancelRequested: false, workerToken: null, handoffId: null });
    // The browser stays where it is: the session was not released.
    expect(paused.sessionId).not.toBeNull();
    expect(fabric.ended()).toBe(0);
    expect(paused.pausedAt).not.toBeNull();
    // The usage of the chunk is recorded (a model step after each of the three tools), and nothing was finished.
    expect(paused).toMatchObject({ modelCalls: 3, inputTokens: 30, outputTokens: 15, result: null, finishedAt: null });
    expect(paused.transcript).toMatchObject({ log: expect.any(Array) });

    // Active time does not grow while paused: an hour later it is the same.
    const later = Date.now() + 3_600_000;
    expect(activeElapsedMs(paused, later)).toBe(paused.activeMs);
    await tick(30);
    expect((await db.run.findFirstOrThrow({ where: { id: run.id } })).activeMs).toBe(paused.activeMs);

    // A late job (a handoff check) that finds the run paused does nothing.
    const late = scriptedAi([nav(1)]);
    expect(await runnerWith(late.ai).advance(run.id, userId, null)).toBe('paused');
    expect(late.runTools).not.toHaveBeenCalled();
  });

  it('resumes from the saved memory with the pause note and a fresh look, delivers guidance sent while paused, and keeps the budget counters', async () => {
    const { userId, prisma, db, run, pauses, fabric, enqueued, runnerWith } = await setup('resume');
    const chat = await db.conversation.create({ data: { userId, title: 'Shop' } });
    await db.run.updateMany({ where: { id: run.id }, data: { trigger: 'chat', conversationId: chat.id } });
    const first = scriptedAi([nav(3)], { afterTool: pauseAfter(1, pauses, userId, run.id) });
    expect(await runnerWith(first.ai).advance(run.id, userId, null)).toBe('paused');
    const before = await db.run.findFirstOrThrow({ where: { id: run.id } });
    expect(before).toMatchObject({ status: 'paused', stepCount: 1 });
    // Five minutes pass. Guidance typed in the chat while paused is queued.
    await db.run.updateMany({ where: { id: run.id }, data: { pausedAt: new Date(Date.now() - 5 * 60_000) } });
    await prisma.runGuidance.create({ data: { runId: run.id, conversationId: chat.id, messageSeq: 4, note: 'Prefer the blue one.' } });

    const resumed = await pauses.resume(userId, run.id, null);
    expect(resumed).toMatchObject({ status: 'queued', pauseRequested: false });
    expect(enqueued).toEqual([expect.objectContaining({ type: 'browser.goal.run', reason: 'resumed' })]);

    const second = scriptedAi([[...nav(1, 10), finish()]]);
    expect(await runnerWith(second.ai).advance(run.id, userId, null)).toBe('succeeded');
    const done = await db.run.findFirstOrThrow({ where: { id: run.id } });
    // Continues from the saved memory (the first step is still in the log), with the note, the guidance and a request for a fresh look.
    const input = second.inputs[0]!;
    expect(input).toContain('1. navigate');
    expect(input).toContain('The owner paused the run and resumed it after 5 minutes. Look at the page again before acting.');
    expect(input).toContain('Prefer the blue one.');
    expect(fabric.shots.length).toBeGreaterThan(0);
    expect(done).toMatchObject({ status: 'succeeded', stepCount: 3, pausedAt: null, modelCalls: before.modelCalls + 2 });
    // The pause did not cost a budget: the first job's counters carried over, and the second added only its own.
    expect(done.inputTokens).toBe(before.inputTokens + 20);
  });

  it('pauses a run waiting for a person once the question is answered, before the agent acts on the answer', async () => {
    const { userId, db, run, pauses, fabric, runnerWith } = await setup('waiting');
    const asked = scriptedAi([[['request_human', { kind: 'code', prompt: 'Enter the code', input: 'text', choices: null }]]]);
    expect(await runnerWith(asked.ai).advance(run.id, userId, null)).toBe('waiting_human');
    const waiting = await db.run.findFirstOrThrow({ where: { id: run.id } });
    expect(waiting.status).toBe('waiting_human');

    // Pause while it waits: the flag is set and the run keeps waiting (the question is still open).
    const view = await pauses.pause(userId, run.id);
    expect(view).toMatchObject({ status: 'waiting_human', pauseRequested: true });
    const idle = scriptedAi([nav(1)]);
    expect(await runnerWith(idle.ai).advance(run.id, userId, null)).toBe('waiting_human');

    // The owner answers: nothing is done with the answer, the run pauses.
    const h = fabric.handoffs.get(waiting.handoffId!)!;
    h.status = 'completed';
    h.response = { outcome: 'completed', value: '4821', value_withheld: false };
    const actionsBefore = fabric.actions.length;
    const after = scriptedAi([nav(1)]);
    expect(await runnerWith(after.ai).advance(run.id, userId, null)).toBe('paused');
    expect(after.runTools).not.toHaveBeenCalled();
    expect(fabric.actions).toHaveLength(actionsBefore);
    const paused = await db.run.findFirstOrThrow({ where: { id: run.id } });
    expect(paused).toMatchObject({ status: 'paused', handoffId: null, remindAt: null });
    expect(JSON.stringify(paused.transcript)).toContain('4821');
    expect(paused.sessionId).not.toBeNull();

    // Resume: the answer is in the memory, the run continues from it.
    await pauses.resume(userId, run.id, null);
    const resumed = scriptedAi([[...nav(1), finish()]]);
    expect(await runnerWith(resumed.ai).advance(run.id, userId, null)).toBe('succeeded');
    expect(resumed.inputs[0]).toContain('4821');
    expect(resumed.inputs[0]).toContain('The owner paused the run and resumed it after');
  });

  it('pauses at the start of a job that finds the request (a job hop, or a queued run), with no model call and no action', async () => {
    const hop = await setup('hop', { status: 'running', startedAt: new Date(), activeSince: new Date(Date.now() - 1_000), pauseRequested: true });
    const ai = scriptedAi([nav(1)]);
    expect(await hop.runnerWith(ai.ai).advance(hop.run.id, hop.userId, null)).toBe('paused');
    expect(ai.runTools).not.toHaveBeenCalled();
    expect(hop.fabric.actions).toEqual([]);
    expect(await hop.db.run.findFirstOrThrow({ where: { id: hop.run.id } })).toMatchObject({ status: 'paused', activeSince: null });
    // The time it ran counts, the time it was paused does not.
    expect((await hop.db.run.findFirstOrThrow({ where: { id: hop.run.id } })).activeMs).toBeGreaterThan(0);

    // A queued run that was paused before its first job: it never started.
    const queued = await setup('queued', { pauseRequested: true });
    const q = scriptedAi([nav(1)]);
    expect(await queued.runnerWith(q.ai).advance(queued.run.id, queued.userId, null)).toBe('paused');
    expect(q.runTools).not.toHaveBeenCalled();
    expect(queued.notifier.started).not.toHaveBeenCalled();
    expect(await queued.db.run.findFirstOrThrow({ where: { id: queued.run.id } })).toMatchObject({ status: 'paused', startedAt: null, sessionId: null });
  });

  it('pauses instead of handing the run to a continuation job when the pause came before the hop', async () => {
    const { userId, prisma, db, run, tasks, fabric } = await setup('hopdue');
    let now = Date.now();
    const { ai } = scriptedAi([nav(2)], {
      afterTool: async (step) => {
        if (step !== 1) return;
        // No event reaches this process (another API instance): the database flag only, and the runtime limit is near.
        await db.run.updateMany({ where: { id: run.id }, data: { pauseRequested: true } });
        now += 29 * 60_000;
      },
    });
    const runner = new GoalRunnerService(prisma, tasks, fabric.client, ai, undefined, undefined, app.get(SystemSettingsService));
    runner.clock = () => now;
    expect(await runner.advance(run.id, userId, null)).toBe('paused');
    expect(await db.run.findFirstOrThrow({ where: { id: run.id } })).toMatchObject({ status: 'paused', stepCount: 1 });
  });

  it('opens a new session on the same profile when the paused run\'s browser session is gone, and says so in the log', async () => {
    const { userId, db, run, pauses, fabric, runnerWith } = await setup('dead', { profile: 'work' });
    const first = scriptedAi([nav(2)], { afterTool: pauseAfter(1, pauses, userId, run.id) });
    expect(await runnerWith(first.ai).advance(run.id, userId, null)).toBe('paused');
    const oldSession = (await db.run.findFirstOrThrow({ where: { id: run.id } })).sessionId!;
    expect(fabric.created).toHaveLength(1);
    // The session ended while paused (the host restarted).
    fabric.sessions.set(oldSession, 'ended');

    await pauses.resume(userId, run.id, null);
    const second = scriptedAi([[finish()]]);
    expect(await runnerWith(second.ai).advance(run.id, userId, null)).toBe('succeeded');
    expect(fabric.created).toHaveLength(2);
    expect(fabric.created[1]).toMatchObject({ profile: 'work' });
    expect(second.inputs[0]).toContain('The browser session was restarted while paused');
    expect((await db.run.findFirstOrThrow({ where: { id: run.id } })).sessionId).not.toBe(oldSession);
  });

  it('keeps a live session on resume: no second browser is opened', async () => {
    const { userId, run, pauses, fabric, runnerWith } = await setup('alive');
    const first = scriptedAi([nav(2)], { afterTool: pauseAfter(1, pauses, userId, run.id) });
    expect(await runnerWith(first.ai).advance(run.id, userId, null)).toBe('paused');
    await pauses.resume(userId, run.id, null);
    const second = scriptedAi([[finish()]]);
    expect(await runnerWith(second.ai).advance(run.id, userId, null)).toBe('succeeded');
    expect(fabric.created).toHaveLength(1);
    expect(second.inputs[0]).not.toContain('restarted while paused');
  });

  it('Stop wins over Pause: a run paused or pausing is cancelled by Stop, and a paused run\'s browser is released', async () => {
    const { userId, db, run, pauses, tasks, fabric, runnerWith } = await setup('stop');
    const first = scriptedAi([nav(2)], { afterTool: pauseAfter(1, pauses, userId, run.id) });
    expect(await runnerWith(first.ai).advance(run.id, userId, null)).toBe('paused');
    // The API's own cancel talks to the app's fabric; this test's service talks to its own.
    const shared = app.get(TasksService);
    const cancelling = new TasksService(app.get(PrismaService), shared.metrics, fabric.client, undefined, undefined, shared.events, shared.endHooks);
    const view = await cancelling.cancel(userId, run.id);
    expect(view).toMatchObject({ status: 'cancelled', stopReason: 'cancelled' });
    expect(fabric.ended()).toBe(1);
    expect(await db.run.findFirstOrThrow({ where: { id: run.id } })).toMatchObject({ status: 'cancelled' });
    void tasks;
  });

  describe('the paused-run sweep', () => {
    it('tells the owner once after an hour, and never sooner', async () => {
      const { userId, db, run, pauses, notifier } = await setup('notice', { status: 'paused', startedAt: new Date(), pauseRequested: true, pausedAt: new Date() });
      expect(await pauses.sweep()).toEqual({ notified: 0, cancelled: 0 });
      await db.run.updateMany({ where: { id: run.id }, data: { pausedAt: new Date(Date.now() - STILL_PAUSED_AFTER_MS - 60_000) } });
      expect(await pauses.sweep()).toEqual({ notified: 1, cancelled: 0 });
      expect(notifier.stillPaused).toHaveBeenCalledWith(userId, expect.objectContaining({ id: run.id, goal: 'Browse the shop' }));
      expect(await pauses.sweep()).toEqual({ notified: 0, cancelled: 0 });
      expect(await db.run.findFirstOrThrow({ where: { id: run.id } })).toMatchObject({ status: 'paused' });
    });

    it('cancels a run paused longer than runs.maxPausedHours (default 72) with the reason and a notification, and releases its browser', async () => {
      const { userId, db, run, pauses, notifier, fabric } = await setup('expire', { status: 'paused', startedAt: new Date(), pauseRequested: true, sessionId: randomUUID(), pausedAt: new Date(Date.now() - 73 * 3_600_000) });
      const young = await db.run.create({ data: { userId, goal: 'Another', status: 'paused', pauseRequested: true, pausedAt: new Date(Date.now() - 71 * 3_600_000) } });
      expect(await pauses.maxPausedHours()).toBe(72);
      const out = await pauses.sweep();
      expect(out.cancelled).toBeGreaterThanOrEqual(1);
      const row = await db.run.findFirstOrThrow({ where: { id: run.id } });
      expect(row).toMatchObject({ status: 'cancelled', stopReason: 'cancelled' });
      expect(row.error).toMatch(/^Paused too long/);
      expect(notifier.finished).toHaveBeenCalledWith(userId, expect.objectContaining({ id: run.id }), 'cancelled', expect.stringContaining('Paused too long'));
      expect(fabric.client.request).toHaveBeenCalledWith('DELETE', expect.stringContaining('/v1/sessions/'));
      // 71 hours is inside the limit: told, not cancelled.
      expect((await db.run.findFirstOrThrow({ where: { id: young.id } })).status).toBe('paused');
    });
  });
});

describe('POST /api/runs/{id}/pause and /resume', () => {
  const auth = (t: string) => ({ authorization: `Bearer ${t}` });
  let resumeJobs: { type: string; reason: string }[];

  beforeAll(() => {
    // The app's queue would start a real job on Resume: only record what is enqueued.
    resumeJobs = [];
    Object.assign(app.get(RunPauseService), { jobs: { enqueue: async (j: { type: string; reason: string }) => void resumeJobs.push(j) } });
  });

  it('pauses a running run (flag set, status unchanged until the runner acts), is idempotent, and 409s on a finished one', async () => {
    const { userId, token, db } = await (async () => {
      const u = await loginAs(`pause-api-${stamp}@example.test`);
      return { userId: u.id, token: u.token, db: app.get(PrismaService).forUser({ userId: u.id }) };
    })();
    const running = await db.run.create({ data: { userId, goal: 'G', status: 'running', startedAt: new Date(), activeSince: new Date() } });
    const res = await app.inject({ method: 'POST', url: `/api/runs/${running.id}/pause`, headers: auth(token) });
    expect(res.statusCode).toBe(200);
    expect(res.json<{ data: Record<string, unknown> }>().data).toMatchObject({ id: running.id, status: 'running', pauseRequested: true });
    const again = await app.inject({ method: 'POST', url: `/api/runs/${running.id}/pause`, headers: auth(token) });
    expect(again.statusCode).toBe(200);

    // Already paused: answered unchanged.
    const paused = await db.run.create({ data: { userId, goal: 'G2', status: 'paused', pauseRequested: true, pausedAt: new Date() } });
    const unchanged = await app.inject({ method: 'POST', url: `/api/runs/${paused.id}/pause`, headers: auth(token) });
    expect(unchanged.statusCode).toBe(200);
    expect(unchanged.json<{ data: { status: string } }>().data.status).toBe('paused');

    // A run waiting for a person: the flag is set, the status stays.
    const waiting = await db.run.create({ data: { userId, goal: 'G3', status: 'waiting_human', waitingSince: new Date() } });
    const w = await app.inject({ method: 'POST', url: `/api/runs/${waiting.id}/pause`, headers: auth(token) });
    expect(w.json<{ data: Record<string, unknown> }>().data).toMatchObject({ status: 'waiting_human', pauseRequested: true });

    for (const status of ['succeeded', 'failed', 'cancelled'] as const) {
      const done = await db.run.create({ data: { userId, goal: 'G4', status, finishedAt: new Date() } });
      const r = await app.inject({ method: 'POST', url: `/api/runs/${done.id}/pause`, headers: auth(token) });
      expect(r.statusCode).toBe(409);
      expect(r.json<{ code: string }>().code).toBe('RUN_FINISHED');
    }

    // An external agent drives its own run.
    const external = await db.run.create({ data: { userId, goal: 'G5', status: 'running', trigger: 'external' } });
    const ext = await app.inject({ method: 'POST', url: `/api/runs/${external.id}/pause`, headers: auth(token) });
    expect(ext.statusCode).toBe(409);
    expect(ext.json<{ code: string }>().code).toBe('RUN_NOT_PAUSABLE');
  });

  it('resumes a paused run to queued with a `resumed` job, and 409s when it is not paused', async () => {
    const u = await loginAs(`resume-api-${stamp}@example.test`);
    const db = app.get(PrismaService).forUser({ userId: u.id });
    const paused = await db.run.create({ data: { userId: u.id, goal: 'G', status: 'paused', startedAt: new Date(), pauseRequested: true, pausedAt: new Date() } });
    const res = await app.inject({ method: 'POST', url: `/api/runs/${paused.id}/resume`, headers: auth(u.token) });
    expect(res.statusCode).toBe(200);
    expect(res.json<{ data: Record<string, unknown> }>().data).toMatchObject({ id: paused.id, status: 'queued', pauseRequested: false });
    expect(resumeJobs).toContainEqual(expect.objectContaining({ type: 'browser.goal.run', reason: 'resumed' }));

    for (const status of ['queued', 'running', 'waiting_human', 'succeeded'] as const) {
      const r = await db.run.create({ data: { userId: u.id, goal: 'G', status } });
      const out = await app.inject({ method: 'POST', url: `/api/runs/${r.id}/resume`, headers: auth(u.token) });
      expect(out.statusCode).toBe(409);
      expect(out.json<{ code: string }>().code).toBe('RUN_NOT_PAUSED');
    }
  });

  it('is `runs:write` only, and another user\'s run is a 404', async () => {
    const owner = await loginAs(`pause-owner-${stamp}@example.test`);
    const other = await loginAs(`pause-other-${stamp}@example.test`);
    const viewer = await loginAs(`pause-viewer-${stamp}@example.test`, 'viewer');
    const run = await app.get(PrismaService).forUser({ userId: owner.id }).run.create({ data: { userId: owner.id, goal: 'Mine', status: 'running' } });
    for (const route of ['pause', 'resume']) {
      expect((await app.inject({ method: 'POST', url: `/api/runs/${run.id}/${route}`, headers: auth(other.token) })).statusCode).toBe(404);
      expect((await app.inject({ method: 'POST', url: `/api/runs/${run.id}/${route}`, headers: auth(viewer.token) })).statusCode).toBe(403);
      expect((await app.inject({ method: 'POST', url: `/api/runs/${run.id}/${route}` })).statusCode).toBe(401);
    }
    expect((await app.get(PrismaService).forUser({ userId: owner.id }).run.findFirstOrThrow({ where: { id: run.id } })).pauseRequested).toBe(false);
  });

  it('counts a paused run as live: GET /runs?state=live, /runs/counts and the status filter', async () => {
    const u = await loginAs(`pause-live-${stamp}@example.test`);
    const db = app.get(PrismaService).forUser({ userId: u.id });
    const paused = await db.run.create({ data: { userId: u.id, goal: 'Paused one', status: 'paused', pausedAt: new Date() } });
    await db.run.create({ data: { userId: u.id, goal: 'Finished one', status: 'succeeded', finishedAt: new Date() } });
    const live = await app.inject({ method: 'GET', url: '/api/runs?state=live', headers: auth(u.token) });
    expect(live.json<{ data: { id: string }[] }>().data.map((r) => r.id)).toEqual([paused.id]);
    const byStatus = await app.inject({ method: 'GET', url: '/api/runs?status=paused', headers: auth(u.token) });
    expect(byStatus.json<{ data: { id: string }[] }>().data.map((r) => r.id)).toEqual([paused.id]);
    const finished = await app.inject({ method: 'GET', url: '/api/runs?state=finished', headers: auth(u.token) });
    expect(finished.json<{ data: { id: string }[] }>().data.map((r) => r.id)).not.toContain(paused.id);
    const counts = await app.inject({ method: 'GET', url: '/api/runs/counts', headers: auth(u.token) });
    expect(counts.json<{ data: { live: number; total: number; byStatus: Record<string, number> } }>().data).toMatchObject({ live: 1, total: 2, byStatus: { paused: 1, succeeded: 1 } });
    // A live run is never deleted, a paused one included.
    const del = await app.inject({ method: 'POST', url: '/api/runs/delete', headers: auth(u.token), payload: { ids: [paused.id] } });
    expect(del.json<{ data: { deleted?: number; skippedLive?: string[] } }>().data).toMatchObject({ skippedLive: [paused.id] });
  });
});

describe('pausedFor', () => {
  it('words how long a run was paused for the model', () => {
    expect(pausedFor(10_000)).toBe('less than a minute');
    expect(pausedFor(60_000)).toBe('1 minute');
    expect(pausedFor(5 * 60_000)).toBe('5 minutes');
    expect(pausedFor(3 * 3_600_000)).toBe('3 hours');
  });
});

void AiError;
