// Agent traces (E38.4, #585): one OpenTelemetry trace per run JOB, with a span for every chunk,
// model call, tool call, fabric action and question, so an engineer can open one trace and see
// a slow, expensive or failed run as a tree. Standard OpenTelemetry only: no viewer, no run-page view.
//
//   invoke_agent hexactra.browser_agent      the job (the root of its trace)
//   ├─ hexactra.chunk                        one chunk of the loop
//   │  ├─ chat <model>                       one model call (CLIENT)
//   │  ├─ execute_tool <tool>                one tool call
//   │  │  └─ hexactra.fabric <action>        one fabric operation (CLIENT; W3C trace context goes on to the fabric)
//   │  └─ ai.request …                       the platform's own span for the same round trip (see below)
//   └─ hexactra.ask_human                    a question asked, or answered (span events)
//
// The job that resumes a run starts a NEW trace whose root carries a span link to the previous job's root.
//
// WHAT NEVER GOES IN: a prompt, a model answer, typed text, page text, a URL beyond its host, a selector, a
// question or its answer, a memory, a parameter value, a secret. Spans carry names, counts, sizes,
// durations and outcomes; every attribute name is in `trace-attributes.ts`, and the leak test
// (test/agent-trace.db.spec.ts) walks every span, event, link and metric label for markers.
//
// The finding about `AiService.runTools` (@marinoscar/platform-api/ai): it already opens an `ai.request` span per
// provider round trip (`ai.provider`, `ai.model`, `ai.usage.*`), under whatever context is active when it is
// called, and the provider adapter its `ai.provider.call`. They carry no GenAI names and no console facts (cost,
// tier, fallback), and they end before `onStep` fires, so they cannot be enriched. They are NOT duplicated: this
// module runs each `runTools` call inside the chunk's context, so they nest under the chunk, and adds the
// `chat <model>` span (GenAI names, cost, tier, fallback) from the `onStep` data, timed from the previous round.
//
// With no SDK registered (the telemetry slice off) every span here is the API's non-recording span: nothing is
// exported, `traceId` is null, and nothing is stored.
import { context, createContextKey, ROOT_CONTEXT, SpanKind, SpanStatusCode, trace, type Attributes, type Context, type Span, type SpanContext } from '@opentelemetry/api';
import type { AiDefinedTool } from '@marinoscar/platform-api/ai';

import type { RunMetrics } from '../tasks/run-metrics';
import { ATTR, TOOL_ATTRIBUTES, EVENT, ERROR_TYPE, LINK, OPERATION, SPAN, TRACER_NAME, type JobReason } from './trace-attributes';

export const tracer = () => trace.getTracer(TRACER_NAME);

/** The context key that carries the job's {@link AgentTrace}: how a fabric call knows it is inside a run. */
export const AGENT_KEY = createContextKey('hexactra.agent-trace');
/** The context key that carries the tool call now running, so a recorded step can mark it. */
export const TOOL_KEY = createContextKey('hexactra.tool-call');

/** The most trace ids a run keeps (`runs.trace_ids`). */
export const MAX_TRACE_IDS = 100;

/** A tool call as it runs. */
import { errorTypeOf, pageHost, storedSpanContext, type PendingTool, type StepFacts } from './agent-trace-support';

export { errorTypeOf, pageHost, storedSpanContext, type StepFacts };

export class AgentTrace {
  private readonly root: Span;
  private readonly rootCtx: Context;
  private chunkSpan: Span | null = null;
  private chunkCtx: Context | null = null;
  private chunkModelCalls = 0;
  private chunkToolCalls = 0;
  private fallback = false;
  private tier = '';
  private roundStart = Date.now();
  private pending: PendingTool[] = [];
  private closed = false;

  private constructor(
    private readonly agent: string,
    private readonly metrics?: RunMetrics,
    attributes: Attributes = {},
  ) {
    this.root = tracer().startSpan(SPAN.runJob(agent), { kind: SpanKind.INTERNAL, root: true, attributes: { [ATTR.operationName]: OPERATION.invokeAgent, [ATTR.agentName]: agent, ...attributes } }, ROOT_CONTEXT);
    this.rootCtx = trace.setSpan(ROOT_CONTEXT, this.root).setValue(AGENT_KEY, this);
  }

  /** Starts the root span of a job (or of a chat turn): a new trace, whatever is active. */
  static start(agent: string, metrics?: RunMetrics, attributes?: Attributes): AgentTrace {
    return new AgentTrace(agent, metrics, attributes);
  }

  /** Whether spans are really recorded (an SDK is registered). */
  get recording(): boolean {
    return this.root.isRecording();
  }

  /** The trace id of the root span, or null when nothing is recorded. */
  get traceId(): string | null {
    return this.recording ? this.root.spanContext().traceId : null;
  }

  /** The span id of the root span, or null when nothing is recorded. */
  get spanId(): string | null {
    return this.recording ? this.root.spanContext().spanId : null;
  }

  /** The span context of the root, for a link from another trace. */
  get spanContext(): SpanContext {
    return this.root.spanContext();
  }

  /** Attributes on the root span. */
  describe(attributes: Attributes): void {
    if (this.recording) this.root.setAttributes(attributes);
  }

  /** A link from this job's root to an earlier span (the previous job, or the chat turn that started the run). */
  linkTo(target: SpanContext | null, type: (typeof LINK)[keyof typeof LINK]): void {
    if (this.recording && target) this.root.addLink({ context: target, attributes: { [ATTR.linkType]: type } });
  }

  /** Why this job started (`hexactra.job.reason`). */
  setReason(reason: JobReason): void {
    this.describe({ [ATTR.jobReason]: reason });
  }

  /** The policy the run runs under (`hexactra.policy.id`). */
  setPolicy(ref: string): void {
    this.describe({ [ATTR.policyId]: ref });
  }

  /**
   * The start of a run job: what kind of job it is, the link to what came before (the previous job of the run, or the
   * chat turn that started it) and the ids the run row keeps. `write` is the run's own `updateMany` data.
   */
  async beginRun(
    run: { trigger: string; origin: string; status: string; startedAt: Date | null; pausedAt?: Date | null; traceId?: string | null; spanId?: string | null; traceIds?: readonly string[] | null },
    write: (data: { traceId: string; spanId: string; traceIds: string[] }) => Promise<unknown>,
  ): Promise<void> {
    if (!this.recording) return;
    const resumed = run.status === 'waiting_human' || (run.status === 'queued' && Boolean(run.pausedAt));
    const continued = !resumed && run.startedAt !== null;
    this.describe({ [ATTR.runTrigger]: run.trigger, [ATTR.runOrigin]: run.origin });
    this.setReason(resumed ? 'resumed' : continued ? 'continued' : 'started');
    // A run that never ran holds the chat turn's span (the chat made it); one that ran holds its previous job's root.
    this.linkTo(storedSpanContext(run.traceId, run.spanId), resumed || continued ? LINK.previousJob : LINK.startedBy);
    await this.persist(run.traceIds, write);
  }

  /** The tier now in force: attributes of the chunks and the model calls after this. */
  setTier(tier: string): void {
    this.tier = tier;
    this.describe({ [ATTR.tier]: tier });
  }

  /**
   * What the run row keeps of this job: its trace and span ids, and the trace ids so far. Never called without a
   * recording; `write` is the run's own `updateMany` data. Never fails the run.
   */
  async persist(known: readonly string[] | null | undefined, write: (data: { traceId: string; spanId: string; traceIds: string[] }) => Promise<unknown>): Promise<void> {
    const traceId = this.traceId;
    const spanId = this.spanId;
    if (!traceId || !spanId) return;
    try {
      await write({ traceId, spanId, traceIds: [...(known ?? []).filter((t) => t !== traceId), traceId].slice(-MAX_TRACE_IDS) });
    } catch {
      /* a trace id is a convenience: losing it never fails a run */
    }
  }

  // ------------------------------------------------------------------ chunks

  /** A new chunk (the previous one ends): the model calls and tool calls until the next one are its children. */
  chunkStart(number: number, tier: string): void {
    this.endChunk();
    this.tier = tier;
    this.fallback = false;
    this.chunkModelCalls = 0;
    this.chunkToolCalls = 0;
    this.chunkSpan = tracer().startSpan(SPAN.chunk, { kind: SpanKind.INTERNAL, attributes: { [ATTR.chunkNumber]: number, [ATTR.tier]: tier } }, this.rootCtx);
    this.chunkCtx = trace.setSpan(this.rootCtx, this.chunkSpan);
  }

  /** The chunk goes on the tier's fallback model (the flag of the model-call spans after this). */
  useFallback(): void {
    this.fallback = true;
  }

  private endChunk(): void {
    this.flushPending();
    if (!this.chunkSpan) return;
    this.chunkSpan.setAttributes({ [ATTR.chunkModelCalls]: this.chunkModelCalls, [ATTR.chunkToolCalls]: this.chunkToolCalls });
    this.chunkSpan.end();
    this.chunkSpan = null;
    this.chunkCtx = null;
  }

  /** The context new spans of this job nest under: the chunk's, else the root's. */
  get currentContext(): Context {
    return this.chunkCtx ?? this.rootCtx;
  }

  /** Runs one `runTools` call inside the chunk's context, so the platform's own `ai.request` spans nest under it. */
  within<T>(fn: () => T): T {
    this.roundStart = Date.now();
    return context.with(this.currentContext, fn);
  }

  // ------------------------------------------------------------- model calls

  /**
   * One model round trip finished (`onStep`): a `chat <model>` span from the end of the previous round to the
   * start of its first tool call (or now), with its tokens, cost and fallback flag; and the round's tool calls are
   * settled with the ids and statuses the loop reports.
   */
  modelCall(step: StepFacts, extra: { model: string; usd: number | null }): void {
    const now = Date.now();
    const { response } = step;
    const input = response.usage?.inputTokens ?? 0;
    const output = response.usage?.outputTokens ?? 0;
    const endedAt = Math.min(now, this.pending[0]?.start ?? now);
    this.metrics?.modelCallDone(extra.model, this.tier || 'none', Math.max(0, (endedAt - this.roundStart) / 1000), input, output);
    this.chunkModelCalls += 1;
    if (this.recording) {
      const attrs: Attributes = {
        [ATTR.operationName]: OPERATION.chat,
        [ATTR.requestModel]: extra.model,
        [ATTR.responseModel]: response.model || extra.model,
        [ATTR.usageInputTokens]: input,
        [ATTR.usageOutputTokens]: output,
        [ATTR.fallbackModel]: this.fallback,
        ...(this.tier ? { [ATTR.tier]: this.tier } : {}),
        ...(response.provider ? { [ATTR.providerName]: response.provider } : {}),
        ...(response.usage?.cachedInputTokens ? { [ATTR.usageCachedInputTokens]: response.usage.cachedInputTokens } : {}),
        ...(response.finishReason ? { [ATTR.finishReasons]: [response.finishReason] } : {}),
        ...(extra.usd !== null ? { [ATTR.costUsd]: extra.usd } : {}),
      };
      const span = tracer().startSpan(SPAN.modelCall(extra.model), { kind: SpanKind.CLIENT, startTime: this.roundStart, attributes: attrs }, this.currentContext);
      span.end(endedAt);
      this.settleTools(step.calls ?? [], now);
    }
    this.roundStart = now;
  }

  /** A model call that failed (a provider error, a refusal): a `chat <model>` span with `error.type` and an error status. */
  modelFailed(error: unknown, model: string): void {
    const now = Date.now();
    const type = errorTypeOf(error);
    if (this.recording) {
      const span = tracer().startSpan(
        SPAN.modelCall(model),
        {
          kind: SpanKind.CLIENT,
          startTime: this.roundStart,
          attributes: { [ATTR.operationName]: OPERATION.chat, [ATTR.requestModel]: model, [ATTR.errorType]: type, [ATTR.fallbackModel]: this.fallback, ...(this.tier ? { [ATTR.tier]: this.tier } : {}) },
        },
        this.currentContext,
      );
      span.setStatus({ code: SpanStatusCode.ERROR });
      span.end(now);
    }
    this.chunkModelCalls += 1;
    this.roundStart = now;
  }

  // -------------------------------------------------------------- tool calls

  /** The tools, each wrapped so a call opens an `execute_tool <name>` span (and a duration metric). */
  wrapTools(tools: AiDefinedTool[]): AiDefinedTool[] {
    return tools.map((t) => ({
      ...t,
      execute: (args: never, ctx: never) => this.runTool(t, args, ctx),
    })) as AiDefinedTool[];
  }

  private runTool(tool: AiDefinedTool, args: never, ctx: never): Promise<unknown> {
    return this.toolCall(tool.tool.name, () => (tool.execute as (a: never, c: never) => Promise<unknown>)(args, ctx));
  }

  /** One tool call: opens its `execute_tool <name>` span and times it (the `TelemetryPort` of the harness). */
  async toolCall<T>(name: string, fn: () => Promise<T>): Promise<T> {
    const entry: PendingTool = { name, start: Date.now() };
    let active = this.currentContext;
    if (this.recording) {
      entry.span = tracer().startSpan(SPAN.toolCall(name), { kind: SpanKind.INTERNAL, startTime: entry.start, attributes: { [ATTR.operationName]: OPERATION.executeTool, [ATTR.toolName]: name } }, active);
      this.pending.push(entry);
      active = trace.setSpan(active, entry.span);
    }
    this.chunkToolCalls += 1;
    try {
      return await context.with(active.setValue(TOOL_KEY, entry), fn);
    } catch (e) {
      entry.thrown = true;
      throw e;
    } finally {
      entry.endedAt = Date.now();
      this.metrics?.toolDone(name, !entry.thrown && entry.ok !== false, (entry.endedAt - entry.start) / 1000);
    }
  }

  /** Marks the tool call now running with the step it recorded (never its arguments). */
  stepRecorded(info: { seq: number; ok: boolean; action: string | null; url?: unknown }): void {
    const entry = context.active().getValue(TOOL_KEY) as PendingTool | undefined;
    if (!entry) return;
    entry.seq = info.seq;
    entry.ok = info.ok;
    if (info.action) entry.action = info.action;
    const host = pageHost(info.url);
    if (host) entry.host = host;
  }

  /** The tool call now running was gated (a commitment: payment, order, message): its category. */
  gated(category: string): void {
    const entry = context.active().getValue(TOOL_KEY) as PendingTool | undefined;
    if (entry) entry.gate = category;
  }

  /** Closed, content-free attributes of the tool call now running (`TOOL_ATTRIBUTES`): any other name is dropped. */
  toolAttributes(attrs: Record<string, string | number | boolean>): void {
    const entry = context.active().getValue(TOOL_KEY) as PendingTool | undefined;
    if (!entry) return;
    for (const [k, v] of Object.entries(attrs)) if (TOOL_ATTRIBUTES.includes(k)) (entry.attrs ??= {})[k] = v;
  }

  /** Ends one tool span with what is known about the call. */
  private endTool(entry: PendingTool, record: { callId?: string; status?: string } | null, at: number): void {
    const span = entry.span;
    if (!span) return;
    const status = record?.status ?? (entry.thrown ? 'error' : 'ok');
    const failed = status !== 'ok' || entry.ok === false;
    span.setAttributes({
      ...(record?.callId ? { [ATTR.toolCallId]: record.callId } : {}),
      ...(entry.seq !== undefined ? { [ATTR.stepSeq]: entry.seq } : {}),
      ...(entry.ok !== undefined ? { [ATTR.stepOk]: entry.ok } : {}),
      ...(entry.action ? { [ATTR.actionType]: entry.action } : {}),
      ...(entry.host ? { [ATTR.pageHost]: entry.host } : {}),
      ...(entry.gate ? { [ATTR.gateCategory]: entry.gate } : {}),
      ...(entry.attrs ?? {}),
    });
    if (failed) {
      span.setAttribute(ATTR.errorType, status === 'timeout' ? ERROR_TYPE.timeout : status === 'invalid_arguments' ? ERROR_TYPE.invalidArguments : status === 'unknown_tool' ? ERROR_TYPE.unknownTool : status === 'error' ? ERROR_TYPE.toolError : ERROR_TYPE.actionFailed);
      span.setStatus({ code: SpanStatusCode.ERROR });
    }
    span.end(at);
  }

  /** Pairs the round's tool calls with their spans, in order; a call the loop never ran (unknown tool, bad arguments) gets its own span. */
  private settleTools(calls: NonNullable<StepFacts['calls']>, now: number): void {
    for (const call of calls) {
      if (call.status === 'unknown_tool' || call.status === 'invalid_arguments') {
        const span = tracer().startSpan(SPAN.toolCall(call.name), { kind: SpanKind.INTERNAL, startTime: Math.max(0, now - call.durationMs), attributes: { [ATTR.operationName]: OPERATION.executeTool, [ATTR.toolName]: call.name } }, this.currentContext);
        const entry: PendingTool = { name: call.name, start: now, span };
        this.endTool(entry, call, now);
        continue;
      }
      const at = this.pending.findIndex((p) => p.name === call.name);
      if (at < 0) continue;
      const [entry] = this.pending.splice(at, 1);
      this.endTool(entry!, call, entry!.endedAt ?? now);
    }
  }

  /** Ends the tool spans the loop never reported (it threw between a tool and `onStep`). */
  private flushPending(): void {
    const now = Date.now();
    for (const entry of this.pending.splice(0)) this.endTool(entry, null, entry.endedAt ?? now);
  }

  // --------------------------------------------------------------- questions

  /** A question was asked (a span with an event: the wait itself is never a span that stays open across jobs). */
  asked(facts: { kind: string; input: string }): void {
    if (!this.recording) return;
    // Inside a tool call (`request_human`) the question hangs under that call; from a stall, under the chunk.
    const active = context.active();
    const parent = active.getValue(AGENT_KEY) === this && active.getValue(TOOL_KEY) ? active : this.currentContext;
    const span = tracer().startSpan(SPAN.askHuman, { kind: SpanKind.INTERNAL, attributes: { [ATTR.questionKind]: facts.kind, [ATTR.questionInput]: facts.input } }, parent);
    span.addEvent(EVENT.asked, { [ATTR.questionKind]: facts.kind, [ATTR.questionInput]: facts.input });
    span.end();
  }

  /** The question was answered (in the job that resumes the run): the kind, the channel and how long it waited. Never the answer. */
  answered(facts: { kind: string; input: string | null; channel: string | null; outcome: string; waitedMs: number | null }): void {
    if (!this.recording) return;
    const attrs: Attributes = {
      [ATTR.questionKind]: facts.kind,
      [ATTR.questionOutcome]: facts.outcome,
      ...(facts.input ? { [ATTR.questionInput]: facts.input } : {}),
      ...(facts.channel ? { [ATTR.questionChannel]: facts.channel } : {}),
      ...(facts.waitedMs !== null ? { [ATTR.questionWaitedMs]: Math.max(0, Math.round(facts.waitedMs)) } : {}),
    };
    const span = tracer().startSpan(SPAN.askHuman, { kind: SpanKind.INTERNAL, attributes: attrs }, this.rootCtx);
    span.addEvent(EVENT.answered, attrs);
    span.end();
  }

  // --------------------------------------------------------------------- end

  /** Ends the job's trace: the final status and stop reason of the run, or the error that ended the job. */
  end(result: { outcome?: string; status?: string | null; stopReason?: string | null; error?: unknown }): void {
    if (this.closed) return;
    this.closed = true;
    this.endChunk();
    if (this.recording) {
      this.root.setAttributes({
        ...(result.outcome ? { [ATTR.outcome]: result.outcome } : {}),
        ...(result.status ? { [ATTR.runStatus]: result.status } : {}),
        ...(result.stopReason ? { [ATTR.runStopReason]: result.stopReason } : {}),
      });
      if (result.error !== undefined) {
        this.root.setAttribute(ATTR.errorType, errorTypeOf(result.error));
        this.root.setStatus({ code: SpanStatusCode.ERROR });
      } else if (result.status === 'failed') {
        this.root.setAttribute(ATTR.errorType, ERROR_TYPE.runFailed);
        this.root.setStatus({ code: SpanStatusCode.ERROR });
      }
    }
    this.root.end();
  }
}
