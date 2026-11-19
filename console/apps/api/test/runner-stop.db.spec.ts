// Stop within seconds (E38.1, #582), against a real database with a scripted model and an in-memory fabric:
// no action starts after Stop, a wait and a model call in flight end at once, Stop while waiting for a person,
// during a hop and during the wrap-up, the poll path for another process, and the stop-latency record.
import { Logger } from '@nestjs/common';
import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import { AiError, type AiService } from '@marinoscar/platform-api/ai';

import { createApp } from '../src/main';
import { PrismaService } from '../src/prisma/prisma.service';
import { FabricError, type FabricClient } from '../src/fabric/fabric.client';
import { GoalRunnerService } from '../src/runner/goal-runner.service';
import { STOPPED_TEXT } from '../src/runner/stop-signal';
import { TasksService } from '../src/tasks/tasks.service';
import { SystemSettingsService } from '@marinoscar/platform-api/settings';
import { balancedSpec } from '../src/policies/builtin-policies';
import type { AgentPolicySpec } from '../src/policies/agent-policy.schema';
import type { RunPolicySnapshot } from '../src/policies/policy-snapshot';

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

async function login(email: string): Promise<string> {
  const res = await app.inject({ method: 'POST', url: '/api/auth/test/login', payload: { email, role: 'contributor' } });
  const token = new URL(String(res.headers.location)).searchParams.get('token')!;
  const me = await app.inject({ method: 'GET', url: '/api/auth/me', headers: { authorization: `Bearer ${token}` } });
  return me.json<{ data: { id: string } }>().data.id;
}

/** An in-memory fabric whose `wait_for` takes its full timeout unless the request's signal aborts it, as the real client does. */
function fakeFabric() {
  const actions: Record<string, unknown>[] = [];
  const handoffs = new Map<string, { id: string; status: string; input: string; kind: string }>();
  const cancelledHandoffs: string[] = [];
  let ended = 0;
  const request = jest.fn(async (method: string, path: string, opts: { body?: Record<string, unknown>; signal?: AbortSignal } = {}) => {
    if (method === 'POST' && path === '/v1/sessions') return { id: '00000000-0000-4000-8000-00000000000a' };
    if (method === 'DELETE' && path.startsWith('/v1/sessions/')) return void (ended += 1);
    if (method === 'POST' && path.endsWith('/actions')) {
      const action = opts.body!.action as Record<string, unknown>;
      if (action.type !== 'screenshot') actions.push(action);
      if (action.type === 'wait_for') {
        await new Promise<void>((resolve, reject) => {
          const timer = setTimeout(resolve, Number(action.timeout_ms ?? 15_000));
          opts.signal?.addEventListener('abort', () => {
            clearTimeout(timer);
            reject(new FabricError('aborted', 'The request was cancelled'));
          });
        });
      }
      if (action.type === 'navigate') return { id: 'op', state: 'succeeded', result: { url: action.url, title: 'Shop' } };
      return { id: 'op', state: 'succeeded', result: {} };
    }
    if (method === 'POST' && path.endsWith('/handoffs')) {
      const id = '00000000-0000-4000-8000-0000000000b1';
      handoffs.set(id, { id, status: 'pending', input: String(opts.body!.input), kind: String(opts.body!.kind) });
      return { handoff: { id } };
    }
    if (method === 'POST' && /^\/v1\/handoffs\/[^/]+\/cancel$/.test(path)) return void cancelledHandoffs.push(path.split('/')[3]!);
    if (method === 'GET' && path.startsWith('/v1/handoffs/')) return handoffs.get(path.split('/')[3]!);
    throw new Error(`unexpected ${method} ${path}`);
  });
  return { client: { request, config: async () => ({ url: 'http://f', token: 't' }) } as unknown as FabricClient, actions, ended: () => ended, cancelledHandoffs };
}

type Call = [name: string, args: Record<string, unknown>];
type Tool = { tool: { name: string }; execute: (a: unknown, c: unknown) => Promise<unknown> };
type Req = { tools: Tool[]; onStep?: (s: unknown) => void };
type Opts = { signal?: AbortSignal } | undefined;

/** Resolves with how long the signal took to abort after `from`, or rejects after `ms`. */
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

/** The platform's rejection for an aborted call (a typed AiError with `details.aborted`). */
const abortedError = () => new AiError('AI_PROVIDER_UNAVAILABLE', 'The AI request was cancelled.', { details: { aborted: true } });

/** A model that makes the scripted tool calls, one script per runTools call, each followed by one model step of 10 + 5 tokens. */
function scriptedAi(scripts: Call[][], hooks: { afterTool?: (index: number, signal: AbortSignal | undefined) => Promise<void>; before?: (req: Req, opts: Opts) => Promise<void> } = {}) {
  const outputs: string[] = [];
  const runTools = jest.fn(async (req: Req, opts: Opts) => {
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
  return { ai: { forUser: () => ({ runTools }) } as unknown as AiService, runTools, outputs };
}

function snapshotWith(budget: Partial<AgentPolicySpec['budget']>): RunPolicySnapshot {
  const spec = balancedSpec();
  spec.budget = { ...spec.budget, maxActions: null, maxModelCalls: null, maxActiveMinutes: null, maxInputTokens: null, maxOutputTokens: null, maxCostUsd: null, ...budget };
  return { schemaVersion: 1, ref: 'builtin:balanced', name: 'Balanced', version: 1, builtin: true, source: 'system_default', spec, tiers: null, takenAt: new Date().toISOString() };
}

async function setup(label: string, columns: Record<string, unknown> = {}) {
  const userId = await login(`stop-${label}-${stamp}@example.test`);
  const prisma = app.get(PrismaService);
  const db = prisma.forUser({ userId });
  const run = await db.run.create({ data: { userId, goal: 'Browse the shop', ...columns } });
  const tasks = app.get(TasksService);
  const fabric = fakeFabric();
  const runnerWith = (ai: AiService) => new GoalRunnerService(prisma, tasks, fabric.client, ai, undefined, undefined, app.get(SystemSettingsService));
  return { userId, prisma, db, run, tasks, fabric, runnerWith };
}

const nav = (n: number): Call[] => Array.from({ length: n }, (_, i): Call => ['navigate', { url: `https://shop.example.test/${i}`, reason: 'go' }]);

describe('Stop within seconds (E38.1)', () => {
  it('does not send the third action of a five-action chunk when Stop comes after the second, ends cancelled, and records the chunk usage', async () => {
    const { userId, db, run, tasks, fabric, runnerWith } = await setup('chunk');
    let heard = -1;
    const { ai, outputs } = scriptedAi([nav(5)], {
      afterTool: async (step, signal) => {
        if (step !== 2) return;
        const pressed = Date.now();
        await tasks.cancel(userId, run.id);
        // The worker hears it on the event bus (or, at worst, by the poll): well inside the poll interval plus a margin.
        heard = await abortedAfter(signal, pressed, 3_000);
      },
    });
    expect(await runnerWith(ai).advance(run.id, userId, null)).toBe('cancelled');

    expect(heard).toBeLessThan(1_500);
    // Only the first two actions reached the browser; the third came back as stopped, and the fourth and fifth never started.
    expect(fabric.actions.map((a) => a.type)).toEqual(['navigate', 'navigate']);
    expect(outputs.slice(0, 2).every((o) => o.startsWith('at '))).toBe(true);
    expect(outputs[2]).toBe(STOPPED_TEXT);
    expect(outputs).toHaveLength(3);

    const done = await db.run.findFirstOrThrow({ where: { id: run.id } });
    expect(done).toMatchObject({ status: 'cancelled', stopReason: 'cancelled', error: 'Cancelled by the user', stepCount: 2, cancelRequested: true });
    // The usage of the interrupted chunk is recorded (a model step after each of the three tools).
    expect(done).toMatchObject({ modelCalls: 3, inputTokens: 30, outputTokens: 15 });
    // The result says what the last completed step was.
    expect(done.result).toMatch(/^Stopped by the owner\. The last completed step was: 2\. navigate/);
    expect(done.transcript).toMatchObject({ log: expect.any(Array) });
    expect(fabric.ended()).toBe(1);
  });

  it('records when Stop was pressed, the stop latency metric, and one log line with the latency', async () => {
    const { userId, db, run, tasks, runnerWith } = await setup('latency');
    const latency = jest.spyOn(tasks.metrics, 'stopLatency');
    const logged: string[] = [];
    const spy = jest.spyOn(Logger.prototype, 'log').mockImplementation((m: unknown) => void logged.push(String(m)));
    try {
      const { ai } = scriptedAi([nav(2)], {
        afterTool: async (step, signal) => {
          if (step === 1) {
            await tasks.cancel(userId, run.id);
            await abortedAfter(signal, Date.now(), 3_000);
          }
        },
      });
      const before = Date.now();
      expect(await runnerWith(ai).advance(run.id, userId, null)).toBe('cancelled');
      const row = await db.run.findFirstOrThrow({ where: { id: run.id } });
      expect(row.cancelRequestedAt).not.toBeNull();
      expect(row.cancelRequestedAt!.getTime()).toBeGreaterThanOrEqual(before - 5);
      expect(latency).toHaveBeenCalledTimes(1);
      expect(latency).toHaveBeenCalledWith('cancelled', expect.any(Number));
      const ms = latency.mock.calls[0]![1];
      expect(ms).toBeGreaterThanOrEqual(0);
      expect(ms).toBeLessThan(3_000);
      const line = logged.find((l) => /Stop took \d+ ms \(cancelled\)/.test(l));
      expect(line).toContain(run.id);
      // No goal or page text in the line.
      expect(line).not.toContain('Browse the shop');
    } finally {
      spy.mockRestore();
      latency.mockRestore();
    }
  });

  it('a second Stop press leaves the first timestamp as it was', async () => {
    const { userId, db, run, tasks, runnerWith } = await setup('twice');
    const { ai } = scriptedAi([nav(1)], {
      afterTool: async (_step, signal) => {
        await tasks.cancel(userId, run.id);
        const first = (await db.run.findFirstOrThrow({ where: { id: run.id } })).cancelRequestedAt;
        await tick(30);
        await tasks.cancel(userId, run.id);
        expect((await db.run.findFirstOrThrow({ where: { id: run.id } })).cancelRequestedAt).toEqual(first);
        await abortedAfter(signal, Date.now(), 3_000);
      },
    });
    expect(await runnerWith(ai).advance(run.id, userId, null)).toBe('cancelled');
  });

  it('ends a wait_for with a 15 s timeout within 2 s of Stop', async () => {
    const { userId, prisma, db, run, tasks, fabric, runnerWith } = await setup('wait');
    let pressed = 0;
    const { ai, outputs } = scriptedAi([[['wait_for', { selector: '#never-appears' }], ['navigate', { url: 'https://shop.example.test/after', reason: 'go' }]]], {
      before: async () => {
        // Stop 150 ms into the wait.
        setTimeout(() => {
          pressed = Date.now();
          void tasks.cancel(userId, run.id);
        }, 150);
      },
    });
    expect(await runnerWith(ai).advance(run.id, userId, null)).toBe('cancelled');
    const elapsed = Date.now() - pressed;
    expect(pressed).toBeGreaterThan(0);
    expect(elapsed).toBeLessThan(2_000);
    expect(outputs[0]).toBe(STOPPED_TEXT);
    // The navigation after the wait never started.
    expect(fabric.actions.map((a) => a.type)).toEqual(['wait_for']);
    const steps = await prisma.runStep.findMany({ where: { runId: run.id, kind: 'action' } });
    expect(steps).toHaveLength(1);
    expect(steps[0]).toMatchObject({ action: 'wait_for', ok: false });
    expect(steps[0]!.summary).toMatch(/Stopped by the owner while this was running/);
    expect(await db.run.findFirstOrThrow({ where: { id: run.id } })).toMatchObject({ status: 'cancelled', stopReason: 'cancelled' });
  });

  it('aborts a model call in flight when the provider honours the signal, and ends the run within 2 s', async () => {
    const { userId, db, run, tasks, fabric, runnerWith } = await setup('model');
    let pressed = 0;
    const runTools = jest.fn(async (_req: Req, opts: Opts) => {
      setTimeout(() => {
        pressed = Date.now();
        void tasks.cancel(userId, run.id);
      }, 150);
      // A provider call that would take 30 s, rejecting the way the platform does when its signal aborts.
      await new Promise<void>((resolve, reject) => {
        const timer = setTimeout(resolve, 30_000);
        opts?.signal?.addEventListener('abort', () => {
          clearTimeout(timer);
          reject(abortedError());
        });
      });
      return { final: { outputText: '' }, steps: [], stopReason: 'steps_exhausted' };
    });
    const ai = { forUser: () => ({ runTools }) } as unknown as AiService;
    expect(await runnerWith(ai).advance(run.id, userId, null)).toBe('cancelled');
    expect(Date.now() - pressed).toBeLessThan(2_000);
    // Not a provider failure to fall back from: one call only.
    expect(runTools).toHaveBeenCalledTimes(1);
    expect(fabric.actions).toEqual([]);
    expect(await db.run.findFirstOrThrow({ where: { id: run.id } })).toMatchObject({ status: 'cancelled', stopReason: 'cancelled' });
  });

  it('a model call that ignores the signal ends the run as soon as it returns, and no tool of its response runs', async () => {
    const { userId, db, run, tasks, fabric, runnerWith } = await setup('model-late');
    const { ai, outputs } = scriptedAi([nav(3)], {
      before: async () => {
        await tasks.cancel(userId, run.id);
        // The call goes on for a moment before its answer arrives.
        await tick(300);
      },
    });
    expect(await runnerWith(ai).advance(run.id, userId, null)).toBe('cancelled');
    expect(fabric.actions).toEqual([]);
    expect(outputs).toEqual([STOPPED_TEXT]);
    expect(await db.run.findFirstOrThrow({ where: { id: run.id } })).toMatchObject({ status: 'cancelled', stepCount: 0 });
  });

  it('ends the run within 3 s when Stop comes from another process: the flag is set with no event (the poll path)', async () => {
    const { userId, db, run, runnerWith } = await setup('poll');
    let elapsed = -1;
    const { ai } = scriptedAi([nav(2)], {
      afterTool: async (step, signal) => {
        if (step !== 1) return;
        const from = Date.now();
        // What another process's API does: the database write, and nothing on this process's event bus.
        await db.run.updateMany({ where: { id: run.id }, data: { cancelRequested: true, cancelRequestedAt: new Date() } });
        elapsed = await abortedAfter(signal, from, 3_000);
      },
    });
    expect(await runnerWith(ai).advance(run.id, userId, null)).toBe('cancelled');
    expect(elapsed).toBeLessThan(3_000);
    expect(await db.run.findFirstOrThrow({ where: { id: run.id } })).toMatchObject({ status: 'cancelled', stopReason: 'cancelled', stepCount: 1 });
  });

  it('cancels a run waiting for a person in the same request: its handoff is withdrawn, the session ends and the latency is recorded', async () => {
    const { userId, prisma, db, run, fabric, runnerWith } = await setup('waiting');
    // The API's own service, talking to this test's fabric (the app's talks to a fabric that is not configured here).
    const shared = app.get(TasksService);
    const tasks = new TasksService(prisma, shared.metrics, fabric.client, undefined, undefined, shared.events, shared.endHooks);
    const { ai } = scriptedAi([[['request_human', { kind: 'code', prompt: 'Enter the code', input: 'text', choices: null }]]]);
    expect(await runnerWith(ai).advance(run.id, userId, null)).toBe('waiting_human');
    const latency = jest.spyOn(tasks.metrics, 'stopLatency');
    try {
      const view = await tasks.cancel(userId, run.id);
      expect(view).toMatchObject({ status: 'cancelled', stopReason: 'cancelled' });
      expect(fabric.cancelledHandoffs).toHaveLength(1);
      expect(fabric.ended()).toBeGreaterThanOrEqual(1);
      expect(latency).toHaveBeenCalledWith('cancelled', expect.any(Number));
    } finally {
      latency.mockRestore();
    }
    expect((await db.run.findFirstOrThrow({ where: { id: run.id } })).cancelRequestedAt).not.toBeNull();
  });

  it('cancels at the start of the next job when Stop came during the delay before a continuation job (a hop)', async () => {
    const { userId, db, run, tasks, runnerWith } = await setup('hop', { status: 'running', startedAt: new Date(), activeSince: new Date() });
    const { ai, runTools } = scriptedAi([nav(1)]);
    // Stop while no job holds the run: nothing hears the event, the flag stays.
    await tasks.cancel(userId, run.id);
    expect(await runnerWith(ai).advance(run.id, userId, null)).toBe('cancelled');
    expect(runTools).not.toHaveBeenCalled();
    expect(await db.run.findFirstOrThrow({ where: { id: run.id } })).toMatchObject({ status: 'cancelled', stopReason: 'cancelled' });
  });

  it('honours Stop during the wrap-up call after a budget ran out: the run ends cancelled, not failed', async () => {
    const userId = await login(`stop-wrapup-${stamp}@example.test`);
    const prisma = app.get(PrismaService);
    const db = prisma.forUser({ userId });
    const run = await db.run.create({ data: { userId, goal: 'Browse the shop', policyRef: 'builtin:balanced', policyVersion: 1, policySource: 'system_default', policySnapshot: snapshotWith({ maxActions: 2 }) as never } });
    const tasks = app.get(TasksService);
    const fabric = fakeFabric();
    let pressed = 0;
    let calls = 0;
    const runTools = jest.fn(async (req: Req, opts: Opts) => {
      calls += 1;
      if (calls === 1) {
        for (const [name, args] of nav(3)) {
          await req.tools.find((x) => x.tool.name === name)!.execute(args, { userId: 'u' });
          req.onStep?.({ step: 1, response: { usage: { inputTokens: 10, outputTokens: 5 } }, calls: [] });
        }
        return { final: { outputText: '' }, steps: [], stopReason: 'steps_exhausted' };
      }
      // The wrap-up call: only `finish`, in flight when Stop is pressed.
      expect(req.tools.map((t) => t.tool.name)).toEqual(['finish']);
      setTimeout(() => {
        pressed = Date.now();
        void tasks.cancel(userId, run.id);
      }, 150);
      await new Promise<void>((resolve, reject) => {
        const timer = setTimeout(resolve, 30_000);
        opts?.signal?.addEventListener('abort', () => {
          clearTimeout(timer);
          reject(abortedError());
        });
      });
      return { final: { outputText: '' }, steps: [], stopReason: 'steps_exhausted' };
    });
    const ai = { forUser: () => ({ runTools }) } as unknown as AiService;
    const runner = new GoalRunnerService(prisma, tasks, fabric.client, ai, undefined, undefined, app.get(SystemSettingsService));
    expect(await runner.advance(run.id, userId, null)).toBe('cancelled');
    expect(Date.now() - pressed).toBeLessThan(2_000);
    expect(runTools).toHaveBeenCalledTimes(2);
    expect(await db.run.findFirstOrThrow({ where: { id: run.id } })).toMatchObject({ status: 'cancelled', stopReason: 'cancelled' });
  });

  it('does not delay the stop for a trace picture, and the session is released', async () => {
    const { userId, prisma, db, run, tasks, fabric, runnerWith } = await setup('shot');
    const { ai } = scriptedAi([nav(2)], {
      afterTool: async (step, signal) => {
        if (step === 1) {
          await tasks.cancel(userId, run.id);
          await abortedAfter(signal, Date.now(), 3_000);
        }
      },
    });
    expect(await runnerWith(ai).advance(run.id, userId, null)).toBe('cancelled');
    expect(fabric.ended()).toBe(1);
    // The closing step is there; with no artifact store it has a note instead of a picture.
    const end = await prisma.runStep.findFirst({ where: { runId: run.id, kind: 'end' } });
    expect(end).not.toBeNull();
  });
});
