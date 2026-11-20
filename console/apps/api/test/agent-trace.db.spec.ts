// Agent traces (E38.4, #585) end to end: a scripted three-job run (two chunks and a question, a resume that asks for
// a secret, a resume that types it and finishes) against a real database, an in-memory fabric and an in-memory span
// exporter. Asserts the span tree, the links between jobs, `runs.trace_id`, the model and tool spans' attributes,
// the failed-call statuses, the off state, and that no prompt, typed text, page text, question or secret is in any
// span, event, link or metric label.
import { randomUUID } from 'node:crypto';
import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import { AiError, type AiService } from '@marinoscar/platform-api/ai';
import { AppMetricsService } from '@marinoscar/platform-api/host';
import { SpanKind, SpanStatusCode } from '@opentelemetry/api';
import type { ReadableSpan } from '@opentelemetry/sdk-trace-base';

import { createApp } from '../src/main';
import { PrismaService } from '../src/prisma/prisma.service';
import { FabricError, type FabricClient } from '../src/fabric/fabric.client';
import { GoalRunnerService } from '../src/runner/goal-runner.service';
import { RunTraceService } from '../src/tasks/run-trace.service';
import { TasksService } from '../src/tasks/tasks.service';
import { ATTR, EVENT, ERROR_TYPE, LINK, OPERATION, SPAN } from '../src/runner/trace-attributes';
import { childrenOf, installMemoryTracing, parentOf, spanText, treeOf } from './helpers/otel-memory';

// Markers that must never appear in an exported span, event, link or metric label.
const TYPED = 'marker-typed-7f3a';
const PAGE = 'marker-page-text-91bc';
const QUESTION = 'marker-question-c2d4';
const SECRET = 'marker-secret-e508';
const ALL_MARKERS = [TYPED, PAGE, QUESTION, SECRET];

let app: NestFastifyApplication;
let otel: ReturnType<typeof installMemoryTracing>;
const stamp = `${Date.now()}`;

beforeAll(async () => {
  app = await createApp();
  await app.init();
  await app.getHttpAdapter().getInstance().ready();
  otel = installMemoryTracing();
});
afterAll(async () => {
  await otel?.uninstall();
  await app?.close();
});

async function login(email: string): Promise<string> {
  const res = await app.inject({ method: 'POST', url: '/api/auth/test/login', payload: { email, role: 'contributor' } });
  const token = new URL(String(res.headers.location)).searchParams.get('token')!;
  const me = await app.inject({ method: 'GET', url: '/api/auth/me', headers: { authorization: `Bearer ${token}` } });
  return me.json<{ data: { id: string } }>().data.id;
}

/** An in-memory fabric: sessions, actions (the page says PAGE when read), handoffs. */
function fakeFabric(opts: { failType?: boolean } = {}) {
  const handoffs = new Map<string, { id: string; status: string; input: string; kind: string; response?: Record<string, unknown> }>();
  const request = jest.fn(async (method: string, path: string, o: { body?: Record<string, unknown> } = {}) => {
    if (method === 'POST' && path === '/v1/sessions') return { id: '00000000-0000-4000-8000-00000000000a' };
    if (method === 'DELETE') return undefined;
    if (method === 'POST' && path.endsWith('/actions')) {
      const action = o.body!.action as Record<string, unknown>;
      if (action.type === 'navigate') return { id: 'op-nav', state: 'succeeded', result: { url: action.url, title: 'Shop' } };
      if (action.type === 'text') return { id: 'op-text', state: 'succeeded', result: { text: `The page says ${PAGE}` } };
      if (action.type === 'elements') return { id: 'op-els', state: 'succeeded', result: { elements: [{ selector: '#otp', tag: 'input', text: '' }] } };
      if (action.type === 'type') return opts.failType ? { id: 'op-type', state: 'failed', error: 'the element is not there' } : { id: 'op-type', state: 'succeeded', result: {} };
      if (action.type === 'type_secret') {
        const h = handoffs.get(String(action.handoff_id));
        if (!h || h.status !== 'completed') throw new FabricError('api', 'secret_unavailable', 409, 'secret_unavailable');
        return { id: 'op-secret', state: 'succeeded', result: {} };
      }
      return { id: 'op', state: 'succeeded', result: {} };
    }
    if (method === 'POST' && path.endsWith('/handoffs')) {
      const id = randomUUID();
      handoffs.set(id, { id, status: 'pending', input: String(o.body!.input), kind: String(o.body!.kind) });
      return { handoff: { id } };
    }
    if (method === 'GET' && path.startsWith('/v1/handoffs/')) return handoffs.get(path.split('/')[3]!);
    throw new Error(`unexpected ${method} ${path}`);
  });
  return { client: { request, config: async () => ({ url: 'http://f', token: 't' }) } as unknown as FabricClient, handoffs };
}

type Call = [name: string, args: Record<string, unknown>];
type Req = { tools: { tool: { name: string }; execute: (a: unknown, c: unknown) => Promise<unknown> }[]; onStep?: (s: unknown) => void };

/**
 * A scripted model: each runTools call (a chunk) performs one script, reporting every round trip the way the loop does
 * (provider, model, usage, finish reason and the tool call records). A `throw` entry fails the call.
 */
function scriptedAi(scripts: (Call[] | { throw: Error })[]) {
  let n = 0;
  const runTools = jest.fn(async (req: Req) => {
    const script = scripts.shift() ?? [];
    if (!Array.isArray(script)) throw script.throw;
    let step = 0;
    for (const [name, args] of script) {
      await req.tools.find((x) => x.tool.name === name)!.execute(args, { userId: 'u' });
      req.onStep?.({
        step: ++step,
        response: { provider: 'prov', model: 'model-a', finishReason: 'tool_calls', usage: { inputTokens: 100, outputTokens: 10, cachedInputTokens: 40 } },
        calls: [{ callId: `call-${(n += 1)}`, name, status: 'ok', durationMs: 1 }],
      });
    }
    return { final: { outputText: '' }, steps: [], stopReason: 'steps_exhausted' };
  });
  return { ai: { forUser: () => ({ runTools }) } as unknown as AiService, runTools };
}

async function newRun(label: string) {
  const userId = await login(`trace-${label}-${stamp}@example.test`);
  const prisma = app.get(PrismaService);
  const db = prisma.forUser({ userId });
  const task = await db.task.create({ data: { userId, name: 'Order', goal: 'Buy the item', allowedDomains: ['shop.example.test'] } });
  const run = await db.run.create({ data: { userId, taskId: task.id, goal: task.goal } });
  return { userId, prisma, db, run };
}

const notifier = { needsYou: async () => undefined, finished: async () => undefined };
const runnerOf = (prisma: PrismaService, fabric: FabricClient, ai: AiService) => new GoalRunnerService(prisma, app.get(TasksService), fabric, ai, notifier as never);

const rootsOf = (spans: ReadableSpan[]) => spans.filter((s) => s.name.startsWith('invoke_agent '));
const named = (spans: ReadableSpan[], prefix: string) => spans.filter((s) => s.name.startsWith(prefix));

describe('agent traces', () => {
  beforeEach(() => otel.reset());

  it('exports one trace per job: chunks, model calls, tool calls, fabric actions, the question, the links and runs.trace_id; and no marker anywhere', async () => {
    const recorded: { key: string; labels: Record<string, unknown> | undefined }[] = [];
    const metrics = app.get(AppMetricsService);
    const add = jest.spyOn(metrics, 'add').mockImplementation((key: string, _v?: number, labels?: Record<string, unknown>) => void recorded.push({ key, labels }));
    const record = jest.spyOn(metrics, 'record').mockImplementation((key: string, _v: number, labels?: Record<string, unknown>) => void recorded.push({ key, labels }));
    try {
      const { userId, prisma, db, run } = await newRun('tree');
      const fabric = fakeFabric();
      const { ai } = scriptedAi([
        // Job 1, chunk 1: navigate, type a marker, read the page, look at the elements.
        [
          ['navigate', { url: `https://shop.example.test/item?q=${TYPED}`, reason: 'open the shop' }],
          ['type_text', { selector: '#member', text: TYPED, submit: false, reason: 'the member number' }],
          ['read_text', { selector: null }],
          ['observe_elements', {}],
        ],
        // Job 1, chunk 2: ask the owner, with a marker in the question.
        [['request_human', { kind: 'confirmation', prompt: `Is ${QUESTION} the right plan?`, input: 'none', choices: null }]],
        // Job 2: ask for a code (the secret's marker is in the prompt: a prompt is never exported either).
        [['request_human', { kind: 'code', prompt: `Enter the code ${SECRET}`, input: 'secret', choices: null }]],
        // Job 3: type the handoff secret, finish.
        [
          ['type_handoff_secret', { selector: '#otp', submit: true }],
          ['finish', { success: true, result: 'Done' }],
        ],
      ]);
      const runner = runnerOf(prisma, fabric.client, ai);

      expect(await runner.advance(run.id, userId, null)).toBe('waiting_human');
      const job1 = otel.spans();
      const [root1] = rootsOf(job1);
      expect(rootsOf(job1)).toHaveLength(1);

      // The tree of the first job: one root, two chunks, a model call and a tool call per round, the fabric under its tool call, the question under request_human.
      const tree1 = treeOf(job1, root1!);
      expect(tree1[0]).toBe('invoke_agent hexactra.browser_agent');
      const chunks = childrenOf(job1, root1!).filter((s) => s.name === SPAN.chunk);
      expect(chunks).toHaveLength(2);
      expect(childrenOf(job1, root1!).every((s) => s.name === SPAN.chunk || s.name.startsWith('hexactra.fabric'))).toBe(true);
      const c1 = childrenOf(job1, chunks[0]!).map((s) => s.name);
      expect(c1.filter((n) => n === SPAN.modelCall('model-a'))).toHaveLength(4);
      expect(c1.filter((n) => n.startsWith('execute_tool '))).toEqual(['execute_tool navigate', 'execute_tool type_text', 'execute_tool read_text', 'execute_tool observe_elements']);
      const tools1 = childrenOf(job1, chunks[0]!).filter((s) => s.name.startsWith('execute_tool '));
      expect(childrenOf(job1, tools1[0]!).map((s) => s.name)).toEqual(['hexactra.fabric navigate']);
      expect(childrenOf(job1, tools1[2]!).map((s) => s.name)).toEqual(['hexactra.fabric text']);
      const ask = named(job1, 'execute_tool request_human')[0]!;
      expect(parentOf(ask)).toBe(chunks[1]!.spanContext().spanId);
      const askSpan = childrenOf(job1, ask).find((s) => s.name === SPAN.askHuman)!;
      expect(askSpan.events.map((e) => e.name)).toEqual([EVENT.asked]);
      expect(askSpan.attributes).toMatchObject({ [ATTR.questionKind]: 'confirmation', [ATTR.questionInput]: 'none' });

      // Root attributes and kinds.
      expect(root1!.kind).toBe(SpanKind.INTERNAL);
      expect(root1!.attributes).toMatchObject({ [ATTR.operationName]: OPERATION.invokeAgent, [ATTR.agentName]: 'hexactra.browser_agent', [ATTR.runId]: run.id, [ATTR.runTrigger]: 'manual', [ATTR.jobReason]: 'started', [ATTR.runStatus]: 'waiting_human', [ATTR.outcome]: 'waiting_human' });
      expect(root1!.attributes[ATTR.policyId]).toEqual(expect.any(String));
      expect(root1!.attributes[ATTR.tier]).toEqual(expect.any(String));
      expect(chunks[0]!.attributes).toMatchObject({ [ATTR.chunkNumber]: 1, [ATTR.chunkModelCalls]: 4, [ATTR.chunkToolCalls]: 4 });

      // A model call carries its model, provider, tokens, cached tokens, finish reason, tier and the fallback flag.
      const chat = named(job1, 'chat ')[0]!;
      expect(chat.kind).toBe(SpanKind.CLIENT);
      expect(chat.attributes).toMatchObject({
        [ATTR.operationName]: OPERATION.chat,
        [ATTR.providerName]: 'prov',
        [ATTR.requestModel]: 'model-a',
        [ATTR.responseModel]: 'model-a',
        [ATTR.usageInputTokens]: 100,
        [ATTR.usageOutputTokens]: 10,
        [ATTR.usageCachedInputTokens]: 40,
        [ATTR.finishReasons]: ['tool_calls'],
        [ATTR.fallbackModel]: false,
      });
      expect(chat.attributes[ATTR.tier]).toEqual(expect.any(String));
      // A tool call: name, call id, step, outcome, action, the host only.
      expect(tools1[0]!.attributes).toMatchObject({ [ATTR.operationName]: OPERATION.executeTool, [ATTR.toolName]: 'navigate', [ATTR.toolCallId]: 'call-1', [ATTR.stepOk]: true, [ATTR.actionType]: 'navigate', [ATTR.pageHost]: 'shop.example.test' });
      expect(tools1[0]!.attributes[ATTR.stepSeq]).toEqual(expect.any(Number));
      // Tool families (E41.1): each tool span names its family; the job's root carries the families offered and used.
      expect(tools1.map((t) => t.attributes[ATTR.toolFamily])).toEqual(['browser', 'browser', 'browser', 'browser']);
      expect(ask.attributes[ATTR.toolFamily]).toBe('human');
      expect(String(root1!.attributes[ATTR.runFamiliesOffered]).split(',')).toEqual(expect.arrayContaining(['browser', 'control', 'human']));
      expect(root1!.attributes[ATTR.runFamiliesUsed]).toBe('browser,human');
      expect(recorded.filter((r) => r.key === 'runToolCalls').map((r) => r.labels)).toEqual(expect.arrayContaining([{ family: 'browser', outcome: 'ok' }, { family: 'human', outcome: 'ok' }]));
      // A fabric span: the action's type, the operation id and its state.
      const fabricNav = childrenOf(job1, tools1[0]!)[0]!;
      expect(fabricNav.kind).toBe(SpanKind.CLIENT);
      expect(fabricNav.attributes).toMatchObject({ [ATTR.fabricAction]: 'navigate', [ATTR.fabricOperationId]: 'op-nav', [ATTR.fabricState]: 'succeeded' });

      const stored1 = await db.run.findFirstOrThrow({ where: { id: run.id } });
      expect(stored1.traceId).toBe(root1!.spanContext().traceId);
      expect(stored1.spanId).toBe(root1!.spanContext().spanId);

      // Job 2 resumes after the confirmation: a NEW trace, linked to the first job's root.
      otel.reset();
      const [confirm] = [...fabric.handoffs.values()];
      Object.assign(confirm!, { status: 'completed', response: { outcome: 'completed', value_withheld: false, channel: 'web', by: `user:${userId}` } });
      expect(await runner.advance(run.id, userId, null)).toBe('waiting_human');
      const job2 = otel.spans();
      const [root2] = rootsOf(job2);
      expect(root2!.spanContext().traceId).not.toBe(root1!.spanContext().traceId);
      expect(root2!.attributes[ATTR.jobReason]).toBe('resumed');
      expect(root2!.links).toHaveLength(1);
      expect(root2!.links[0]!.context).toMatchObject({ traceId: root1!.spanContext().traceId, spanId: root1!.spanContext().spanId });
      expect(root2!.links[0]!.attributes).toMatchObject({ [ATTR.linkType]: LINK.previousJob });
      // The answer is an event of the resumed job: kind, channel, outcome and how long the question waited; never the answer.
      const answered = named(job2, SPAN.askHuman).find((s) => s.events.some((e) => e.name === EVENT.answered))!;
      expect(answered.attributes).toMatchObject({ [ATTR.questionKind]: 'confirmation', [ATTR.questionChannel]: 'web', [ATTR.questionOutcome]: 'completed' });
      expect(answered.attributes[ATTR.questionWaitedMs]).toEqual(expect.any(Number));
      const stored2 = await db.run.findFirstOrThrow({ where: { id: run.id } });
      expect(stored2.traceId).toBe(root2!.spanContext().traceId);
      expect(stored2.spanId).toBe(root2!.spanContext().spanId);
      const trace2 = otel.spans().concat(job1);

      // Job 3: answer the secret request, type it, finish.
      otel.reset();
      const code = [...fabric.handoffs.values()][1]!;
      Object.assign(code, { status: 'completed', response: { outcome: 'completed', value_withheld: true, channel: 'web', by: `user:${userId}` } });
      expect(await runner.advance(run.id, userId, null)).toBe('succeeded');
      const job3 = otel.spans();
      const [root3] = rootsOf(job3);
      expect(root3!.links[0]!.context.traceId).toBe(root2!.spanContext().traceId);
      expect(root3!.attributes).toMatchObject({ [ATTR.jobReason]: 'resumed', [ATTR.runStatus]: 'succeeded', [ATTR.runStopReason]: 'finished' });
      expect(root3!.status.code).not.toBe(SpanStatusCode.ERROR);
      expect(named(job3, 'hexactra.fabric type_secret')).toHaveLength(1);

      const done = await db.run.findFirstOrThrow({ where: { id: run.id } });
      expect(done.traceId).toBe(root3!.spanContext().traceId);
      expect(done.traceIds).toEqual([root1!.spanContext().traceId, root2!.spanContext().traceId, root3!.spanContext().traceId]);
      // The run response carries the latest trace id and none of the internals; the export lists every job's trace.
      const view = (await app.get(TasksService).getRun(userId, run.id)) as unknown as Record<string, unknown>;
      expect(view.traceId).toBe(root3!.spanContext().traceId);
      expect(view).not.toHaveProperty('spanId');
      expect(view).not.toHaveProperty('traceIds');
      const exported = await app.get(RunTraceService).build(userId, run.id, { screenshots: 'none' });
      expect(exported.run.traceIds).toEqual(done.traceIds);

      // LEAK TEST: no span, event, link or metric label of any job carries a prompt, typed text, page text, a question or a secret.
      const everything = [...trace2, ...job3];
      expect(everything.length).toBeGreaterThan(20);
      const text = [...everything.map(spanText), JSON.stringify(recorded)].join('\n');
      for (const marker of ALL_MARKERS) expect(text).not.toContain(marker);
      // The full URL never leaves the process either: only the host.
      expect(text).not.toContain('/item?q=');
      for (const s of everything) {
        for (const key of Object.keys(s.attributes)) expect(key).not.toMatch(/^gen_ai\.(input|output|system_instructions|tool\.call\.(arguments|result))/);
      }
      // The metrics are recorded, by model and tier and by tool name, and with bounded labels only.
      const keys = [...new Set(recorded.map((r) => r.key))];
      expect(keys).toEqual(expect.arrayContaining(['runModelCallDuration', 'runModelCallTokens', 'runToolDuration']));
      expect(recorded.find((r) => r.key === 'runToolDuration' && r.labels?.tool === 'type_text')?.labels).toEqual({ tool: 'type_text', outcome: 'ok' });
      expect(recorded.find((r) => r.key === 'runModelCallDuration')?.labels).toMatchObject({ model: 'model-a' });
    } finally {
      add.mockRestore();
      record.mockRestore();
    }
  });

  it('a failed model call and a failed tool call set error.type and the span status', async () => {
    const failing = await newRun('fail');
    const fabric = fakeFabric({ failType: true });
    const { ai } = scriptedAi([[['type_text', { selector: '#x', text: TYPED, submit: false, reason: 'try' }]], { throw: new AiError('AI_PROVIDER_UNAVAILABLE', `down ${PAGE}`) }]);
    const err = await runnerOf(failing.prisma, fabric.client, ai).advance(failing.run.id, failing.userId, null).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(AiError);
    const spans = otel.spans();
    const tool = named(spans, 'execute_tool type_text')[0]!;
    expect(tool.status.code).toBe(SpanStatusCode.ERROR);
    expect(tool.attributes).toMatchObject({ [ATTR.errorType]: ERROR_TYPE.actionFailed, [ATTR.stepOk]: false });
    const fab = childrenOf(spans, tool)[0]!;
    expect(fab.status.code).toBe(SpanStatusCode.ERROR);
    expect(fab.attributes).toMatchObject({ [ATTR.errorType]: ERROR_TYPE.fabricError, [ATTR.fabricState]: 'failed' });
    const failed = named(spans, 'chat ').find((s) => s.attributes[ATTR.errorType])!;
    expect(failed.status.code).toBe(SpanStatusCode.ERROR);
    expect(failed.attributes[ATTR.errorType]).toBe('AI_PROVIDER_UNAVAILABLE');
    // The job ends in error: the root says so, without the message.
    const [root] = rootsOf(spans);
    expect(root!.status.code).toBe(SpanStatusCode.ERROR);
    expect(root!.attributes[ATTR.errorType]).toBe('AI_PROVIDER_UNAVAILABLE');
    expect(spans.map(spanText).join('\n')).not.toContain(PAGE);
  });

  it('with no tracer registered (the telemetry slice off) nothing is recorded or stored and the run behaves as before', async () => {
    await otel.uninstall();
    try {
      const { userId, prisma, db, run } = await newRun('off');
      const { ai } = scriptedAi([[['navigate', { url: 'https://shop.example.test/', reason: 'go' }], ['finish', { success: true, result: 'Done' }]]]);
      expect(await runnerOf(prisma, fakeFabric().client, ai).advance(run.id, userId, null)).toBe('succeeded');
      const done = await db.run.findFirstOrThrow({ where: { id: run.id } });
      expect(done).toMatchObject({ status: 'succeeded', result: 'Done', traceId: null, spanId: null, traceIds: [] });
      expect(otel.spans()).toEqual([]);
    } finally {
      otel = installMemoryTracing();
    }
  });
});
