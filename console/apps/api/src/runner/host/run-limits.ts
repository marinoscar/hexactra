// The opt-ins a run is held to: its allowed sites, and whether a risky step asks first. Read here and nowhere else, so the browser
// session (`browser-session.ts`) and the gates' context (`build-context.ts`) cannot disagree.
//
//   a task's run        the task's `allowedDomains` and `confirmRiskyActions`
//   a chat's run        the chat's
//   an ad-hoc run       none
//   a benchmark trial   `runs.context.benchmark` (E44.3, #741; docs/decisions/benchmark.md): a trial has no task and no chat
//
// The benchmark entry is read ONLY for a run whose trigger is `benchmark`, and only the server creates one (`benchmark/benchmark-run-starter.ts`:
// no route takes a trigger or a context from a request body; `test/benchmark-run-limits.spec.ts` scans for it). For every other run this is the
// expression the two call sites had before, so nothing about them changes. A benchmark run whose context is missing or unreadable is allowed
// no site at all: the entry can narrow a run, never widen one.
import { NO_SITE } from '@marinoscar/hexactra-browser-agent/policy';

export interface RunLimits {
  /** Empty: any site. */
  allowedDomains: string[];
  confirmRiskyActions: boolean;
}

/** What the limits are read from on the run row. */
export interface LimitedRun {
  trigger?: string | null;
  context?: unknown;
  task?: { allowedDomains: string[]; confirmRiskyActions?: boolean } | null;
  conversation?: { allowedDomains: string[]; confirmRiskyActions?: boolean } | null;
}

/** The trigger of a benchmark's trial run (`benchmark/benchmark.constants.ts`, `BENCHMARK_RUN_TRIGGER`). */
const BENCHMARK_TRIGGER = 'benchmark';

/** `runs.context` of a trial run. Ids and the two limits: no token, no seed, no answer. */
export interface BenchmarkRunContext {
  benchmark: { benchmarkId: string; trialId: string; allowedDomains: string[]; confirmRiskyActions: boolean };
}

/** The context the benchmark's run starter writes. A trial without a site to visit cannot be made. */
export function benchmarkRunContext(v: BenchmarkRunContext['benchmark']): BenchmarkRunContext {
  const allowedDomains = v.allowedDomains.map((d) => d.trim().toLowerCase()).filter(Boolean);
  if (allowedDomains.length === 0) throw new Error('A benchmark run needs the challenge site as its allowed site');
  return { benchmark: { benchmarkId: v.benchmarkId, trialId: v.trialId, allowedDomains, confirmRiskyActions: v.confirmRiskyActions === true } };
}

/** The limits of a benchmark trial run, or null for any other run. Fails closed: no readable site list means no site. */
export function benchmarkLimits(run: Pick<LimitedRun, 'trigger' | 'context'>): RunLimits | null {
  if (run.trigger !== BENCHMARK_TRIGGER) return null;
  const entry = run.context && typeof run.context === 'object' ? (run.context as { benchmark?: unknown }).benchmark : null;
  const b = entry && typeof entry === 'object' ? (entry as { allowedDomains?: unknown; confirmRiskyActions?: unknown }) : {};
  const domains = Array.isArray(b.allowedDomains) ? b.allowedDomains.filter((d): d is string => typeof d === 'string' && d.trim() !== '') : [];
  return { allowedDomains: domains.length > 0 ? domains : [NO_SITE], confirmRiskyActions: b.confirmRiskyActions === true };
}

/** The run's own limits (an AI app's limits narrow them further, where they are used). */
export function runLimits(run: LimitedRun): RunLimits {
  return (
    benchmarkLimits(run) ?? {
      allowedDomains: run.task?.allowedDomains ?? run.conversation?.allowedDomains ?? [],
      confirmRiskyActions: run.task?.confirmRiskyActions ?? run.conversation?.confirmRiskyActions ?? false,
    }
  );
}
