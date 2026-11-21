// The benchmark's job type and its enqueue helper, apart from the handler so the grader can queue a pass without importing the runner.
import { JobsService, registerJobReason } from '@marinoscar/platform-api/jobs';

/** Permanent job type (never rename once jobs exist). */
export const BENCHMARK_ADVANCE_JOB = 'benchmark.advance';

/** Why a pass was queued (permanent ids, shown in the admin job list). */
export const BENCHMARK_ADVANCE_REASONS = {
  started: { id: 'benchmark_started', label: 'Benchmark started' },
  trialEnded: { id: 'benchmark_trial_ended', label: 'Benchmark trial ended' },
  question: { id: 'benchmark_question', label: 'Benchmark trial asked a question' },
  recheck: { id: 'benchmark_recheck', label: 'Benchmark trial checked again (timeout, stop)' },
  cancelled: { id: 'benchmark_cancelled', label: 'Benchmark cancelled' },
} as const;
export type BenchmarkAdvanceReason = (typeof BENCHMARK_ADVANCE_REASONS)[keyof typeof BENCHMARK_ADVANCE_REASONS]['id'];
for (const r of Object.values(BENCHMARK_ADVANCE_REASONS)) registerJobReason(r);

export interface BenchmarkAdvancePayload {
  benchmarkId: string;
}

/**
 * Queue one pass. Never deduplicated: a pass that is already running may be past the check this one is for (a trial that ended a
 * moment ago), and collapsing into it would leave the benchmark waiting. A pass is serialised per benchmark and does nothing when
 * there is nothing to do, so an extra one is cheap.
 */
export async function enqueueBenchmarkAdvance(jobs: JobsService, benchmarkId: string, orgId: string | null, reason: BenchmarkAdvanceReason, delayMs = 0): Promise<void> {
  await jobs.enqueue({
    type: BENCHMARK_ADVANCE_JOB,
    reason,
    subjectType: 'benchmark',
    subjectId: benchmarkId,
    orgId,
    payload: { benchmarkId } satisfies BenchmarkAdvancePayload,
    skipDedup: true,
    ...(delayMs > 0 ? { scheduledFor: new Date(Date.now() + delayMs) } : {}),
  });
}
