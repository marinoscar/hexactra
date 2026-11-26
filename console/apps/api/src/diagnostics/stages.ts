// Runs ordered diagnostic steps (E50.10, #980): each with its own deadline, timed, stopping at the first `fail` (the rest are `skipped`)
// unless a step is independent. A step that throws is a `fail` with a closed code, never the error's message. Nothing runs detached:
// a step that outlives its deadline is abandoned (its signal is aborted) and reported as `TIMEOUT`.
import type { DiagnosticStage, StageData, StageStatus } from './diagnostic-report';

export interface StageOutcome {
  status: StageStatus;
  code?: string | null;
  remedy?: string | null;
  data?: StageData;
}

export interface StageStep {
  id: string;
  /** Runs even after an earlier step failed (a capability next to another, the total time). */
  independent?: boolean;
  /** Runs only when these steps passed or warned (a capability needs the sign-in). */
  dependsOn?: readonly string[];
  run(signal: AbortSignal): Promise<StageOutcome> | StageOutcome;
}

export interface RunStagesOptions {
  /** The whole report's signal: the request's abort and the report's deadline. */
  signal: AbortSignal;
  /** Each step's deadline. */
  stageTimeoutMs: number;
  /** The code of a step that did not start because `signal` was aborted (`DEADLINE_EXCEEDED` or `ABORTED`). */
  abortCode: () => string;
  /** The closed code of a thrown error. */
  errorCode?: (e: unknown) => string;
  /** Steps already failed before these (the generic stages): the dependent ones are skipped. */
  failedBefore?: boolean;
  clock?: () => number;
}

class StageTimeout extends Error {}

export async function runStages(steps: readonly StageStep[], opts: RunStagesOptions): Promise<DiagnosticStage[]> {
  const clock = opts.clock ?? Date.now;
  const out: DiagnosticStage[] = [];
  let failed = opts.failedBefore === true;
  for (const step of steps) {
    const unmet = step.dependsOn?.some((d) => !out.some((o) => o.id === d && (o.status === 'pass' || o.status === 'warn'))) ?? false;
    if ((failed && !step.independent) || unmet) {
      out.push({ id: step.id, status: 'skipped', code: null, remedy: null, ms: null });
      continue;
    }
    if (opts.signal.aborted) {
      const code = opts.abortCode();
      out.push({ id: step.id, status: 'skipped', code, remedy: code, ms: null });
      continue;
    }
    const started = clock();
    const own = new AbortController();
    const signal = AbortSignal.any([opts.signal, own.signal]);
    let timer: NodeJS.Timeout | undefined;
    let onAbort: (() => void) | undefined;
    try {
      const timeout = new Promise<never>((_, reject) => {
        timer = setTimeout(() => {
          own.abort();
          reject(new StageTimeout());
        }, opts.stageTimeoutMs);
        // The report's deadline or the request's abort ends the step now, even one that ignores its signal.
        onAbort = () => reject(new Error('aborted'));
        opts.signal.addEventListener('abort', onAbort, { once: true });
      });
      const work = Promise.resolve().then(() => step.run(signal));
      // The abandoned step still settles later: its rejection is observed here, never left unhandled.
      work.catch(() => undefined);
      const r = await Promise.race([work, timeout]);
      out.push({ id: step.id, status: r.status, code: r.code ?? null, remedy: r.remedy ?? r.code ?? null, ms: clock() - started, ...(r.data ? { data: r.data } : {}) });
      if (r.status === 'fail') failed = true;
    } catch (e) {
      const code = e instanceof StageTimeout ? 'TIMEOUT' : opts.signal.aborted ? opts.abortCode() : (opts.errorCode?.(e) ?? 'UNAVAILABLE');
      out.push({ id: step.id, status: 'fail', code, remedy: code, ms: clock() - started });
      failed = true;
    } finally {
      clearTimeout(timer);
      if (onAbort) opts.signal.removeEventListener('abort', onAbort);
    }
  }
  return out;
}
