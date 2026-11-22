// The savings ledger's arithmetic (E46.6, #780): the outcome of a run, the AI-only baseline of a task (the median of its last ≤ 10 AI-only
// runs) and the per-task summary against it. Pure: no database, no clock. A saving is computed only against a baseline; with none the summary
// says "no baseline yet" and carries no saving at all. A cost with `costKnown: false` is a lower bound, as everywhere else in the console.

export const LEDGER_OUTCOMES = ['replayed_clean', 'recovered', 'repaired', 'fell_back', 'ai_only'] as const;
export type LedgerOutcome = (typeof LEDGER_OUTCOMES)[number];

/** At most this many AI-only runs make a task's baseline. */
export const BASELINE_RUNS = 10;
export const NO_BASELINE_YET = 'no baseline yet';

export interface StepCounts {
  replayed: number;
  recovered: number;
  judge: number;
  agent: number;
}

/**
 * How a run went. A run that executed no procedure version (every `learn` run, an audit run) is `ai_only`: it is what the baseline is made
 * of. With a version: no agent step is a clean replay (or `recovered` when a step needed the recovery ladder); agent steps mean the agent
 * took over, `repaired` when the host recorded a repair, otherwise `fell_back`.
 */
export function ledgerOutcome(i: { procedureVersionId: string | null; counts: StepCounts; repaired?: boolean }): LedgerOutcome {
  if (!i.procedureVersionId) return 'ai_only';
  if (i.counts.agent > 0) return i.repaired ? 'repaired' : 'fell_back';
  return i.counts.recovered > 0 ? 'recovered' : 'replayed_clean';
}

/** The median of a list (the mean of the two middle values for an even count); null for an empty list. */
export function median(values: readonly number[]): number | null {
  if (values.length === 0) return null;
  const s = [...values].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 === 1 ? s[mid]! : (s[mid - 1]! + s[mid]!) / 2;
}

/** One run's figures, as the baseline and the summary read them. */
export interface RunFigures {
  modelCalls: number;
  costUsd: number;
  costKnown: boolean;
  activeMs: number;
  finishedAt: Date;
}

export interface Figures {
  /** How many runs the figures are the median of. */
  runs: number;
  modelCalls: number;
  costUsd: number;
  /** False when one of the runs had an unpriced call: `costUsd` is then a lower bound. */
  costKnown: boolean;
  activeMs: number;
}

/** The medians of the given runs; null with none. */
export function figuresOf(runs: readonly RunFigures[]): Figures | null {
  if (runs.length === 0) return null;
  return {
    runs: runs.length,
    modelCalls: median(runs.map((r) => r.modelCalls))!,
    costUsd: round6(median(runs.map((r) => r.costUsd))!),
    costKnown: runs.every((r) => r.costKnown),
    activeMs: Math.round(median(runs.map((r) => r.activeMs))!),
  };
}

/** The baseline: the newest ≤ 10 of the AI-only runs given (ledger `ai_only` rows and the task's runs from before the feature), as medians. */
export function baselineOf(aiOnlyRuns: readonly RunFigures[]): Figures | null {
  const newest = [...aiOnlyRuns].sort((a, b) => b.finishedAt.getTime() - a.finishedAt.getTime()).slice(0, BASELINE_RUNS);
  return figuresOf(newest);
}

export interface LedgerRunFigures extends RunFigures {
  outcome: LedgerOutcome;
}

export interface Saving {
  modelCalls: number;
  costUsd: number;
  /** False when the baseline's or the procedure runs' cost is a lower bound: the cost saving is then approximate. */
  costKnown: boolean;
  activeMs: number;
}

export interface TaskSummary {
  runs: number;
  /** Runs that executed a procedure version (every outcome but `ai_only`). */
  procedureRuns: number;
  /** `replayed_clean` runs over procedure runs; null with no procedure run. */
  cleanReplayRate: number | null;
  baseline: Figures | null;
  /** "no baseline yet" while the baseline is null; otherwise null. */
  note: string | null;
  /** The medians of the procedure runs; null with none. */
  procedureFigures: Figures | null;
  /** Baseline minus procedure runs (positive: saved). Null without a baseline or without a procedure run: never assumed. */
  saving: Saving | null;
}

export function summarize(rows: readonly LedgerRunFigures[], baseline: Figures | null): TaskSummary {
  const procedure = rows.filter((r) => r.outcome !== 'ai_only');
  const clean = procedure.filter((r) => r.outcome === 'replayed_clean').length;
  const procedureFigures = figuresOf(procedure);
  const saving: Saving | null =
    baseline && procedureFigures
      ? {
          modelCalls: baseline.modelCalls - procedureFigures.modelCalls,
          costUsd: round6(baseline.costUsd - procedureFigures.costUsd),
          costKnown: baseline.costKnown && procedureFigures.costKnown,
          activeMs: baseline.activeMs - procedureFigures.activeMs,
        }
      : null;
  return {
    runs: rows.length,
    procedureRuns: procedure.length,
    cleanReplayRate: procedure.length ? clean / procedure.length : null,
    baseline,
    note: baseline ? null : NO_BASELINE_YET,
    procedureFigures,
    saving,
  };
}

/** Model calls one run saved against the baseline (0 without one, for an AI-only run, or when it used more). */
export function modelCallsSaved(outcome: LedgerOutcome, modelCalls: number, baseline: Figures | null): number {
  if (!baseline || outcome === 'ai_only') return 0;
  return Math.max(0, Math.round(baseline.modelCalls - modelCalls));
}

function round6(n: number): number {
  return Math.round(n * 1e6) / 1e6;
}
