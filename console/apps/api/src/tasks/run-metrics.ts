// The console's run metrics (`app.runs.*`), exported through OTLP like the
// platform's own and charted by the "Browser agents" telemetry group
// (platform/telemetry/runs.metric-group.ts). Labels are bounded enums: never
// a user, task, URL or goal (those belong to the run record, not to a metric).
import { Injectable, Optional } from '@nestjs/common';
import { AppMetricsService } from '@marinoscar/platform-api/host';
import { registerAppMetrics, type AppMetricDef } from '@marinoscar/platform-api/otel-core';

const TRIGGERS = ['manual', 'schedule', 'api', 'mcp', 'external', 'chat', 'email', 'benchmark'] as const;
const STATUSES = ['succeeded', 'failed', 'cancelled'] as const;
/** How deleted runs were chosen (#421); `retention` is the nightly rule (#422). */
export const RUN_DELETE_MODES = ['single', 'ids', 'filter', 'retention'] as const;
export type RunDeleteMode = (typeof RUN_DELETE_MODES)[number];
const STEP_KINDS = ['action', 'handoff', 'finish', 'error', 'note'] as const;
/** The key moments a trace screenshot is taken at (#541; runner/trace.ts). */
const TRACE_MOMENTS = ['question', 'before_confirmed', 'after_confirmed', 'failure', 'final', 'saved'] as const;
const TRACE_RESULTS = ['stored', 'skipped', 'failed'] as const;
/** The formats of a run export: the JSON file (#542) and the PDF report (#543). */
const RUN_EXPORT_FORMAT_LABELS = ['json', 'pdf'] as const;

/** The outcomes of a saved-card use (E37.7): `typed` (every field went in), a refusal code of the fabric, or a gate of the server. */
export const CARD_USE_OUTCOMES = ['typed', 'asked', 'approved', 'declined', 'refused_amount', 'refused_shop', 'refused_limit', 'refused_other', 'unattended_waits', 'mismatch'] as const;

/** Names are permanent once dashboards read them. */
/** The outcomes of a tool call in `app.runs.tool_calls` (E41.1). */
export const TOOL_CALL_OUTCOMES = ['ok', 'error', 'refused'] as const;

export const RUN_METRICS: readonly AppMetricDef[] = [
  { key: 'runsStarted', name: 'app.runs.started', kind: 'counter', unit: '{run}', description: 'Runs that started executing.', attributes: { trigger: { kind: 'enum', values: TRIGGERS } } },
  {
    key: 'runsFinished',
    name: 'app.runs.finished',
    kind: 'counter',
    unit: '{run}',
    description: 'Runs that ended, by outcome.',
    attributes: { status: { kind: 'enum', values: STATUSES }, trigger: { kind: 'enum', values: TRIGGERS } },
  },
  {
    key: 'runDuration',
    name: 'app.runs.duration',
    kind: 'histogram',
    unit: 's',
    description: 'Wall time of a run from its start to its end, waits for a person included.',
    buckets: [5, 15, 30, 60, 120, 300, 600, 1800, 3600],
    attributes: { status: { kind: 'enum', values: STATUSES } },
  },
  {
    key: 'runSteps',
    name: 'app.runs.steps',
    kind: 'counter',
    unit: '{step}',
    description: 'Recorded run steps, by kind and success.',
    attributes: { kind: { kind: 'enum', values: STEP_KINDS }, ok: { kind: 'enum', values: ['true', 'false'] } },
  },
  { key: 'runHandoffs', name: 'app.runs.handoffs', kind: 'counter', unit: '{handoff}', description: 'Times a run waited for a person (CAPTCHA, code, sign-in, confirmation).' },
  {
    key: 'runTokens',
    name: 'app.runs.tokens',
    kind: 'counter',
    unit: '{token}',
    description: "Model tokens the goal runner used: the AI cost of browser agents.",
    attributes: { direction: { kind: 'enum', values: ['input', 'output'] } },
  },
  { key: 'runModelCalls', name: 'app.runs.model_calls', kind: 'counter', unit: '{call}', description: 'Model calls (provider round trips) the goal runner made.' },
  {
    key: 'runCost',
    name: 'app.runs.cost',
    kind: 'histogram',
    unit: 'USD',
    description: 'Model spend of a finished run in USD, from the admin price table. Runs with an unpriced call are left out (their cost is only a lower bound).',
    buckets: [0.01, 0.05, 0.1, 0.25, 0.5, 1, 2, 5, 10, 25],
    attributes: { status: { kind: 'enum', values: STATUSES } },
  },
  {
    key: 'runStopLatency',
    name: 'app.runs.stop_latency_ms',
    kind: 'histogram',
    unit: 'ms',
    description: 'How long a run took to end after its owner pressed Stop (E38.1), from the request to the terminal status.',
    buckets: [250, 500, 1000, 2000, 3000, 5000, 10000, 30000, 60000],
    attributes: { status: { kind: 'enum', values: STATUSES } },
  },
  {
    key: 'runInputTokensPerCall',
    name: 'app.runs.input_tokens_per_call',
    kind: 'histogram',
    unit: '{token}',
    description: 'Input tokens of one model call of the goal runner: how much context each round re-sends (context settings of the agent policy).',
    buckets: [500, 1000, 2000, 4000, 8000, 16000, 32000, 64000, 128000],
  },
  {
    key: 'runsDeleted',
    name: 'app.runs.deleted',
    kind: 'counter',
    unit: '{run}',
    description: 'Runs deleted from the history, by how they were chosen: one run, a list of ids, a filter, or the retention rule.',
    attributes: { mode: { kind: 'enum', values: RUN_DELETE_MODES } },
  },
  {
    key: 'runTraceScreenshots',
    name: 'app.runs.trace_screenshots',
    kind: 'counter',
    unit: '{image}',
    description: 'Masked trace screenshots of runs (#541), by key moment and result: stored, skipped (no storage, capped, no page) or failed.',
    attributes: { moment: { kind: 'enum', values: TRACE_MOMENTS }, result: { kind: 'enum', values: TRACE_RESULTS } },
  },
  {
    key: 'runTraceScreenshotBytes',
    name: 'app.runs.trace_screenshot_bytes',
    kind: 'histogram',
    unit: 'By',
    description: 'Size of one stored trace screenshot: what the run history costs in object storage.',
    buckets: [20_000, 50_000, 100_000, 150_000, 250_000, 500_000, 1_000_000],
  },
  {
    key: 'runsExported',
    name: 'app.runs.exported',
    kind: 'counter',
    unit: '{file}',
    description: 'Run trace files exported (#542), by format and whether the screenshots were embedded.',
    attributes: { format: { kind: 'enum', values: RUN_EXPORT_FORMAT_LABELS }, screenshots: { kind: 'enum', values: ['embed', 'none'] } },
  },
  {
    key: 'runsRecovered',
    name: 'app.runs.recovered',
    kind: 'counter',
    unit: '{run}',
    description: 'Times a run was recovered after its job was interrupted (a crash, a deploy, a lost lease), by whether a step may or may not have happened (`unknown_steps`: 0 or 1+). No run or user in a label.',
    attributes: { unknown_steps: { kind: 'enum', values: ['0', '1+'] } },
  },
  {
    key: 'runBatchErrors',
    name: 'app.runs.batch.errors',
    kind: 'counter',
    unit: '{error}',
    description: 'Errors of the batch service (E51.1): starting the next row, recording a row\'s end or reconciling a batch. A batch error never changes a run.',
    attributes: { stage: { kind: 'enum', values: ['start_next', 'run_end', 'reconcile'] } },
  },
  {
    key: 'secretsCardUses',
    name: 'app.secrets.card_uses',
    kind: 'counter',
    unit: '{use}',
    description: 'Saved-card uses (E37.7), by outcome: typed, asked (the owner was asked), refused (amount, shop, limit, other), an unattended run that waits for the owner, or an amount mismatch after paying. No card, shop or user in a label.',
    attributes: { outcome: { kind: 'enum', values: CARD_USE_OUTCOMES } },
  },
  {
    key: 'runModelCallDuration',
    name: 'app.runs.model_call_duration',
    kind: 'histogram',
    unit: 's',
    description: 'One model call of a browser agent (E38.4), by model and tier: the GenAI client operation duration. The metric registry only accepts `app.` names, so the GenAI client metric names themselves cannot be used.',
    buckets: [0.25, 0.5, 1, 2, 4, 8, 16, 32, 64],
    attributes: { model: { kind: 'free' }, tier: { kind: 'free' } },
  },
  {
    key: 'runModelCallTokens',
    name: 'app.runs.model_call_tokens',
    kind: 'histogram',
    unit: '{token}',
    description: 'Tokens of one model call of a browser agent (E38.4), by direction, model and tier: the GenAI client token usage.',
    buckets: [100, 500, 1000, 2000, 4000, 8000, 16000, 32000, 64000, 128000],
    attributes: { direction: { kind: 'enum', values: ['input', 'output'] }, model: { kind: 'free' }, tier: { kind: 'free' } },
  },
  {
    key: 'runToolDuration',
    name: 'app.runs.tool_duration',
    kind: 'histogram',
    unit: 's',
    description: 'One tool call of a browser agent or the chat (E38.4), by tool name and outcome (`ok`, `error`). Never an argument, a page or a result.',
    buckets: [0.05, 0.25, 0.5, 1, 2, 5, 15, 45, 120],
    attributes: { tool: { kind: 'free' }, outcome: { kind: 'enum', values: ['ok', 'error'] } },
  },
  {
    key: 'runToolCalls',
    name: 'app.runs.tool_calls',
    kind: 'counter',
    unit: '{call}',
    description: 'Tool calls of a browser agent (E41.1), by tool family (`browser`, `desktop`, `accounts`, `mcp`, `human`, `control`, ...) and outcome (`ok`, `error`, `refused` by a gate). Every MCP server is the literal `mcp`: never a connection, run or user in a label.',
    attributes: { family: { kind: 'free' }, outcome: { kind: 'enum', values: TOOL_CALL_OUTCOMES } },
  },
];
registerAppMetrics(RUN_METRICS);

/** Records the run metrics; a no-op where the host has no metrics service (unit tests). */
@Injectable()
export class RunMetrics {
  constructor(@Optional() private readonly metrics?: AppMetricsService) {}

  started(trigger: string): void {
    this.metrics?.add('runsStarted', 1, { trigger });
  }

  finished(status: string, trigger: string, seconds: number | null): void {
    this.metrics?.add('runsFinished', 1, { status, trigger });
    if (seconds !== null && seconds >= 0) this.metrics?.record('runDuration', seconds, { status });
  }

  step(kind: string, ok: boolean): void {
    this.metrics?.add('runSteps', 1, { kind, ok: String(ok) });
  }

  /** A saved-card use or refusal (E37.7). */
  cardUse(outcome: (typeof CARD_USE_OUTCOMES)[number]): void {
    this.metrics?.add('secretsCardUses' as never, 1, { outcome });
  }

  /** A run recovered after an interruption (E38.3): whether any step was left `unknown`. */
  recovered(unknownSteps: number): void {
    this.metrics?.add('runsRecovered' as never, 1, { unknown_steps: unknownSteps > 0 ? '1+' : '0' });
  }

  /** A batch error (E51.1), by stage. */
  batchError(stage: 'start_next' | 'run_end' | 'reconcile'): void {
    this.metrics?.add('runBatchErrors' as never, 1, { stage });
  }

  handoff(): void {
    this.metrics?.add('runHandoffs', 1);
  }

  tokens(input: number, output: number): void {
    if (input > 0) this.metrics?.add('runTokens', input, { direction: 'input' });
    if (output > 0) this.metrics?.add('runTokens', output, { direction: 'output' });
  }

  modelCalls(n: number): void {
    if (n > 0) this.metrics?.add('runModelCalls', n);
  }

  /** Milliseconds from Stop to the end of the run (E38.1); never a run, goal or user as a label. */
  stopLatency(status: string, ms: number): void {
    if (ms >= 0) this.metrics?.record('runStopLatency', ms, { status });
  }

  /** The input size of one model call; never a run, task or user id as a label. */
  inputTokensPerCall(tokens: number): void {
    if (tokens > 0) this.metrics?.record('runInputTokensPerCall', tokens);
  }

  /** Runs deleted from the history; never a run, task or user id as a label. */
  deleted(mode: RunDeleteMode, n: number): void {
    if (n > 0) this.metrics?.add('runsDeleted', n, { mode });
  }

  /** One trace screenshot (#541): its moment and what became of it; never a run, key or image. */
  traceScreenshot(moment: string, result: 'stored' | 'skipped' | 'failed', bytes = 0): void {
    this.metrics?.add('runTraceScreenshots', 1, { moment, result });
    if (result === 'stored' && bytes > 0) this.metrics?.record('runTraceScreenshotBytes', bytes);
  }

  /** One exported run file (#542): its format and whether images were embedded; never a run or user id. */
  exported(format: 'json' | 'pdf', screenshots: 'embed' | 'none'): void {
    this.metrics?.add('runsExported', 1, { format, screenshots });
  }

  /** One model call (E38.4): its wall time and tokens by model and tier; never a run, user or prompt as a label. */
  modelCallDone(model: string, tier: string, seconds: number, inputTokens: number, outputTokens: number): void {
    const labels = { model, tier };
    if (seconds >= 0) this.metrics?.record('runModelCallDuration', seconds, labels);
    if (inputTokens > 0) this.metrics?.record('runModelCallTokens', inputTokens, { direction: 'input', ...labels });
    if (outputTokens > 0) this.metrics?.record('runModelCallTokens', outputTokens, { direction: 'output', ...labels });
  }

  /** One tool call (E38.4): its name and outcome; never an argument or a result. */
  toolDone(tool: string, ok: boolean, seconds: number): void {
    if (seconds >= 0) this.metrics?.record('runToolDuration', seconds, { tool, outcome: ok ? 'ok' : 'error' });
  }

  /** One tool call of a run by family and outcome (E41.1). `family` must already be bounded (`familyLabel`: every MCP server is `mcp`). */
  toolCallOf(family: string, outcome: (typeof TOOL_CALL_OUTCOMES)[number]): void {
    this.metrics?.add('runToolCalls' as never, 1, { family, outcome });
  }

  /** The spend of a finished run; never a run, task or user id as a label. */
  cost(status: string, usd: number): void {
    if (usd >= 0) this.metrics?.record('runCost', usd, { status });
  }
}
