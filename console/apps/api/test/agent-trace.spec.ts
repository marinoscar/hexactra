// The agent-trace module (E38.4, #585) without a database: the off state, the links, the error types, the cap on a
// run's trace ids, a call the loop never ran, and the guard that every attribute name lives in one file.
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { SpanStatusCode } from '@opentelemetry/api';
import { defineTool } from '@marinoscar/platform-api/ai';
import { z } from 'zod';

import { AgentTrace, errorTypeOf, MAX_TRACE_IDS, pageHost, storedSpanContext } from '../src/runner/agent-trace';
import { AGENT, ATTR, ERROR_TYPE, GENAI_SEMCONV_VERSION, LINK } from '../src/runner/trace-attributes';
import { RunMetrics } from '../src/tasks/run-metrics';
import { installMemoryTracing } from './helpers/otel-memory';

const recorder = () => {
  const calls: [string, string, number, Record<string, unknown> | undefined][] = [];
  const fake = {
    add: (k: string, v = 1, a?: Record<string, unknown>) => calls.push(['add', k, v, a]),
    record: (k: string, v: number, a?: Record<string, unknown>) => calls.push(['record', k, v, a]),
  };
  return { calls, metrics: new RunMetrics(fake as never) };
};

const tool = defineTool({ name: 'ping', description: 'Ping', parameters: z.object({}), execute: async () => 'pong' });

describe('with no tracer registered (the telemetry slice off)', () => {
  it('records nothing, stores no ids and changes no behaviour, but still counts the metrics', async () => {
    const { calls, metrics } = recorder();
    const tr = AgentTrace.start(AGENT.browser, metrics, { [ATTR.runId]: 'r' });
    expect(tr.recording).toBe(false);
    expect(tr.traceId).toBeNull();
    expect(tr.spanId).toBeNull();
    const write = jest.fn();
    await tr.beginRun({ trigger: 'manual', origin: 'web', status: 'queued', startedAt: null }, write);
    expect(write).not.toHaveBeenCalled();
    tr.chunkStart(1, 'standard');
    const [wrapped] = tr.wrapTools([tool]);
    // The wrapped tool is the tool: same name, same schema, same answer.
    expect(wrapped!.tool).toBe(tool.tool);
    expect(await wrapped!.execute({}, { userId: 'u' })).toBe('pong');
    expect(tr.within(() => 7)).toBe(7);
    tr.modelCall({ response: { provider: 'p', model: 'm', usage: { inputTokens: 5, outputTokens: 2 } }, calls: [{ callId: 'c', name: 'ping', status: 'ok', durationMs: 1 }] }, { model: 'm', usd: 0.1 });
    tr.asked({ kind: 'other', input: 'none' });
    tr.end({ outcome: 'succeeded' });
    expect(calls.map((c) => c[1])).toEqual(expect.arrayContaining(['runToolDuration', 'runModelCallDuration', 'runModelCallTokens']));
  });
});

describe('with a tracer', () => {
  let otel: ReturnType<typeof installMemoryTracing>;
  beforeEach(() => {
    otel = installMemoryTracing();
  });
  afterEach(async () => {
    await otel.uninstall();
  });

  it('links a first job to the chat turn that made the run, and a later job to the previous job', async () => {
    const turn = storedSpanContext('a'.repeat(32), 'b'.repeat(16))!;
    const first = AgentTrace.start(AGENT.browser);
    await first.beginRun({ trigger: 'chat', origin: 'web', status: 'queued', startedAt: null, traceId: turn.traceId, spanId: turn.spanId }, async () => undefined);
    first.end({});
    const resumed = AgentTrace.start(AGENT.browser);
    await resumed.beginRun({ trigger: 'chat', origin: 'web', status: 'waiting_human', startedAt: new Date(), traceId: 'c'.repeat(32), spanId: 'd'.repeat(16) }, async () => undefined);
    resumed.end({});
    const hop = AgentTrace.start(AGENT.browser);
    await hop.beginRun({ trigger: 'chat', origin: 'web', status: 'running', startedAt: new Date(), traceId: 'c'.repeat(32), spanId: 'd'.repeat(16) }, async () => undefined);
    hop.end({});
    const [a, b, c] = otel.spans();
    expect(a!.attributes[ATTR.jobReason]).toBe('started');
    expect(a!.links[0]).toMatchObject({ context: { traceId: turn.traceId, spanId: turn.spanId }, attributes: { [ATTR.linkType]: LINK.startedBy } });
    expect(b!.attributes[ATTR.jobReason]).toBe('resumed');
    expect(b!.links[0]!.attributes).toMatchObject({ [ATTR.linkType]: LINK.previousJob });
    expect(c!.attributes[ATTR.jobReason]).toBe('continued');
  });

  it('ignores a stored id that is not a valid span context', async () => {
    const tr = AgentTrace.start(AGENT.browser);
    await tr.beginRun({ trigger: 'manual', origin: 'web', status: 'running', startedAt: new Date(), traceId: 'not-hex', spanId: 'nope' }, async () => undefined);
    tr.end({});
    expect(otel.spans()[0]!.links).toEqual([]);
  });

  it('keeps the newest trace ids of a run, once each, and never fails the run when the write does', async () => {
    const known = Array.from({ length: MAX_TRACE_IDS + 5 }, (_, i) => i.toString(16).padStart(32, '0'));
    const tr = AgentTrace.start(AGENT.browser);
    let data: { traceId: string; traceIds: string[] } | null = null;
    await tr.persist(known, async (d) => void (data = d));
    expect(data!.traceIds).toHaveLength(MAX_TRACE_IDS);
    expect(data!.traceIds.at(-1)).toBe(tr.traceId);
    await expect(tr.persist(known, async () => Promise.reject(new Error('db down')))).resolves.toBeUndefined();
    tr.end({});
  });

  it('gives a call the loop never ran (unknown tool, invalid arguments, a timeout) its own span with error.type', () => {
    const tr = AgentTrace.start(AGENT.browser);
    tr.chunkStart(1, 'fast');
    tr.modelCall(
      {
        response: { provider: 'p', model: 'm' },
        calls: [
          { callId: '1', name: 'nope', status: 'unknown_tool', durationMs: 0 },
          { callId: '2', name: 'click', status: 'invalid_arguments', durationMs: 0 },
        ],
      },
      { model: 'm', usd: null },
    );
    tr.end({ status: 'failed' });
    const spans = otel.spans();
    const nope = spans.find((s) => s.name === 'execute_tool nope')!;
    expect(nope.attributes).toMatchObject({ [ATTR.errorType]: ERROR_TYPE.unknownTool, [ATTR.toolCallId]: '1' });
    expect(nope.status.code).toBe(SpanStatusCode.ERROR);
    expect(spans.find((s) => s.name === 'execute_tool click')!.attributes[ATTR.errorType]).toBe(ERROR_TYPE.invalidArguments);
    // An unpriced call carries no cost attribute; a failed run marks its root.
    expect(spans.find((s) => s.name === 'chat m')!.attributes).not.toHaveProperty(ATTR.costUsd);
    const root = spans.find((s) => s.name.startsWith('invoke_agent'))!;
    expect(root.status.code).toBe(SpanStatusCode.ERROR);
    expect(root.attributes[ATTR.errorType]).toBe(ERROR_TYPE.runFailed);
  });

  it('a priced call carries its cost', () => {
    const tr = AgentTrace.start(AGENT.browser);
    tr.modelCall({ response: { model: 'm' } }, { model: 'm', usd: 0.0123 });
    tr.end({});
    expect(otel.spans().find((s) => s.name === 'chat m')!.attributes[ATTR.costUsd]).toBe(0.0123);
  });
});

describe('helpers', () => {
  it('names a page by its host only', () => {
    expect(pageHost('https://shop.example.test/item?q=secret#frag')).toBe('shop.example.test');
    expect(pageHost('not a url')).toBeUndefined();
    expect(pageHost(undefined)).toBeUndefined();
    expect(pageHost('javascript:alert(1)')).toBeUndefined();
  });

  it('types an error by its code or class name, never its message', () => {
    expect(errorTypeOf(Object.assign(new Error('has a marker in it'), { code: 'AI_RATE_LIMITED' }))).toBe('AI_RATE_LIMITED');
    expect(errorTypeOf(new TypeError('has a marker in it'))).toBe('TypeError');
    expect(errorTypeOf('a string with a marker')).toBe(ERROR_TYPE.other);
  });
});

describe('one file of attribute names', () => {
  const srcRoot = join(__dirname, '..', 'src');
  const walk = (dir: string): string[] => readdirSync(dir).flatMap((f) => (statSync(join(dir, f)).isDirectory() ? walk(join(dir, f)) : f.endsWith('.ts') ? [join(dir, f)] : []));

  it('no GenAI attribute or console trace attribute is spelled outside runner/trace-attributes.ts', () => {
    expect(GENAI_SEMCONV_VERSION).toMatch(/^\d+\.\d+\.\d+$/);
    const owner = join(srcRoot, 'runner', 'trace-attributes.ts');
    const literal = /['"`](gen_ai\.[a-z_.]+|error\.type|hexactra\.(run|job|step|chunk|tier|policy|question|fabric|page|gate|model|cost|action|conversation|link)\.[a-z_.]+)['"`]/;
    const offenders = walk(srcRoot)
      .filter((f) => f !== owner)
      // Code only: comments may name an attribute to explain it.
      .filter((f) => literal.test(readFileSync(f, 'utf8').replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '')));
    expect(offenders).toEqual([]);
  });
});
