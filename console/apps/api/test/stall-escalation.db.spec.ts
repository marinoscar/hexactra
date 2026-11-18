// Stall detection, tier escalation and provider fallback (#405) end to end, with a scripted model and an
// in-memory fabric: the sequence of models per call, the nudge in the input, the routing steps, the stop reasons.
import { randomUUID } from 'node:crypto';
import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import { AiError, type AiService } from '@marinoscar/platform-api/ai';

import { createApp } from '../src/main';
import { PrismaService } from '../src/prisma/prisma.service';
import type { FabricClient } from '../src/fabric/fabric.client';
import { GoalRunnerService } from '../src/runner/goal-runner.service';
import { TasksService } from '../src/tasks/tasks.service';
import { balancedSpec, builtinPolicy } from '../src/policies/builtin-policies';
import type { AgentPolicySpec, Tier } from '../src/policies/agent-policy.schema';
import type { ResolvedTier } from '../src/policies/model-tiers.schema';

let app: NestFastifyApplication;
const stamp = `${Date.now()}`;

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

/** An in-memory fabric. `still`: every screenshot is the same page; otherwise each is different. */
function fabricOf(opts: { still?: boolean } = {}) {
  const actions: Record<string, unknown>[] = [];
  const handoffs = new Map<string, { id: string; status: string; input: string; kind: string; prompt: string; response?: Record<string, unknown> }>();
  let shots = 0;
  const request = jest.fn(async (method: string, path: string, o: { body?: Record<string, unknown> } = {}) => {
    if (method === 'POST' && path === '/v1/sessions') return { id: '00000000-0000-4000-8000-00000000000a' };
    if (method === 'DELETE') return undefined;
    if (method === 'POST' && path.endsWith('/actions')) {
      const action = o.body!.action as Record<string, unknown>;
      actions.push(action);
      if (action.type === 'screenshot') {
        const n = opts.still ? 1 : (shots += 1);
        return { id: 'op', state: 'succeeded', result: { mime: 'image/jpeg', data: Buffer.from(`shot-${n}`).toString('base64'), width: 800, height: 600, url: 'https://shop.example.test/', title: 'Shop', marks: [] } };
      }
      if (action.type === 'navigate') return { id: 'op', state: 'succeeded', result: { url: action.url, title: 'Shop' } };
      return { id: 'op', state: 'succeeded', result: {} };
    }
    if (method === 'POST' && path.endsWith('/handoffs')) {
      const id = randomUUID();
      handoffs.set(id, { id, status: 'pending', input: String(o.body!.input), kind: String(o.body!.kind), prompt: String(o.body!.prompt) });
      return { handoff: { id } };
    }
    if (method === 'GET' && path.startsWith('/v1/handoffs/')) return handoffs.get(path.split('/')[3]!);
    throw new Error(`unexpected ${method} ${path}`);
  });
  return { client: { request, config: async () => ({ url: 'http://f', token: 't' }) } as unknown as FabricClient, actions, handoffs };
}

type Call = [name: string, args: Record<string, unknown>];
type Req = { tools: { tool: { name: string }; execute: (a: unknown, c: unknown) => Promise<unknown> }[]; onStep?: (s: unknown) => void; input: unknown; model?: string; provider?: string; maxSteps: number };
type Item = Call | { throw: Error };

/**
 * A scripted model. Each runTools call performs up to maxSteps of the script (then `loop`, when the script
 * is empty). It records the model of every call and, for every action, the model that was running.
 */
function scripted(script: Item[], loop?: Call) {
  const calls: { model: string; tools: string[]; text: string; images: number }[] = [];
  const performed: { model: string; name: string }[] = [];
  const runTools = jest.fn(async (req: Req) => {
    const model = `${req.provider ?? '-'}:${req.model ?? '-'}`;
    const parts = typeof req.input === 'string' ? [{ type: 'text', text: req.input }] : (req.input as { content: { type: string; text?: string }[] }[])[0]!.content;
    calls.push({ model, tools: req.tools.map((t) => t.tool.name), text: parts.filter((p) => p.type === 'text').map((p) => p.text).join('\n'), images: parts.filter((p) => p.type === 'image').length });
    let step = 0;
    while (step < req.maxSteps) {
      const next: Item | undefined = script.length ? script.shift() : loop;
      if (!next) break;
      if ('throw' in next) throw next.throw;
      const [name, args] = next;
      await req.tools.find((t) => t.tool.name === name)!.execute(args, { userId: 'u' });
      performed.push({ model, name });
      req.onStep?.({ step: ++step, response: { usage: { inputTokens: 100, outputTokens: 10 } }, calls: [] });
    }
    return { final: { outputText: '' }, steps: [], stopReason: 'steps_exhausted' };
  });
  return { ai: { forUser: () => ({ runTools }) } as unknown as AiService, calls, performed };
}

const tierDef = (id: string, extra: Partial<ResolvedTier> = {}): ResolvedTier => ({
  model: `prov:${id}`,
  provider: 'prov',
  modelId: id,
  modelSource: 'deployment',
  borrowedFrom: null,
  reasoningEffort: null,
  effortSource: null,
  maxOutputTokens: null,
  maxOutputTokensSource: null,
  fallbackModel: null,
  fallbackProvider: null,
  fallbackSource: null,
  vision: true,
  tools: true,
  reasoning: true,
  usable: true,
  problem: null,
  ...extra,
});
const tiers = (over: Partial<Record<Tier, Partial<ResolvedTier>>> = {}) => ({
  fast: tierDef('fast-m', over.fast),
  standard: tierDef('std-m', over.standard),
  frontier: tierDef('top-m', over.frontier),
});

const STD = 'prov:std-m';
const TOP = 'prov:top-m';

function specOf(stall: Partial<AgentPolicySpec['stall']> = {}, models: Partial<AgentPolicySpec['models']> = {}, context: Partial<AgentPolicySpec['context']> = {}): AgentPolicySpec {
  const s = balancedSpec();
  return { ...s, models: { ...s.models, ...models }, stall: { ...s.stall, ...stall }, context: { ...s.context, callsPerChunk: 4, ...context } };
}

async function newRun(label: string, spec: AgentPolicySpec, resolved = tiers(), runData: Record<string, unknown> = {}) {
  const userId = await login(`stall-${label}-${stamp}@example.test`);
  const prisma = app.get(PrismaService);
  const db = prisma.forUser({ userId });
  const snapshot = { schemaVersion: 1, ref: 'builtin:balanced', name: 'Balanced', version: 1, builtin: true, source: 'run', spec, tiers: null, resolvedTiers: resolved, takenAt: new Date().toISOString() };
  const run = await db.run.create({ data: { userId, goal: 'Check out', policyRef: 'builtin:balanced', policySource: 'run', policyVersion: 1, policySnapshot: snapshot as never, ...runData } });
  return { userId, prisma, db, run };
}

const runnerOf = (prisma: PrismaService, fabric: { client: FabricClient }, ai: AiService) => new GoalRunnerService(prisma, app.get(TasksService), fabric.client, ai);
const click = (sel = '#x'): Call => ['click', { selector: sel, reason: 'try it' }];
const finish = (success = true, result = 'Done'): Call => ['finish', { success, result }];
const routingOf = async (db: ReturnType<PrismaService['forUser']>, runId: string, prisma: PrismaService) => (await prisma.runStep.findMany({ where: { runId, kind: 'routing' }, orderBy: { seq: 'asc' } })).map((s) => s.args as { from: string; to: string; reason: string; kind: string });

describe('nudge_then_escalate', () => {
  it('nudges on the first stall, escalates on the second, and the next chunk runs the frontier model', async () => {
    const { userId, prisma, db, run } = await newRun('nudge', specOf({ onStall: 'nudge_then_escalate', maxEscalations: 2 }));
    const fabric = fabricOf();
    const m = scripted([click(), click(), click(), click(), click(), click(), finish()]);
    expect(await runnerOf(prisma, fabric, m.ai).advance(run.id, userId, null)).toBe('succeeded');

    // Chunk 1 ends at the third identical click (the stall); chunk 2 carries the nudge and ends at the next stall; chunk 3 is on the frontier model.
    expect(m.calls.map((c) => c.model)).toEqual([STD, STD, TOP]);
    expect(m.calls[0]!.text).not.toContain('You appear stuck');
    expect(m.calls[1]!.text).toContain('You appear stuck: repeated click on #x 3 times (last actions: click on #x; click on #x; click on #x). Do not repeat the same action.');
    expect(m.calls[2]!.text).not.toContain('You appear stuck');
    expect(m.calls[2]!.text).toContain('Escalated to the Frontier tier (stuck: repeated click on #x 3 times).');

    // Model switches happen between chunks only: every action ran on the model its chunk started with.
    expect(m.performed.map((p) => p.model)).toEqual([STD, STD, STD, STD, STD, STD, TOP]);

    const done = await db.run.findFirstOrThrow({ where: { id: run.id } });
    expect(done).toMatchObject({ status: 'succeeded', currentTier: 'frontier', escalations: 1 });
    // Six clicks and the finish are actions; the routing step is not.
    expect(done.stepCount).toBe(7);
    expect(await routingOf(db, run.id, prisma)).toEqual([{ from: 'standard', to: 'frontier', reason: 'repeated click on #x 3 times', kind: 'escalate' }]);
    const steps = await prisma.runStep.findMany({ where: { runId: run.id }, orderBy: { seq: 'asc' } });
    expect(steps.filter((s) => s.kind !== 'routing')).toHaveLength(7);
    expect(new Set(steps.map((s) => s.seq)).size).toBe(steps.length);
  });

  it('shows the escalation in the run activity while the stronger model works', async () => {
    const { userId, prisma, db, run } = await newRun('activity', specOf({ onStall: 'escalate', maxEscalations: 1 }));
    const fabric = fabricOf();
    const seen: unknown[] = [];
    const m = scripted([click(), click(), click(), finish()]);
    const inner = m.ai.forUser as unknown as () => { runTools: (r: Req) => Promise<unknown> };
    const ai = {
      forUser: () => ({
        runTools: async (r: Req) => {
          seen.push((await db.run.findFirstOrThrow({ where: { id: run.id } })).activity);
          return inner().runTools(r);
        },
      }),
    } as unknown as AiService;
    await runnerOf(prisma, fabric, ai).advance(run.id, userId, null);
    expect((seen[1] as { note?: string }).note).toBe('Escalated to Frontier (stuck: repeated click on #x 3 times)');
    expect((seen[0] as { note?: string }).note).toBeUndefined();
  });

  it('escalates, then asks a person when nothing is left to escalate to', async () => {
    const { userId, prisma, db, run } = await newRun('ask', specOf({ onStall: 'nudge_then_escalate', maxEscalations: 1 }));
    const fabric = fabricOf();
    // nudge, escalate, then (the third stall) a person is asked.
    const m = scripted([], click());
    expect(await runnerOf(prisma, fabric, m.ai).advance(run.id, userId, null)).toBe('waiting_human');
    expect(m.calls.map((c) => c.model)).toEqual([STD, STD, TOP, TOP]);
    expect(await routingOf(db, run.id, prisma)).toHaveLength(1);
    expect((await db.run.findFirstOrThrow({ where: { id: run.id } })).status).toBe('waiting_human');
  });

  it('fails as stalled when nothing is left and the run is unattended (scheduled)', async () => {
    const { userId, prisma, db, run } = await newRun('sched', specOf({ onStall: 'nudge_then_escalate', maxEscalations: 0 }), tiers(), { trigger: 'schedule' });
    const fabric = fabricOf();
    const m = scripted([], click());
    expect(await runnerOf(prisma, fabric, m.ai).advance(run.id, userId, null)).toBe('failed');
    // nudge, then no escalation and no person to ask: the wrap-up call (finish only) and the end.
    expect(m.calls.map((c) => c.tools)).toEqual([expect.arrayContaining(['click']), expect.arrayContaining(['click']), ['finish']]);
    expect(await db.run.findFirstOrThrow({ where: { id: run.id } })).toMatchObject({ status: 'failed', stopReason: 'stalled', escalations: 0 });
    expect(await routingOf(db, run.id, prisma)).toEqual([]);
  });
});

describe('the other modes', () => {
  it('escalate: moves up at once; with no escalation left it fails as stalled with the wrap-up summary', async () => {
    const { userId, prisma, db, run } = await newRun('esc', specOf({ onStall: 'escalate', maxEscalations: 1 }));
    const fabric = fabricOf();
    const m = scripted([click(), click(), click(), click(), click(), click(), finish(false, 'Stuck on the checkout button')]);
    expect(await runnerOf(prisma, fabric, m.ai).advance(run.id, userId, null)).toBe('failed');
    expect(m.calls.map((c) => c.model)).toEqual([STD, TOP, TOP]);
    expect(m.calls[2]!.tools).toEqual(['finish']);
    expect(m.calls[2]!.text).toContain('The run is stuck (repeated click on #x 3 times)');
    expect(await db.run.findFirstOrThrow({ where: { id: run.id } })).toMatchObject({ status: 'failed', stopReason: 'stalled', result: 'Stuck on the checkout button', escalations: 1, currentTier: 'frontier' });
  });

  it('fail: ends with stalled at the first stall', async () => {
    const { userId, prisma, db, run } = await newRun('fail', specOf({ onStall: 'fail' }));
    const m = scripted([click(), click(), click(), finish(false, 'Could not get past the button')]);
    expect(await runnerOf(prisma, fabricOf(), m.ai).advance(run.id, userId, null)).toBe('failed');
    expect(m.calls.map((c) => c.model)).toEqual([STD, STD]);
    expect(await db.run.findFirstOrThrow({ where: { id: run.id } })).toMatchObject({ status: 'failed', stopReason: 'stalled', result: 'Could not get past the button' });
  });

  it('a chat run over its (soft) budget still follows onStall: fail ends it as stalled, never on the budget (#537)', async () => {
    const spec = specOf({ onStall: 'fail' });
    spec.budget = { ...spec.budget, maxActions: 1, maxModelCalls: 1 };
    const { userId, prisma, db, run } = await newRun('soft-fail', spec, tiers(), { trigger: 'chat' });
    const chat = await db.conversation.create({ data: { userId, title: 'Soft and stuck' } });
    await db.run.updateMany({ where: { id: run.id }, data: { conversationId: chat.id } });
    const m = scripted([click(), click(), click(), finish(false, 'Could not get past the button')]);
    expect(await runnerOf(prisma, fabricOf(), m.ai).advance(run.id, userId, null)).toBe('failed');
    const done = await db.run.findFirstOrThrow({ where: { id: run.id } });
    expect(done).toMatchObject({ status: 'failed', stopReason: 'stalled', result: 'Could not get past the button' });
    expect((done.policySnapshot as { effectiveBudget: { enforcement: string } }).effectiveBudget.enforcement).toBe('soft');
  });

  it('ask_human: opens a takeover handoff that summarises the last actions, then waits; the answer starts the counters over', async () => {
    const { userId, prisma, db, run } = await newRun('human', specOf({ onStall: 'ask_human' }));
    const fabric = fabricOf();
    const m = scripted([click('#a'), click('#a'), click('#a'), finish()]);
    const runner = runnerOf(prisma, fabric, m.ai);
    expect(await runner.advance(run.id, userId, null)).toBe('waiting_human');
    const [h] = [...fabric.handoffs.values()];
    expect(h).toMatchObject({ kind: 'other', input: 'takeover' });
    expect(h!.prompt).toContain('stuck: repeated click on #a 3 times');
    expect(h!.prompt).toContain('click on #a; click on #a; click on #a');
    const waiting = await db.run.findFirstOrThrow({ where: { id: run.id } });
    expect(waiting).toMatchObject({ status: 'waiting_human', handoffId: h!.id });
    expect((waiting.transcript as { stall: { recent: unknown[] } }).stall.recent).toEqual([]);

    Object.assign(h!, { status: 'completed', response: { outcome: 'completed', value_withheld: false } });
    expect(await runner.advance(run.id, userId, null)).toBe('succeeded');
    expect(m.calls[1]!.text).toContain('The person took over the browser');
  });

  it('a stall under the Unlimited policy ends the run as stalled', async () => {
    const unlimited = builtinPolicy('builtin:unlimited')!.spec;
    expect(unlimited.budget.maxActions).toBeNull();
    const { userId, prisma, db, run } = await newRun('unl', { ...unlimited, context: { ...unlimited.context, callsPerChunk: 4 } }, tiers(), { trigger: 'schedule' });
    const m = scripted([], click());
    const out = await runnerOf(prisma, fabricOf(), m.ai).advance(run.id, userId, null);
    expect(out).toBe('failed');
    const done = await db.run.findFirstOrThrow({ where: { id: run.id } });
    expect(done).toMatchObject({ status: 'failed', stopReason: 'stalled' });
    // Not a budget stop: the run had no budget at all.
    expect(done.stepCount).toBeLessThan(40);
  });
});

describe('where escalation stops', () => {
  it('maxEscalations 0 never escalates', async () => {
    const { userId, prisma, db, run } = await newRun('max0', specOf({ onStall: 'escalate', maxEscalations: 0 }));
    const m = scripted([click(), click(), click(), finish(false, 'stuck')]);
    await runnerOf(prisma, fabricOf(), m.ai).advance(run.id, userId, null);
    expect(m.calls.map((c) => c.model)).toEqual([STD, STD]);
    expect(await db.run.findFirstOrThrow({ where: { id: run.id } })).toMatchObject({ stopReason: 'stalled', escalations: 0, currentTier: 'standard' });
    expect(await routingOf(db, run.id, prisma)).toEqual([]);
  });

  it('maxTier equal to startTier never escalates', async () => {
    const { userId, prisma, db, run } = await newRun('maxeq', specOf({ onStall: 'escalate', maxEscalations: 5 }, { startTier: 'standard', maxTier: 'standard' }));
    const m = scripted([click(), click(), click(), finish(false, 'stuck')]);
    await runnerOf(prisma, fabricOf(), m.ai).advance(run.id, userId, null);
    expect(m.calls.map((c) => c.model)).toEqual([STD, STD]);
    expect(await db.run.findFirstOrThrow({ where: { id: run.id } })).toMatchObject({ stopReason: 'stalled', escalations: 0 });
  });

  it('skips a tier that would call the very same model', async () => {
    const same = tiers({ frontier: { model: 'prov:std-m', modelId: 'std-m' } });
    const { userId, prisma, db, run } = await newRun('same', specOf({ onStall: 'escalate', maxEscalations: 5 }), same);
    const m = scripted([click(), click(), click(), finish(false, 'stuck')]);
    await runnerOf(prisma, fabricOf(), m.ai).advance(run.id, userId, null);
    expect(await db.run.findFirstOrThrow({ where: { id: run.id } })).toMatchObject({ stopReason: 'stalled', escalations: 0 });
  });

  it('a new tier without vision turns screenshots off', async () => {
    const { userId, prisma, db, run } = await newRun('novision', specOf({ onStall: 'escalate', maxEscalations: 1 }), tiers({ frontier: { vision: false } }));
    const m = scripted([click(), click(), click(), finish()]);
    await runnerOf(prisma, fabricOf(), m.ai).advance(run.id, userId, null);
    expect(m.calls.map((c) => c.images)).toEqual([1, 0]);
    expect((await db.run.findFirstOrThrow({ where: { id: run.id } })).transcript).toMatchObject({ visionOff: true });
  });
});

describe('de-escalation', () => {
  it('returns to the start tier after 5 progressing actions on the escalated tier', async () => {
    const { userId, prisma, db, run } = await newRun('deesc', specOf({ onStall: 'escalate', maxEscalations: 2 }));
    const progress = (n: number): Call[] => Array.from({ length: n }, (_, i): Call => click(`#next-${i}`));
    const m = scripted([click(), click(), click(), ...progress(8), finish()]);
    expect(await runnerOf(prisma, fabricOf(), m.ai).advance(run.id, userId, null)).toBe('succeeded');
    // standard (stall) -> frontier (4 + 4 progressing actions) -> back on standard for the finish.
    expect(m.calls.map((c) => c.model)).toEqual([STD, TOP, TOP, STD]);
    expect(await routingOf(db, run.id, prisma)).toEqual([
      { from: 'standard', to: 'frontier', reason: 'repeated click on #x 3 times', kind: 'escalate' },
      { from: 'frontier', to: 'standard', reason: '8 progressing actions in a row', kind: 'deescalate' },
    ]);
    const done = await db.run.findFirstOrThrow({ where: { id: run.id } });
    expect(done).toMatchObject({ currentTier: 'standard', escalations: 1 });
    expect(m.calls[3]!.text).toContain('Back on the Standard tier');
  });

  it('stays escalated when the progress is shorter than 5 actions', async () => {
    const { userId, prisma, run } = await newRun('stay', specOf({ onStall: 'escalate', maxEscalations: 2 }));
    const m = scripted([click(), click(), click(), click('#n1'), click('#n2'), click('#n3'), click('#n4'), finish()]);
    await runnerOf(prisma, fabricOf(), m.ai).advance(run.id, userId, null);
    expect(m.calls.map((c) => c.model)).toEqual([STD, TOP, TOP]);
  });
});

describe('provider fallback', () => {
  const withFallback = () => tiers({ standard: { fallbackModel: 'backup:fb-m', fallbackProvider: 'backup' } });

  it('a 503 on the primary retries the chunk once on the fallback model, then returns to the primary', async () => {
    const { userId, prisma, db, run } = await newRun('fb503', specOf({}, { allowProviderFallback: true }, { callsPerChunk: 2 }), withFallback());
    const down = new AiError('AI_PROVIDER_UNAVAILABLE', 'The provider returned 503');
    const m = scripted([{ throw: down }, click('#a'), click('#b'), click('#c'), finish()]);
    expect(await runnerOf(prisma, fabricOf(), m.ai).advance(run.id, userId, null)).toBe('succeeded');
    expect(m.calls.map((c) => c.model)).toEqual([STD, 'backup:fb-m', STD]);
    expect(await routingOf(db, run.id, prisma)).toEqual([{ from: 'prov:std-m', to: 'backup:fb-m', reason: 'AI_PROVIDER_UNAVAILABLE', kind: 'fallback', tier: 'standard' }]);
    const done = await db.run.findFirstOrThrow({ where: { id: run.id } });
    // The fallback is not an escalation, and the run stays on its tier.
    expect(done).toMatchObject({ escalations: 0, currentTier: 'standard' });
    expect(done.stepCount).toBe(4);
  });

  it('a rate limit uses the fallback too', async () => {
    const { userId, prisma, run } = await newRun('fb429', specOf({}, { allowProviderFallback: true }), withFallback());
    const m = scripted([{ throw: new AiError('AI_RATE_LIMITED', 'slow down') }, finish()]);
    expect(await runnerOf(prisma, fabricOf(), m.ai).advance(run.id, userId, null)).toBe('succeeded');
    expect(m.calls.map((c) => c.model)).toEqual([STD, 'backup:fb-m']);
  });

  it('without allowProviderFallback the error stands, as before (a rate limit still defers)', async () => {
    const { userId, prisma, run } = await newRun('nofb', specOf({}, { allowProviderFallback: false }), withFallback());
    const m = scripted([{ throw: new AiError('AI_PROVIDER_UNAVAILABLE', 'down') }]);
    await expect(runnerOf(prisma, fabricOf(), m.ai).advance(run.id, userId, null)).rejects.toMatchObject({ code: 'AI_PROVIDER_UNAVAILABLE' });
    expect(m.calls).toHaveLength(1);

    const limited = await newRun('nofb429', specOf({}, { allowProviderFallback: true }), tiers());
    const m2 = scripted([{ throw: new AiError('AI_RATE_LIMITED', 'slow down') }]);
    const err = await runnerOf(limited.prisma, fabricOf(), m2.ai).advance(limited.run.id, limited.userId, null).catch((e: unknown) => e);
    // No fallback model on the tier: the error propagates and is deferred by the job as today.
    expect(err).toBeInstanceOf(AiError);
    expect((err as AiError).toRateLimitError()).not.toBeNull();
    expect(m2.calls).toHaveLength(1);
  });

  it('a fallback that fails too ends the chunk with its error (once)', async () => {
    const { userId, prisma, run } = await newRun('fbtwice', specOf({}, { allowProviderFallback: true }), withFallback());
    const m = scripted([{ throw: new AiError('AI_PROVIDER_UNAVAILABLE', 'down') }, { throw: new AiError('AI_PROVIDER_UNAVAILABLE', 'down too') }]);
    await expect(runnerOf(prisma, fabricOf(), m.ai).advance(run.id, userId, null)).rejects.toMatchObject({ code: 'AI_PROVIDER_UNAVAILABLE' });
    expect(m.calls).toHaveLength(2);
  });

  it('an unavailable provider is not mistaken for a model that refuses images', async () => {
    const { userId, prisma, db, run } = await newRun('novisionmix', specOf({}, { allowProviderFallback: false }), tiers());
    const m = scripted([{ throw: new AiError('AI_PROVIDER_UNAVAILABLE', 'down') }]);
    await runnerOf(prisma, fabricOf(), m.ai).advance(run.id, userId, null).catch(() => undefined);
    expect(m.calls).toHaveLength(1);
    expect((await db.run.findFirstOrThrow({ where: { id: run.id } })).transcript).not.toMatchObject({ visionOff: true });
  });
});

describe('the idle guard, folded into stall detection', () => {
  it('a model that only talks still stops, as stalled', async () => {
    const { userId, prisma, db, run } = await newRun('talk', specOf({ onStall: 'fail' }));
    const m = scripted([]);
    expect(await runnerOf(prisma, fabricOf(), m.ai).advance(run.id, userId, null)).toBe('failed');
    // Three rounds with no action, then the wrap-up call.
    expect(m.calls).toHaveLength(4);
    expect(await db.run.findFirstOrThrow({ where: { id: run.id } })).toMatchObject({ status: 'failed', stopReason: 'stalled' });
  });

  it('is nudged first when the policy nudges', async () => {
    const { userId, prisma, run } = await newRun('talknudge', specOf({ onStall: 'nudge_then_escalate', maxEscalations: 0 }), tiers(), { trigger: 'schedule' });
    const m = scripted([]);
    await runnerOf(prisma, fabricOf(), m.ai).advance(run.id, userId, null);
    // 3 idle rounds, the nudge, 3 more idle rounds, the wrap-up.
    expect(m.calls).toHaveLength(7);
    expect(m.calls[3]!.text).toContain('You appear stuck: no action in 3 rounds in a row');
  });
});

describe('no progress on a still page', () => {
  it('varied actions that change nothing stall at the chunk boundary', async () => {
    const { userId, prisma, db, run } = await newRun('still', specOf({ onStall: 'fail', maxRepeatedAction: 50, noProgressActions: 6 }), tiers());
    let n = 0;
    const model = scripted([...Array.from({ length: 40 }, (): Call => ['click_at', { x: (n += 100), y: 5, button: 'left', double: false, modifiers: [], reason: 'try' }]), finish(false, 'no change')]);
    expect(await runnerOf(prisma, fabricOf({ still: true }), model.ai).advance(run.id, userId, null)).toBe('failed');
    const done = await db.run.findFirstOrThrow({ where: { id: run.id } });
    expect(done.stopReason).toBe('stalled');
    // Chunks of 4: the threshold of 6 is reached in the second chunk and judged at the boundary before the third.
    expect(model.calls.map((c) => c.tools.length > 1)).toEqual([true, true, false]);
  });

  it('the same actions on a page that keeps changing are not a stall', async () => {
    const { userId, prisma, run } = await newRun('moving', specOf({ onStall: 'fail', maxRepeatedAction: 50, noProgressActions: 6 }), tiers());
    let n = 0;
    const model = scripted([...Array.from({ length: 12 }, (): Call => ['click_at', { x: (n += 100), y: 5, button: 'left', double: false, modifiers: [], reason: 'try' }]), finish()]);
    expect(await runnerOf(prisma, fabricOf(), model.ai).advance(run.id, userId, null)).toBe('succeeded');
  });
});

describe('secrets', () => {
  it('typing a handoff secret does not enter the stall state, and no state holds typed text', async () => {
    const { userId, prisma, db, run } = await newRun('secret', specOf({ onStall: 'fail' }, {}, { callsPerChunk: 6 }));
    const typed = 'hunter2-not-a-real-password';
    const m = scripted([
      ['type_text', { selector: '#user', text: typed, submit: false }],
      ['type_handoff_secret', { selector: '#otp', submit: true }],
      ['type_handoff_secret', { selector: '#otp', submit: true }],
      ['type_handoff_secret', { selector: '#otp', submit: true }],
      ['type_handoff_secret', { selector: '#otp', submit: true }],
      finish(),
    ]);
    expect(await runnerOf(prisma, fabricOf(), m.ai).advance(run.id, userId, null)).toBe('succeeded');
    const stored = await db.run.findFirstOrThrow({ where: { id: run.id } });
    expect(JSON.stringify(stored.transcript)).not.toContain(typed);
    expect((stored.transcript as { stall: { recent: { label: string }[] } }).stall.recent.map((r) => r.label)).toEqual(['type on #user']);
  });
});
