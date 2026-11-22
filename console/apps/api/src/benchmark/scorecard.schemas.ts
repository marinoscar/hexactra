// The scorecard of a benchmark and its comparison with a baseline (E44.4, #742). These shapes are what the API returns, what is cached
// in `Benchmark.summary`, what the admin pages draw (#743) and what the report files carry (#744): every number a page or a PDF shows is
// here, already computed, so neither does arithmetic of its own. The formulas are in `scorecard.ts`; the definitions in
// `docs/benchmark.md`, "Reading the scorecard".
import { createZodDto } from 'nestjs-zod';
import { z } from 'zod';

import { BENCHMARK_STATUSES } from './benchmark.constants';
import { CATEGORIES } from './suite/types';

/** The format of a scorecard. A change to a formula or a field bumps `SCORECARD_VERSION`: a cached summary of another version is recomputed. */
export const SCORECARD_FORMAT = 'hexactra.benchmark-scorecard' as const;
export const SCORECARD_VERSION = 1 as const;

/** A share with its Wilson 95% interval. All three are null when nothing was counted (`n = 0`). */
export const rateSchema = z.object({
  k: z.number().int().describe('How many counted (the numerator).'),
  n: z.number().int().describe('Out of how many (the denominator).'),
  value: z.number().nullable().describe('k / n, 0 to 1; null when n is 0.'),
  low: z.number().nullable().describe('Lower bound of the Wilson 95% interval.'),
  high: z.number().nullable().describe('Upper bound of the Wilson 95% interval.'),
});
export type Rate = z.infer<typeof rateSchema>;

/** Trial counts of a group. `judged` = `pass` + `fail`: the trials that say something about the agent. */
export const scoreCountsSchema = z.object({
  total: z.number().int(),
  judged: z.number().int().describe('`pass` + `fail`: the denominator of every rate.'),
  pass: z.number().int(),
  fail: z.number().int(),
  error: z.number().int().describe('Could not be judged (node down, provider error): excluded from the rates, counted here.'),
  skipped: z.number().int().describe('Never ran or were stopped (cancelled, the cap): excluded, counted here.'),
  unsupported: z.number().int().describe('The challenge needs a capability the agent lacks: excluded, counted here.'),
  unfinished: z.number().int().describe('Pending or running: only while the benchmark is live.'),
});
export type ScoreCounts = z.infer<typeof scoreCountsSchema>;

const countedSchema = z.object({ key: z.string(), count: z.number().int() });

/** Every metric of one group of trials: a policy, or a policy in one category. */
export const scoreMetricsSchema = z.object({
  counts: scoreCountsSchema,
  successRate: rateSchema.describe('Passes over judged trials.'),
  passAllK: z
    .object({
      k: z.number().int().describe('Trials per challenge.'),
      challenges: z.number().int().describe('Challenges with at least one judged trial: the denominator.'),
      allPassed: z.number().int().describe('Challenges whose k trials were all judged and all passed.'),
      rate: rateSchema,
    })
    .describe('Reliability (pass^k): the share of challenges where every one of the k trials passed.'),
  falseSuccess: rateSchema.describe('Claimed success and graded fail, over judged trials.'),
  falseFailure: rateSchema.describe('Claimed failure (or no claim) and graded pass, over judged trials.'),
  speed: z.object({
    medianActiveMs: z.number().nullable().describe('Median active time of the judged trials.'),
    p90ActiveMs: z.number().nullable().describe('90th percentile (nearest rank) of the active time of the judged trials.'),
    medianSteps: z.number().nullable(),
    medianModelCalls: z.number().nullable(),
  }),
  cost: z.object({
    totalUsd: z.number().describe('Sum of the cost of every trial that ran (judged, error, or stopped part way): the same trials as the benchmark\'s spend.'),
    known: z.boolean().describe('False when any of those trials had a model call with no price: every cost figure is then "at least".'),
    medianPerTrialUsd: z.number().nullable().describe('Median cost of a judged trial.'),
    perSuccessUsd: z.number().nullable().describe('totalUsd / passes; null when there is no pass.'),
  }),
  tokens: z.object({
    input: z.number().int().describe('Total input tokens of every trial that ran.'),
    output: z.number().int(),
    cached: z.number().int().describe('Total input tokens served from the provider cache: part of `input`.'),
    total: z.number().int().describe('input + output.'),
    medianInput: z.number().nullable().describe('Median per judged trial.'),
    medianOutput: z.number().nullable(),
    medianCached: z.number().nullable(),
    perSuccess: z.number().nullable().describe('total / passes; null when there is no pass.'),
  }),
  failureReasons: z.array(countedSchema).describe('Trials by `failureReason` (every trial that has one), most first.'),
  stopReasons: z.array(countedSchema).describe('Trials that ran by their run\'s `stopReason`, most first.'),
  safety: z
    .object({
      flaggedTrials: z.number().int().describe('Trials with at least one failed `safety:` check.'),
      checks: z.array(countedSchema).describe('Each failed `safety:` check by name, with how many trials failed it.'),
    })
    .describe('A flag, never averaged into the success rate.'),
  models: z.array(z.string()).describe('The models (`provider:modelId`) that served the trials: each trial\'s tiers from its start tier to the tier it ended on.'),
});
export type ScoreMetrics = z.infer<typeof scoreMetricsSchema>;

export const policyCategorySchema = z.object({ category: z.enum(CATEGORIES), label: z.string(), metrics: scoreMetricsSchema });

export const policyScoreSchema = z.object({
  ref: z.string(),
  label: z.string(),
  rank: z.number().int().describe('1 is best: success rate, then cost per success, then median active time.'),
  metrics: scoreMetricsSchema,
  categories: z.array(policyCategorySchema).describe('Only the categories the benchmark has, in the suite\'s order.'),
});
export type PolicyScore = z.infer<typeof policyScoreSchema>;

export const rankingEntrySchema = z.object({
  rank: z.number().int(),
  ref: z.string(),
  label: z.string(),
  successRate: z.number().nullable(),
  costPerSuccessUsd: z.number().nullable(),
  costKnown: z.boolean(),
  medianActiveMs: z.number().nullable(),
  totalCostUsd: z.number(),
  totalTokens: z.number().int(),
});

/** One cell of the challenge x policy matrix. */
export const matrixCellSchema = z.object({
  policyRef: z.string(),
  passes: z.number().int(),
  judged: z.number().int(),
  k: z.number().int().describe('Trials per cell.'),
  verdicts: z.array(z.string().nullable()).describe('Each attempt\'s verdict by `trialIndex`; null while it has not ended.'),
  medianActiveMs: z.number().nullable(),
  medianCostUsd: z.number().nullable(),
  costKnown: z.boolean(),
  totalTokens: z.number().int(),
  safetyFlagged: z.boolean(),
});
export const matrixRowSchema = z.object({
  challengeId: z.string(),
  title: z.string(),
  category: z.enum(CATEGORIES).nullable(),
  cells: z.array(matrixCellSchema).describe('One per policy, in the benchmark\'s policy order.'),
});
export type MatrixRow = z.infer<typeof matrixRowSchema>;

export const scorecardTotalsSchema = z.object({
  costUsd: z.number().describe('Total cost of the benchmark (its `spentUsd`).'),
  costKnown: z.boolean().describe('False: some cost is unknown and `costUsd` is "at least".'),
  inputTokens: z.number().int(),
  outputTokens: z.number().int(),
  cachedInputTokens: z.number().int(),
  totalTokens: z.number().int().describe('input + output.'),
  modelCalls: z.number().int(),
  counts: scoreCountsSchema,
});
export type ScorecardTotals = z.infer<typeof scorecardTotalsSchema>;

export const scorecardSchema = z.object({
  format: z.literal(SCORECARD_FORMAT),
  version: z.number().int().describe('The scorecard format. A cached summary of another version is recomputed.'),
  benchmarkId: z.string(),
  name: z.string(),
  status: z.enum(BENCHMARK_STATUSES),
  live: z.boolean().describe('True: computed now from trials still running; false: the final scorecard, cached when the benchmark ended.'),
  suiteKey: z.string(),
  suiteVersion: z.number().int(),
  appVersion: z.string(),
  commit: z.string().nullable(),
  k: z.number().int().describe('Trials per challenge and policy.'),
  computedAt: z.string(),
  totals: scorecardTotalsSchema,
  ranking: z.array(rankingEntrySchema).describe('Best first. No composite score.'),
  policies: z.array(policyScoreSchema).describe('In the benchmark\'s policy order (columns).'),
  categories: z.array(z.object({ id: z.enum(CATEGORIES), label: z.string() })).describe('The categories the benchmark has, in the suite\'s order.'),
  matrix: z.array(matrixRowSchema).describe('One row per challenge, in the benchmark\'s order.'),
});
export class ScorecardResponseDto extends createZodDto(scorecardSchema) {}
export type Scorecard = z.infer<typeof scorecardSchema>;

// ---- Compare ----

export const COMPARED_METRICS = ['successRate', 'passAllK', 'falseSuccessRate', 'medianActiveMs', 'medianCostUsd', 'totalCostUsd', 'costPerSuccessUsd', 'totalTokens', 'inputTokens', 'outputTokens', 'cachedInputTokens', 'tokensPerSuccess'] as const;
export type ComparedMetric = (typeof COMPARED_METRICS)[number];

export const metricDeltaSchema = z.object({
  metric: z.enum(COMPARED_METRICS),
  current: z.number().nullable(),
  baseline: z.number().nullable(),
  delta: z.number().nullable().describe('current - baseline; null when either is null.'),
  better: z.enum(['higher', 'lower']).describe('Which direction is an improvement.'),
  improved: z.boolean().nullable().describe('Whether the delta goes the better way; null when there is no delta or it is 0, or it is within noise.'),
  withinNoise: z.boolean().nullable().describe('A rate only: true when the two Wilson 95% intervals overlap, so the change is not shown to be real. Null for a metric with no interval.'),
  atLeast: z.boolean().describe('A cost only: true when either side has an unknown cost.'),
});
export type MetricDelta = z.infer<typeof metricDeltaSchema>;

export const flippedChallengeSchema = z.object({
  challengeId: z.string(),
  title: z.string(),
  category: z.enum(CATEGORIES).nullable(),
  policyRef: z.string(),
  policyLabel: z.string(),
  baseline: z.object({ outcome: z.enum(['pass', 'fail', 'mixed']), passes: z.number().int(), judged: z.number().int() }),
  current: z.object({ outcome: z.enum(['pass', 'fail', 'mixed']), passes: z.number().int(), judged: z.number().int() }),
  direction: z.enum(['better', 'worse']).describe('By the share of passes.'),
});

const sideSchema = z.object({
  id: z.string(),
  name: z.string(),
  status: z.enum(BENCHMARK_STATUSES),
  suiteKey: z.string(),
  suiteVersion: z.number().int(),
  appVersion: z.string(),
  commit: z.string().nullable(),
  finishedAt: z.string().nullable(),
});

export const benchmarkComparisonSchema = z.object({
  current: sideSchema,
  baseline: sideSchema,
  totals: z.array(metricDeltaSchema).describe('The whole benchmark: total cost, total tokens and the input, output and cached input split.'),
  policies: z.array(
    z.object({
      ref: z.string().describe('The policy in this benchmark.'),
      label: z.string(),
      baselineRef: z.string(),
      baselineLabel: z.string(),
      matchedBy: z.enum(['ref', 'label']),
      deltas: z.array(metricDeltaSchema),
    }),
  ),
  unmatched: z.object({
    current: z.array(z.object({ ref: z.string(), label: z.string() })).describe('Policies of this benchmark with no counterpart in the baseline.'),
    baseline: z.array(z.object({ ref: z.string(), label: z.string() })),
  }),
  flipped: z.array(flippedChallengeSchema).describe('Challenges of a matched policy whose outcome changed (all passed, none passed, or mixed).'),
});
export class BenchmarkComparisonResponseDto extends createZodDto(benchmarkComparisonSchema) {}
export type BenchmarkComparison = z.infer<typeof benchmarkComparisonSchema>;

export const compareQuerySchema = z.object({ baseline: z.uuid().describe('The earlier benchmark, on the same suite key and version.') });
export class CompareQueryDto extends createZodDto(compareQuerySchema) {}
