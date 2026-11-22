// The benchmark report (E44.6, #744), pure: the report object from what the service read, masked once here; the CSV of its trials; the
// file name. Nothing here reads the database or the clock, so what the JSON file hides, the CSV and the PDF hide.
import type { PatternHits, PatternId } from '@app/shared/sensitive-patterns';

import { maskValue, SENSITIVE_PATTERNS_VERSION } from '../tasks/mask';
import type { BenchmarkTrialView, BenchmarkView } from './benchmarks.schemas';
import { BENCHMARK_REPORT_FORMAT_VERSION, BENCHMARK_REPORT_TYPE, type BenchmarkReport, type BenchmarkReportTrial } from './benchmark-report.schemas';
import { servedModels } from './scorecard';
import type { BenchmarkComparison, Scorecard } from './scorecard.schemas';
import { LIVE_BENCHMARK_STATUSES } from './benchmark.constants';

/** What a hidden trial site token reads as. */
export const HIDDEN_TRIAL_TOKEN = '[trial token]';

/**
 * A trial's goal holds its site address, `<site>/t/<token>/...`: while the trial runs, that token opens and changes its site state.
 * The report never carries one, live or closed.
 */
export function hideTrialTokens(text: string): string {
  return text.replace(/\/t\/[A-Za-z0-9_-]{16,}/g, `/t/${HIDDEN_TRIAL_TOKEN}`);
}

/** The run text of a trial, as the service read it. */
export interface TrialRunText {
  goal: string;
  result: string | null;
}

export interface ReportInput {
  benchmark: BenchmarkView;
  scorecard: Scorecard;
  trials: readonly BenchmarkTrialView[];
  /** Goal and result by run id, for the trials whose run still exists. */
  runs: ReadonlyMap<string, TrialRunText>;
  baseline: BenchmarkComparison | null;
  consoleVersion: string;
  exportedAt: Date;
}

function nonZero(hits: PatternHits): Partial<Record<PatternId, number>> {
  return Object.fromEntries(Object.entries(hits).filter(([, n]) => n > 0)) as Partial<Record<PatternId, number>>;
}

/** The report, every string masked (benchmark name, labels, goals, results, check names and notes). */
export function buildBenchmarkReport(input: ReportInput): BenchmarkReport {
  const trials: BenchmarkReportTrial[] = input.trials.map((t) => {
    const run = t.runId ? input.runs.get(t.runId) : undefined;
    return { ...t, goal: run ? hideTrialTokens(run.goal) : null, result: run?.result != null ? hideTrialTokens(run.result) : null };
  });
  const report: BenchmarkReport = {
    type: BENCHMARK_REPORT_TYPE,
    formatVersion: BENCHMARK_REPORT_FORMAT_VERSION,
    exportedAt: input.exportedAt.toISOString(),
    partial: (LIVE_BENCHMARK_STATUSES as readonly string[]).includes(input.benchmark.status),
    console: { version: input.consoleVersion },
    masking: { applied: true, patternsVersion: SENSITIVE_PATTERNS_VERSION, hits: {} },
    benchmark: input.benchmark,
    scorecard: input.scorecard,
    trials,
    baseline: input.baseline,
  };
  const masked = maskValue(report);
  masked.value.masking.hits = nonZero(masked.hits);
  return masked.value;
}

// ---- CSV ----

/** The CSV's columns, in order. */
export const CSV_COLUMNS = [
  'benchmark',
  'benchmark_status',
  'challenge',
  'category',
  'policy_label',
  'policy_ref',
  'trial',
  'verdict',
  'failure_reason',
  'claimed_success',
  'active_ms',
  'steps',
  'model_calls',
  'models',
  'input_tokens',
  'output_tokens',
  'cached_tokens',
  'cost_usd',
  'cost_known',
  'stop_reason',
  'run_id',
  'recording',
] as const;

type Cell = string | number | boolean | null | undefined;

/**
 * One RFC 4180 field. A text cell that a spreadsheet would read as a formula (it starts with `=`, `+`, `-` or `@`, or with a tab or a
 * carriage return) gets a leading `'`; numbers are written as they are.
 */
export function csvCell(value: Cell): string {
  if (value === null || value === undefined) return '';
  let text = typeof value === 'string' ? value : String(value);
  if (typeof value === 'string' && /^[=+\-@\t\r]/.test(text)) text = `'${text}`;
  return /[",\r\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}

/**
 * One line per trial, with a header; lines end with CRLF. `benchmark_status` reads `in progress` on every row of a benchmark still
 * running. The totals per policy and for the benchmark are the sums of these rows (the scorecard's totals are the same sums).
 */
export function benchmarkReportCsv(report: BenchmarkReport): string {
  const rows: Cell[][] = report.trials.map((t) => [
    report.benchmark.name,
    report.partial ? 'in progress' : report.benchmark.status,
    t.challengeId,
    t.category,
    t.policyLabel,
    t.policyRef,
    t.trialIndex + 1,
    t.verdict ?? (t.status === 'running' ? 'running' : t.status === 'pending' ? 'pending' : null),
    t.failureReason,
    t.claimedSuccess,
    t.activeMs,
    t.steps,
    t.modelCalls,
    servedModels(t).join(' '),
    t.inputTokens,
    t.outputTokens,
    t.cachedInputTokens,
    t.costUsd,
    t.costKnown,
    t.stopReason,
    t.runId,
    t.recording?.status,
  ]);
  const lines = [CSV_COLUMNS.join(','), ...rows.map((r) => r.map(csvCell).join(','))];
  return `${lines.join('\r\n')}\r\n`;
}

/** `hexactra-benchmark-<first 8 of id>-<yyyymmdd>.<ext>` (UTC date). */
export function benchmarkExportFilename(id: string, at: Date, ext: 'json' | 'csv' | 'pdf'): string {
  return `hexactra-benchmark-${id.slice(0, 8)}-${at.toISOString().slice(0, 10).replace(/-/g, '')}.${ext}`;
}
