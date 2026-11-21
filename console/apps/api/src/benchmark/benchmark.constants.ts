// The closed lists of a benchmark (E44, epic #738). They are stored as text (prisma/fragments/benchmarks.prisma), so a new value
// needs no migration; every write goes through these lists.

/** A benchmark's life: waiting for its first trial, running, then one of three ends. */
export const BENCHMARK_STATUSES = ['queued', 'running', 'completed', 'cancelled', 'failed'] as const;
export type BenchmarkStatus = (typeof BENCHMARK_STATUSES)[number];

/** A benchmark that can still start a trial. */
export const LIVE_BENCHMARK_STATUSES = ['queued', 'running'] as const satisfies readonly BenchmarkStatus[];

/** A trial's life. `skipped` is a trial that never ran (cancelled, the cap, an unsupported challenge). */
export const TRIAL_STATUSES = ['pending', 'running', 'graded', 'skipped'] as const;
export type TrialStatus = (typeof TRIAL_STATUSES)[number];

/**
 * What a trial came to.
 * - `pass`: every check of the grader passed.
 * - `fail`: the agent ran and a check failed (or it gave up, ran out of budget, asked a person nobody scripted).
 * - `error`: the trial could not be judged (the host was down, the grader threw). Not the agent's failure.
 * - `skipped`: it never ran.
 * - `unsupported`: the challenge needs a capability the agent does not have. Never counted as a failure.
 */
export const TRIAL_VERDICTS = ['pass', 'fail', 'error', 'skipped', 'unsupported'] as const;
export type TrialVerdict = (typeof TRIAL_VERDICTS)[number];

/** Why a trial did not pass. `cap` and `cancelled` belong to skipped trials; `unsupported` to unsupported ones. */
export const TRIAL_FAILURE_REASONS = ['wrong_result', 'gave_up', 'budget', 'stalled', 'asked_person', 'timeout', 'error', 'no_model', 'cancelled', 'cap', 'unsupported'] as const;
export type TrialFailureReason = (typeof TRIAL_FAILURE_REASONS)[number];

/** The `trigger` of a trial's run: what keeps it out of the owner's ordinary run views. */
export const BENCHMARK_RUN_TRIGGER = 'benchmark' as const;
