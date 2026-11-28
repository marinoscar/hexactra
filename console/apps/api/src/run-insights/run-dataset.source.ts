// =============================================================================
// The run dataset (E53.3, #1071): the owner's runs as an export of the platform's exports slice
// =============================================================================
//
// One file with three tables, for an analyst or a coding agent:
//   runs      one row per run: when, how it ended, the task and policy, steps, model calls, tokens, cost, working and wall time,
//             the masked goal, result and error;
//   findings  one row per finding of a run (E52.6), computed from its steps with no model;
//   steps     (only with `includeSteps`) one row per step: the tool, ok, phase, duration, the masked summary, arguments and
//             reasoning, as the run's JSON trace has them.
// The platform writes it as JSON, a zip of CSV files or XLSX, stores it, and serves it through a short-lived signed link
// (`POST /api/exports`, `GET /api/exports/{id}`, `GET /api/exports/{id}/download`).
//
// Rules (docs/runs.md, "Exporting runs as a dataset"):
// - The OWNER'S runs only, for every role: `scope: 'user'` and every query filters on `ctx.subjectId`. An administrator never
//   exports another user's runs here (their cross-user view is the aggregates of #1070).
// - Masked like the trace: every text passes `maskSensitive` (and the goal `maskRunGoal`). Never a screenshot, a recording,
//   `runs.transcript`, a secret, a token or an object key: none of them is selected.
// - The filter is the runs list's (`runWhere`), the newest `RUN_DATASET_MAX_RUNS` at most; benchmark runs are left out unless named.
// - Read-only: the source never writes a row.
// =============================================================================

import type { ExportContext, ExportRow, ExportSource, ExportTable } from '@marinoscar/platform-api/exports';
import { zonedDayStart, addDaysToDateKey, type DateKey } from '@marinoscar/platform-contract/timezone';
import { z } from 'zod';

import { snapshotBudgetView } from '../policies/policy-snapshot';
import { maskSensitive } from '../tasks/mask';
import { runWhere } from '../tasks/runs.query';
import { STOP_REASON_FILTERS, RUN_TRIGGERS, runFilterSchema, type RunFilter } from '../tasks/runs.schemas';
import { maskRunGoal } from '../tasks/task-params';
import { diagnoseRun, type DiagnosticStep } from './run-diagnostics';
import { maskFinding } from './run-insights.service';

export const RUN_DATASET_SOURCE_ID = 'run-dataset';
/** The most runs one dataset holds: the newest that match. */
export const RUN_DATASET_MAX_RUNS = 5_000;
/** Steps read per run, as the findings route reads them. */
const MAX_STEPS_PER_RUN = 2_000;

const STATUS_CHOICES = ['finished', 'succeeded', 'failed', 'cancelled', 'all'] as const;

/** What the owner asks for. Flat, so the export dialog draws it; turned into the runs list's filter by `datasetFilter`. */
export const runDatasetRequestSchema = z
  .object({
    from: z.iso.date().optional().describe('Runs created on or after this day (your time zone)'),
    to: z.iso.date().optional().describe('Runs created on or before this day (your time zone)'),
    status: z.enum(STATUS_CHOICES).default('finished').describe('Which runs: finished (succeeded, failed or cancelled), one status, or all'),
    taskId: z.union([z.literal('none'), z.uuid()]).optional().describe("One task's id, or none for runs without a task"),
    stopReason: z.string().max(400).optional().describe('Stop reasons, comma-separated; budget for every budget stop'),
    trigger: z.string().max(200).optional().describe('What started the runs, comma-separated (manual, schedule, api, mcp, chat, ...)'),
    includeSteps: z.boolean().default(false).describe('Add every step (tool, outcome, masked summary, arguments and reasoning)'),
  })
  .strict()
  .superRefine((r, ctx) => {
    if (r.from && r.to && r.from > r.to) ctx.addIssue({ code: 'custom', path: ['to'], message: 'to must not be before from' });
    const lists = runFilterSchema.pick({ stopReason: true, trigger: true }).safeParse({ stopReason: r.stopReason, trigger: r.trigger });
    if (!lists.success) ctx.addIssue({ code: 'custom', path: ['stopReason'], message: `Unknown stop reason or trigger. Stop reasons: ${STOP_REASON_FILTERS.join(', ')}; triggers: ${RUN_TRIGGERS.join(', ')}` });
  });
export type RunDatasetRequest = z.infer<typeof runDatasetRequestSchema>;

/** The runs list's filter for a request; days are cut in the requester's time zone (`to` is inclusive). */
export function datasetFilter(req: RunDatasetRequest, timeZone: string): RunFilter {
  const lists = runFilterSchema.pick({ stopReason: true, trigger: true }).parse({ stopReason: req.stopReason, trigger: req.trigger });
  return {
    ...(req.from ? { from: zonedDayStart(req.from as DateKey, timeZone).toISOString() } : {}),
    ...(req.to ? { to: zonedDayStart(addDaysToDateKey(req.to as DateKey, 1), timeZone).toISOString() } : {}),
    ...(req.status === 'finished' ? { state: 'finished' as const } : req.status === 'all' ? {} : { status: [req.status] }),
    ...(req.taskId ? { taskId: req.taskId } : {}),
    ...lists,
  };
}

const m = (s: string | null | undefined): string | null => (s === null || s === undefined ? null : maskSensitive(s).text);
const iso = (d: Date | null | undefined): string | null => (d ? d.toISOString() : null);

interface RunRow {
  id: string;
  createdAt: Date;
  startedAt: Date | null;
  finishedAt: Date | null;
  status: string;
  stopReason: string | null;
  trigger: string;
  origin: string;
  taskId: string | null;
  task: { name: string } | null;
  policyRef: string | null;
  policyVersion: number | null;
  policySnapshot: unknown;
  currentTier: string | null;
  escalations: number;
  recoveries: number;
  stepCount: number;
  modelCalls: number;
  modelMs: number;
  models: string[];
  inputTokens: number;
  cachedInputTokens: number;
  outputTokens: number;
  costUsd: unknown;
  costKnown: boolean;
  activeMs: number;
  activeSince: Date | null;
  goal: string;
  result: string | null;
  error: string | null;
}

const RUN_SELECT = {
  id: true,
  createdAt: true,
  startedAt: true,
  finishedAt: true,
  status: true,
  stopReason: true,
  trigger: true,
  origin: true,
  taskId: true,
  task: { select: { name: true } },
  policyRef: true,
  policyVersion: true,
  policySnapshot: true,
  currentTier: true,
  escalations: true,
  recoveries: true,
  stepCount: true,
  modelCalls: true,
  modelMs: true,
  models: true,
  inputTokens: true,
  cachedInputTokens: true,
  outputTokens: true,
  costUsd: true,
  costKnown: true,
  activeMs: true,
  activeSince: true,
  goal: true,
  result: true,
  error: true,
} as const;

/** The ids of the newest matching runs of the owner, newest first: the one list every table walks. */
async function runIds(ctx: ExportContext, filter: RunFilter): Promise<string[]> {
  const rows = (await ctx.db.run.findMany({
    where: { AND: [runWhere(filter), { userId: ctx.subjectId }] },
    select: { id: true },
    orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
    take: RUN_DATASET_MAX_RUNS,
  })) as { id: string }[];
  return rows.map((r) => r.id);
}

function chunks<T>(list: readonly T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < list.length; i += size) out.push(list.slice(i, i + size));
  return out;
}

/** The runs of a page of ids, in the order of the ids. Re-filtered on the owner: the ids came from the same query, but say so. */
async function runsOf(ctx: ExportContext, ids: readonly string[]): Promise<RunRow[]> {
  const rows = (await ctx.db.run.findMany({ where: { id: { in: [...ids] }, userId: ctx.subjectId }, select: RUN_SELECT })) as RunRow[];
  const byId = new Map(rows.map((r) => [r.id, r]));
  return ids.map((id) => byId.get(id)).filter((r): r is RunRow => r !== undefined);
}

async function stepsOf(ctx: ExportContext, runId: string, withText: boolean) {
  return (await ctx.db.runStep.findMany({
    where: { runId },
    orderBy: { seq: 'asc' },
    take: MAX_STEPS_PER_RUN,
    select: { seq: true, kind: true, action: true, args: true, ok: true, summary: true, phase: true, durationMs: true, createdAt: true, ...(withText ? { reasoning: true } : {}) },
  })) as (DiagnosticStep & { durationMs: number | null; createdAt: Date; reasoning?: string | null })[];
}

/** One row of the runs table. */
export function runDatasetRow(r: RunRow): ExportRow {
  // The name only, read from the snapshot as stored (a snapshot from an older spec still has its name).
  const policyName = r.policySnapshot && typeof r.policySnapshot === 'object' ? (r.policySnapshot as { name?: unknown }).name : undefined;
  return {
    run_id: r.id,
    created_at: iso(r.createdAt),
    started_at: iso(r.startedAt),
    finished_at: iso(r.finishedAt),
    status: r.status,
    stop_reason: r.stopReason,
    trigger: r.trigger,
    origin: r.origin,
    task_id: r.taskId,
    task_name: r.task?.name ?? null,
    policy_id: r.policyRef,
    policy_name: typeof policyName === 'string' ? policyName : null,
    policy_version: r.policyVersion,
    tier: r.currentTier,
    escalations: r.escalations,
    recoveries: r.recoveries,
    steps: r.stepCount,
    model_calls: r.modelCalls,
    // E54.0: null when the run is from before the model time was measured.
    model_ms: r.modelMs > 0 ? r.modelMs : null,
    models: r.models.length ? [...r.models].sort().join(',') : null,
    input_tokens: r.inputTokens,
    cached_input_tokens: r.cachedInputTokens,
    output_tokens: r.outputTokens,
    total_tokens: r.inputTokens + r.outputTokens,
    cost_usd: Number(r.costUsd),
    cost_known: r.costKnown,
    working_ms: r.activeMs,
    wall_ms: r.startedAt && r.finishedAt ? Math.max(0, r.finishedAt.getTime() - r.startedAt.getTime()) : null,
    goal: m(maskRunGoal(r.goal)),
    result: m(r.result),
    error: m(r.error),
  };
}

const RUN_COLUMNS: ExportTable['columns'] = [
  { key: 'run_id', label: 'Run id', type: 'string' },
  { key: 'created_at', label: 'Created at', type: 'datetime' },
  { key: 'started_at', label: 'Started at', type: 'datetime' },
  { key: 'finished_at', label: 'Finished at', type: 'datetime' },
  { key: 'status', label: 'Status', type: 'string' },
  { key: 'stop_reason', label: 'Stop reason', type: 'string' },
  { key: 'trigger', label: 'Trigger', type: 'string' },
  { key: 'origin', label: 'Origin', type: 'string' },
  { key: 'task_id', label: 'Task id', type: 'string' },
  { key: 'task_name', label: 'Task', type: 'string' },
  { key: 'policy_id', label: 'Policy id', type: 'string' },
  { key: 'policy_name', label: 'Policy', type: 'string' },
  { key: 'policy_version', label: 'Policy version', type: 'number' },
  { key: 'tier', label: 'Model tier', type: 'string' },
  { key: 'escalations', label: 'Tier escalations', type: 'number' },
  { key: 'recoveries', label: 'Recoveries', type: 'number' },
  { key: 'steps', label: 'Steps', type: 'number' },
  { key: 'model_calls', label: 'Model calls', type: 'number' },
  { key: 'model_ms', label: 'Model time (ms)', type: 'number' },
  { key: 'models', label: 'Models (provider:model, comma-separated)', type: 'string' },
  { key: 'input_tokens', label: 'Input tokens', type: 'number' },
  { key: 'cached_input_tokens', label: 'Cached input tokens', type: 'number' },
  { key: 'output_tokens', label: 'Output tokens', type: 'number' },
  { key: 'total_tokens', label: 'Total tokens', type: 'number' },
  { key: 'cost_usd', label: 'Cost (USD)', type: 'number' },
  { key: 'cost_known', label: 'Cost known', type: 'boolean' },
  { key: 'working_ms', label: 'Working time (ms)', type: 'number' },
  { key: 'wall_ms', label: 'Wall time (ms)', type: 'number' },
  { key: 'goal', label: 'Goal (masked)', type: 'string' },
  { key: 'result', label: 'Result (masked)', type: 'string' },
  { key: 'error', label: 'Error (masked)', type: 'string' },
];

const FINDING_COLUMNS: ExportTable['columns'] = [
  { key: 'run_id', label: 'Run id', type: 'string' },
  { key: 'code', label: 'Code', type: 'string' },
  { key: 'severity', label: 'Severity', type: 'string' },
  { key: 'title', label: 'Title', type: 'string' },
  { key: 'detail', label: 'Detail', type: 'string' },
  { key: 'seq_from', label: 'From step', type: 'number' },
  { key: 'seq_to', label: 'To step', type: 'number' },
  { key: 'steps_spent', label: 'Steps spent', type: 'number' },
];

const STEP_COLUMNS: ExportTable['columns'] = [
  { key: 'run_id', label: 'Run id', type: 'string' },
  { key: 'seq', label: 'Step', type: 'number' },
  { key: 'kind', label: 'Kind', type: 'string' },
  { key: 'action', label: 'Tool', type: 'string' },
  { key: 'ok', label: 'Ok', type: 'boolean' },
  { key: 'phase', label: 'Phase', type: 'string' },
  { key: 'duration_ms', label: 'Duration (ms)', type: 'number' },
  { key: 'created_at', label: 'At', type: 'datetime' },
  { key: 'summary', label: 'Summary (masked)', type: 'string' },
  { key: 'args', label: 'Arguments (masked JSON)', type: 'string' },
  { key: 'reasoning', label: 'Reasoning (masked)', type: 'string' },
];

async function* runRows(ctx: ExportContext, ids: readonly string[]): AsyncGenerator<ExportRow> {
  for (const page of chunks(ids, ctx.pageSize)) for (const r of await runsOf(ctx, page)) yield runDatasetRow(r);
}

async function* findingRows(ctx: ExportContext, ids: readonly string[]): AsyncGenerator<ExportRow> {
  for (const page of chunks(ids, ctx.pageSize)) {
    for (const r of await runsOf(ctx, page)) {
      const steps = await stepsOf(ctx, r.id, false);
      let findings;
      try {
        const budget = snapshotBudgetView(r.policySnapshot as never, { ...r, costUsd: Number(r.costUsd) } as never, ctx.now.getTime());
        findings = diagnoseRun({ startedAt: r.startedAt, budget }, steps).map(maskFinding);
      } catch {
        // A diagnosis that throws gives no findings, as on the run page: the export goes on.
        continue;
      }
      for (const f of findings) yield { run_id: r.id, code: f.code, severity: f.severity, title: f.title, detail: f.detail, seq_from: f.seqFrom, seq_to: f.seqTo, steps_spent: f.stepsSpent };
    }
  }
}

async function* stepRows(ctx: ExportContext, ids: readonly string[]): AsyncGenerator<ExportRow> {
  for (const runId of ids) {
    for (const s of await stepsOf(ctx, runId, true)) {
      yield {
        run_id: runId,
        seq: s.seq,
        kind: s.kind,
        action: s.action ?? null,
        ok: s.ok,
        phase: s.phase ?? null,
        duration_ms: s.durationMs,
        created_at: iso(s.createdAt),
        summary: m(s.summary),
        // The stored arguments are already redacted (secrets never reach them); masked again like the trace.
        args: s.args === null || s.args === undefined ? null : m(JSON.stringify(s.args)),
        reasoning: m(s.reasoning ?? null),
      };
    }
  }
}

export const RUN_DATASET_EXPORT_SOURCE: ExportSource<RunDatasetRequest> = {
  id: RUN_DATASET_SOURCE_ID,
  scope: 'user',
  label: 'Run dataset',
  description: `Your runs for analysis: one row per run (status, stop reason, steps, tokens, cost, time, the masked goal), their findings and, if you ask, every step. Masked like a run trace; never a screenshot. The newest ${RUN_DATASET_MAX_RUNS.toLocaleString('en-US')} runs that match.`,
  // The exact permission `GET /api/runs` enforces.
  permission: 'runs:read',
  requestSchema: runDatasetRequestSchema,
  formats: ['json', 'csv', 'xlsx'],
  columnTypes: ['string', 'number', 'boolean', 'datetime'],
  async *collect(ctx, req): AsyncGenerator<ExportTable> {
    const ids = await runIds(ctx, datasetFilter(req, ctx.timeZone));
    yield { dataset: 'runs', title: 'Runs', columns: RUN_COLUMNS, rows: runRows(ctx, ids) };
    yield { dataset: 'findings', title: 'Findings', columns: FINDING_COLUMNS, rows: findingRows(ctx, ids) };
    if (req.includeSteps) yield { dataset: 'steps', title: 'Steps', columns: STEP_COLUMNS, rows: stepRows(ctx, ids) };
  },
  fileName: (ctx, _req, ext) => `hexactra-runs-${ctx.now.toISOString().slice(0, 10)}.${ext}`,
};
