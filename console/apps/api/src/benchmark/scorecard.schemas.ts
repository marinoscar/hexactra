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
export const SCORECARD_VERSION = 2 as const;

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

// ---- The Benchmark Score (#871) ----

/** The weighting presets of the Overall score. `accuracy` is the default; the order is the order a page lists them in. */
export const SCORE_PRESETS = ['accuracy', 'balanced', 'budget', 'speed'] as const;
export type ScorePreset = (typeof SCORE_PRESETS)[number];
export const DEFAULT_SCORE_PRESET: ScorePreset = 'accuracy';
/** The four dimensions a policy is scored on. */
export const SCORE_DIMENSIONS = ['accuracy', 'cost', 'time', 'tokens'] as const;
export type ScoreDimension = (typeof SCORE_DIMENSIONS)[number];
export const SCORE_GRADES = ['S', 'A', 'B', 'C', 'D'] as const;
export type ScoreGrade = (typeof SCORE_GRADES)[number];
export const SCORE_BADGES = ['most_accurate', 'cheapest', 'fastest', 'most_token_efficient'] as const;
export type ScoreBadge = (typeof SCORE_BADGES)[number];
/** The method's identifier, printed with every score: a change to a formula, a weight or a threshold bumps it (and `SCORECARD_VERSION`). */
export const SCORE_METHOD = 'hexactra.benchmark-score/1' as const;

const weightsSchema = z.object({ accuracy: z.number(), cost: z.number(), time: z.number(), tokens: z.number() }).describe('Percentages; they add up to 100.');

export const overallScoreSchema = z.object({
  value: z.number().nullable().describe('The weighted mean of the four sub-scores, 0 to 100, one decimal. Null when the policy is not rated.'),
  low: z.number().nullable().describe('The Overall score with accuracy at the low end of its 95% band.'),
  high: z.number().nullable().describe('The Overall score with accuracy at the high end of its 95% band.'),
  rank: z.number().int().describe('1 is best under this preset; a policy that is not rated ranks last.'),
  grade: z.enum(SCORE_GRADES).nullable().describe('S 90 and over, A 80, B 70, C 60, D below; null when not rated.'),
  tied: z.boolean().describe('Not first, but its band overlaps the leader\'s: the difference is not shown to be real.'),
});
export type OverallScore = z.infer<typeof overallScoreSchema>;

export const benchmarkScoreSchema = z
  .object({
    rated: z.boolean().describe('False when the policy has no judged trial: every score is then null.'),
    provisional: z.boolean().describe('Fewer than 10 judged trials: the score can move a lot with more trials.'),
    judged: z.number().int(),
    accuracy: z.number().nullable().describe('100 x (0.7 x success rate + 0.3 x pass^k) x (1 - false-success rate).'),
    accuracyLow: z.number().nullable().describe('Accuracy from the low ends of the Wilson intervals (and the high end of false success).'),
    accuracyHigh: z.number().nullable(),
    cost: z.number().nullable().describe('Cost per success against the best policy of the benchmark, on a log scale: the best is 100, 10 times its cost 50, 100 times or more 0. 0 without a pass.'),
    costKnown: z.boolean().describe('False: some cost is unknown, so the cost per success is "at least" and the cost score is at most this.'),
    time: z.number().nullable().describe('Median active time against the best policy with a pass, on the same log scale. 0 without a pass.'),
    tokens: z.number().nullable().describe('Tokens per success against the best policy, on the same log scale. 0 without a pass.'),
    overall: z.object({ accuracy: overallScoreSchema, balanced: overallScoreSchema, budget: overallScoreSchema, speed: overallScoreSchema }),
    badges: z.array(z.enum(SCORE_BADGES)).describe('The dimensions this policy is best at in the benchmark (ties share a badge).'),
  })
  .describe('The Benchmark Score: four sub-scores from 0 to 100 and the Overall score under each preset (docs/benchmark.md, "The Benchmark Score").');
export type BenchmarkScore = z.infer<typeof benchmarkScoreSchema>;

export const scoringSchema = z.object({
  method: z.literal(SCORE_METHOD),
  defaultPreset: z.enum(SCORE_PRESETS),
  presets: z.array(z.object({ id: z.enum(SCORE_PRESETS), label: z.string(), weights: weightsSchema })),
  provisionalBelow: z.number().int().describe('A policy with fewer judged trials than this is provisional.'),
});
export type Scoring = z.infer<typeof scoringSchema>;

export const policyCategorySchema = z.object({ category: z.enum(CATEGORIES), label: z.string(), metrics: scoreMetricsSchema });

export const policyScoreSchema = z.object({
  ref: z.string(),
  label: z.string(),
  rank: z.number().int().describe('1 is best: the Overall score under the default preset, then success rate, cost per success and median active time.'),
  metrics: scoreMetricsSchema,
  score: benchmarkScoreSchema,
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
  score: z.number().nullable().describe('The Overall score under the default preset.'),
  grade: z.enum(SCORE_GRADES).nullable(),
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
  ranking: z.array(rankingEntrySchema).describe('Best first by the Overall score under the default preset; `policies[].score.overall` has the order under each preset.'),
  scoring: scoringSchema,
  policies: z.array(policyScoreSchema).describe('In the benchmark\'s policy order (columns).'),
  categories: z.array(z.object({ id: z.enum(CATEGORIES), label: z.string() })).describe('The categories the benchmark has, in the suite\'s order.'),
  matrix: z.array(matrixRowSchema).describe('One row per challenge, in the benchmark\'s order.'),
});
export class ScorecardResponseDto extends createZodDto(scorecardSchema) {}
export type Scorecard = z.infer<typeof scorecardSchema>;

// ---- Compare ----

export const COMPARED_METRICS = ['successRate', 'passAllK', 'falseSuccessRate', 'medianActiveMs', 'medianCostUsd', 'totalCostUsd', 'costPerSuccessUsd', 'totalTokens', 'inputTokens', 'outputTokens', 'cachedInputTokens', 'tokensPerSuccess', 'overallScore', 'accuracyScore', 'costScore', 'timeScore', 'tokensScore'] as const;
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
