// The scorecard's formulas (E44.4, #742): pure functions over trial rows, so every number is unit-tested without a database
// (`test/benchmark-scorecard.spec.ts`). The definitions a person reads are in `docs/benchmark.md`, "Reading the scorecard"; keep both in
// step, and bump `SCORECARD_VERSION` when a formula changes.
import type { BenchmarkStatus } from './benchmark.constants';
import type { BenchmarkTrialView } from './benchmarks.schemas';
import { scorePolicies, scoringOf, tieBreak } from './score';
import {
  COMPARED_METRICS,
  DEFAULT_SCORE_PRESET,
  SCORECARD_FORMAT,
  SCORECARD_VERSION,
  type BenchmarkComparison,
  type BenchmarkScore,
  type ComparedMetric,
  type MatrixRow,
  type MetricDelta,
  type PolicyScore,
  type Rate,
  type ScoreCounts,
  type ScoreMetrics,
  type Scorecard,
} from './scorecard.schemas';
import { CATEGORIES, CATEGORY_LABELS, isSafetyCheck, type Category } from './suite/types';

/** The fields of a trial the scorecard reads: all of them are on the trial row, so a deleted run changes nothing. */
export type ScoreTrial = Pick<
  BenchmarkTrialView,
  | 'challengeId'
  | 'challengeTitle'
  | 'category'
  | 'policyRef'
  | 'policyLabel'
  | 'trialIndex'
  | 'status'
  | 'verdict'
  | 'failureReason'
  | 'checks'
  | 'claimedSuccess'
  | 'activeMs'
  | 'steps'
  | 'modelCalls'
  | 'inputTokens'
  | 'outputTokens'
  | 'cachedInputTokens'
  | 'costUsd'
  | 'costKnown'
  | 'stopReason'
  | 'models'
>;

/** The fields of a benchmark the scorecard reads. */
export interface ScoreBenchmark {
  id: string;
  name: string;
  status: BenchmarkStatus;
  suiteKey: string;
  suiteVersion: number;
  appVersion: string;
  commit: string | null;
  spentUsd: number;
  config: { challengeIds: string[]; policies: { ref: string; label: string }[]; trials: number };
}

/** The two-sided 95% normal quantile. */
export const Z_95 = 1.959963984540054;

/** The Wilson score interval of k successes in n at 95%. Null bounds when n is 0. */
export function wilson(k: number, n: number, z = Z_95): Rate {
  if (n <= 0) return { k, n, value: null, low: null, high: null };
  const p = k / n;
  const z2 = z * z;
  const d = 1 + z2 / n;
  const centre = (p + z2 / (2 * n)) / d;
  const half = (z * Math.sqrt((p * (1 - p)) / n + z2 / (4 * n * n))) / d;
  return { k, n, value: p, low: Math.max(0, centre - half), high: Math.min(1, centre + half) };
}

/** The median; the mean of the two middle values for an even count. Null for no values. */
export function median(values: readonly number[]): number | null {
  if (values.length === 0) return null;
  const s = [...values].sort((a, b) => a - b);
  const mid = s.length >> 1;
  return s.length % 2 ? s[mid]! : (s[mid - 1]! + s[mid]!) / 2;
}

/** The q-th percentile by nearest rank (the smallest value with at least q of the values at or below it). Null for no values. */
export function percentile(values: readonly number[], q: number): number | null {
  if (values.length === 0) return null;
  const s = [...values].sort((a, b) => a - b);
  return s[Math.min(s.length, Math.max(1, Math.ceil(q * s.length))) - 1]!;
}

const nums = (values: readonly (number | null | undefined)[]): number[] => values.filter((v): v is number => typeof v === 'number' && Number.isFinite(v));
const sum = (values: readonly (number | null | undefined)[]): number => nums(values).reduce((a, b) => a + b, 0);
/** Money to a millionth of a dollar, so sums of decimals compare exactly. */
const usd = (v: number): number => Math.round(v * 1e6) / 1e6;
const usdOrNull = (v: number | null): number | null => (v === null ? null : usd(v));

const isJudged = (t: ScoreTrial): boolean => t.verdict === 'pass' || t.verdict === 'fail';
/**
 * A trial that ran and has its run's metrics on it, whatever its verdict: judged, an error, or one stopped part way (skipped). Its
 * cost and tokens count in every total, as they count in the benchmark's spend.
 */
const ran = (t: ScoreTrial): boolean => t.costUsd !== null || t.inputTokens !== null || t.modelCalls !== null;

const tally = (keys: readonly (string | null)[]): { key: string; count: number }[] => {
  const m = new Map<string, number>();
  for (const k of keys) if (k) m.set(k, (m.get(k) ?? 0) + 1);
  return [...m.entries()].map(([key, count]) => ({ key, count })).sort((a, b) => b.count - a.count || a.key.localeCompare(b.key));
};

export function countsOf(trials: readonly ScoreTrial[]): ScoreCounts {
  const c: ScoreCounts = { total: trials.length, judged: 0, pass: 0, fail: 0, error: 0, skipped: 0, unsupported: 0, unfinished: 0 };
  for (const t of trials) {
    if (t.verdict === 'pass' || t.verdict === 'fail' || t.verdict === 'error' || t.verdict === 'skipped' || t.verdict === 'unsupported') c[t.verdict] += 1;
    else c.unfinished += 1;
  }
  c.judged = c.pass + c.fail;
  return c;
}

/** The models that served a trial: its tiers from the start tier up to the tier it ended on. */
export function servedModels(t: Pick<ScoreTrial, 'models'>): string[] {
  const m = t.models;
  if (!m) return [];
  const upTo = m.tiers.findIndex((x) => x.tier === m.finalTier);
  const tiers = upTo >= 0 ? m.tiers.slice(0, upTo + 1) : m.tiers.slice(0, 1);
  const out = tiers.map((x) => x.model).filter((x): x is string => !!x);
  return out.length ? out : m.model ? [m.model] : [];
}

/** Every metric of a group of trials. `k` is the trials per challenge. */
export function metricsOf(trials: readonly ScoreTrial[], k: number): ScoreMetrics {
  const counts = countsOf(trials);
  const judged = trials.filter(isJudged);
  const spent = trials.filter(ran);

  const byChallenge = new Map<string, ScoreTrial[]>();
  for (const t of judged) byChallenge.set(t.challengeId, [...(byChallenge.get(t.challengeId) ?? []), t]);
  const allPassed = [...byChallenge.values()].filter((ts) => ts.length >= k && ts.every((t) => t.verdict === 'pass')).length;

  const totalUsd = usd(sum(spent.map((t) => t.costUsd)));
  const known = spent.every((t) => t.costKnown !== false);
  const input = sum(spent.map((t) => t.inputTokens));
  const output = sum(spent.map((t) => t.outputTokens));
  const cached = sum(spent.map((t) => t.cachedInputTokens));
  const passes = counts.pass;

  const failedSafety = trials.map((t) => (t.checks ?? []).filter((c) => isSafetyCheck(c) && !c.pass).map((c) => c.name));
  const models: string[] = [];
  for (const t of trials) for (const m of servedModels(t)) if (!models.includes(m)) models.push(m);

  return {
    counts,
    successRate: wilson(passes, counts.judged),
    passAllK: { k, challenges: byChallenge.size, allPassed, rate: wilson(allPassed, byChallenge.size) },
    falseSuccess: wilson(judged.filter((t) => t.verdict === 'fail' && t.claimedSuccess === true).length, counts.judged),
    falseFailure: wilson(judged.filter((t) => t.verdict === 'pass' && t.claimedSuccess !== true).length, counts.judged),
    speed: {
      medianActiveMs: median(nums(judged.map((t) => t.activeMs))),
      p90ActiveMs: percentile(nums(judged.map((t) => t.activeMs)), 0.9),
      medianSteps: median(nums(judged.map((t) => t.steps))),
      medianModelCalls: median(nums(judged.map((t) => t.modelCalls))),
    },
    cost: {
      totalUsd,
      known,
      medianPerTrialUsd: usdOrNull(median(nums(judged.map((t) => t.costUsd)))),
      perSuccessUsd: passes > 0 ? usd(totalUsd / passes) : null,
    },
    tokens: {
      input,
      output,
      cached,
      total: input + output,
      medianInput: median(nums(judged.map((t) => t.inputTokens))),
      medianOutput: median(nums(judged.map((t) => t.outputTokens))),
      medianCached: median(nums(judged.map((t) => t.cachedInputTokens))),
      perSuccess: passes > 0 ? (input + output) / passes : null,
    },
    failureReasons: tally(trials.map((t) => t.failureReason)),
    stopReasons: tally(spent.map((t) => t.stopReason)),
    safety: { flaggedTrials: failedSafety.filter((names) => names.length > 0).length, checks: tally(failedSafety.flat()) },
    models,
  };
}

/**
 * Policies by the tie-break of the Benchmark Score: success rate (higher), then cost per success (lower), then median active time
 * (lower), then the configured order. The scorecard ranks by the Overall score first (`score.ts`); this is its order among equals.
 */
export function rankPolicies<T extends { ref: string; metrics: ScoreMetrics }>(policies: readonly T[]): T[] {
  return policies
    .map((p, i) => ({ p, i }))
    .sort((a, b) => tieBreak(a.p.metrics, b.p.metrics) || a.i - b.i)
    .map((x) => x.p);
}

function matrixOf(b: ScoreBenchmark, trials: readonly ScoreTrial[], challengeIds: string[], policyRefs: string[]): MatrixRow[] {
  const k = b.config.trials;
  return challengeIds.map((challengeId) => {
    const rows = trials.filter((t) => t.challengeId === challengeId);
    const first = rows[0];
    return {
      challengeId,
      title: first?.challengeTitle ?? challengeId,
      category: first?.category ?? null,
      cells: policyRefs.map((policyRef) => {
        const cell = rows.filter((t) => t.policyRef === policyRef);
        const judged = cell.filter(isJudged);
        const spent = cell.filter(ran);
        const verdicts: (string | null)[] = Array.from({ length: Math.max(k, ...cell.map((t) => t.trialIndex + 1)) }, () => null);
        for (const t of cell) verdicts[t.trialIndex] = t.verdict;
        return {
          policyRef,
          passes: judged.filter((t) => t.verdict === 'pass').length,
          judged: judged.length,
          k,
          verdicts,
          medianActiveMs: median(nums(judged.map((t) => t.activeMs))),
          medianCostUsd: usdOrNull(median(nums(judged.map((t) => t.costUsd)))),
          costKnown: spent.every((t) => t.costKnown !== false),
          totalTokens: sum(spent.map((t) => t.inputTokens)) + sum(spent.map((t) => t.outputTokens)),
          safetyFlagged: cell.some((t) => (t.checks ?? []).some((c) => isSafetyCheck(c) && !c.pass)),
        };
      }),
    };
  });
}

/**
 * The scorecard of a benchmark from its trials. `live`: whether it is computed from a benchmark still running (the caller decides).
 * A benchmark with no judged trial gives an empty scorecard (null rates), never an error.
 */
export function computeScorecard(b: ScoreBenchmark, trials: readonly ScoreTrial[], opts: { live: boolean; now?: Date }): Scorecard {
  const k = b.config.trials;
  // The configured order, then anything a trial names that the config does not (a row this code did not write).
  const policies = [...b.config.policies];
  for (const t of trials) if (!policies.some((p) => p.ref === t.policyRef)) policies.push({ ref: t.policyRef, label: t.policyLabel });
  const challengeIds = [...b.config.challengeIds];
  for (const t of trials) if (!challengeIds.includes(t.challengeId)) challengeIds.push(t.challengeId);
  const present = CATEGORIES.filter((c) => trials.some((t) => t.category === c));

  const scored = policies.map((p) => {
    const mine = trials.filter((t) => t.policyRef === p.ref);
    return {
      ref: p.ref,
      label: p.label,
      metrics: metricsOf(mine, k),
      categories: present.map((category: Category) => ({ category, label: CATEGORY_LABELS[category], metrics: metricsOf(mine.filter((t) => t.category === category), k) })),
    };
  });
  const scores = scorePolicies(scored);
  const withRank: PolicyScore[] = scored.map((p, i) => ({ ...p, rank: scores[i]!.overall[DEFAULT_SCORE_PRESET].rank, score: scores[i]! }));
  const ranked = [...withRank].sort((a, b) => a.rank - b.rank);

  const spent = trials.filter(ran);
  const input = sum(spent.map((t) => t.inputTokens));
  const output = sum(spent.map((t) => t.outputTokens));
  return {
    format: SCORECARD_FORMAT,
    version: SCORECARD_VERSION,
    benchmarkId: b.id,
    name: b.name,
    status: b.status,
    live: opts.live,
    suiteKey: b.suiteKey,
    suiteVersion: b.suiteVersion,
    appVersion: b.appVersion,
    commit: b.commit,
    k,
    computedAt: (opts.now ?? new Date()).toISOString(),
    totals: {
      costUsd: usd(b.spentUsd),
      costKnown: spent.every((t) => t.costKnown !== false),
      inputTokens: input,
      outputTokens: output,
      cachedInputTokens: sum(spent.map((t) => t.cachedInputTokens)),
      totalTokens: input + output,
      modelCalls: sum(spent.map((t) => t.modelCalls)),
      counts: countsOf(trials),
    },
    ranking: ranked.map((p) => ({
      rank: p.rank,
      ref: p.ref,
      label: p.label,
      successRate: p.metrics.successRate.value,
      costPerSuccessUsd: p.metrics.cost.perSuccessUsd,
      costKnown: p.metrics.cost.known,
      medianActiveMs: p.metrics.speed.medianActiveMs,
      totalCostUsd: p.metrics.cost.totalUsd,
      totalTokens: p.metrics.tokens.total,
      score: p.score.overall[DEFAULT_SCORE_PRESET].value,
      grade: p.score.overall[DEFAULT_SCORE_PRESET].grade,
    })),
    scoring: scoringOf(),
    policies: withRank,
    categories: present.map((id) => ({ id, label: CATEGORY_LABELS[id] })),
    matrix: matrixOf(b, trials, challengeIds, policies.map((p) => p.ref)),
  };
}

// ---- Compare ----

/** Whether two intervals overlap; null when either has none. */
export function overlaps(a: Rate, b: Rate): boolean | null {
  if (a.low === null || a.high === null || b.low === null || b.high === null) return null;
  return a.low <= b.high && b.low <= a.high;
}

const BETTER: Record<ComparedMetric, 'higher' | 'lower'> = {
  successRate: 'higher',
  passAllK: 'higher',
  falseSuccessRate: 'lower',
  medianActiveMs: 'lower',
  medianCostUsd: 'lower',
  totalCostUsd: 'lower',
  costPerSuccessUsd: 'lower',
  totalTokens: 'lower',
  inputTokens: 'lower',
  outputTokens: 'lower',
  cachedInputTokens: 'lower',
  tokensPerSuccess: 'lower',
  overallScore: 'higher',
  accuracyScore: 'higher',
  costScore: 'higher',
  timeScore: 'higher',
  tokensScore: 'higher',
};
const COST_METRICS: readonly ComparedMetric[] = ['medianCostUsd', 'totalCostUsd', 'costPerSuccessUsd'];

/** One metric's delta. `rates`: the two intervals, for a rate. */
export function deltaOf(metric: ComparedMetric, current: number | null, baseline: number | null, opts: { rates?: [Rate, Rate]; costKnown?: [boolean, boolean] } = {}): MetricDelta {
  const raw = current === null || baseline === null ? null : current - baseline;
  const delta = raw === null ? null : COST_METRICS.includes(metric) ? usd(raw) : Math.round(raw * 1e9) / 1e9;
  const withinNoise = opts.rates ? overlaps(opts.rates[0], opts.rates[1]) : null;
  const better = BETTER[metric];
  const improved = delta === null || delta === 0 || withinNoise === true ? null : better === 'higher' ? delta > 0 : delta < 0;
  return { metric, current, baseline, delta, better, improved, withinNoise, atLeast: COST_METRICS.includes(metric) && !!opts.costKnown && !(opts.costKnown[0] && opts.costKnown[1]) };
}

/**
 * The deltas of one policy against its counterpart. The score deltas compare each policy's score within its own benchmark (the cost,
 * time and token scores are relative to that benchmark's best), under the default preset.
 */
export function policyDeltas(cur: ScoreMetrics, base: ScoreMetrics, scores?: { cur: BenchmarkScore; base: BenchmarkScore }): MetricDelta[] {
  const known: [boolean, boolean] = [cur.cost.known, base.cost.known];
  const by: Record<ComparedMetric, MetricDelta> = {
    successRate: deltaOf('successRate', cur.successRate.value, base.successRate.value, { rates: [cur.successRate, base.successRate] }),
    passAllK: deltaOf('passAllK', cur.passAllK.rate.value, base.passAllK.rate.value, { rates: [cur.passAllK.rate, base.passAllK.rate] }),
    falseSuccessRate: deltaOf('falseSuccessRate', cur.falseSuccess.value, base.falseSuccess.value, { rates: [cur.falseSuccess, base.falseSuccess] }),
    medianActiveMs: deltaOf('medianActiveMs', cur.speed.medianActiveMs, base.speed.medianActiveMs),
    medianCostUsd: deltaOf('medianCostUsd', cur.cost.medianPerTrialUsd, base.cost.medianPerTrialUsd, { costKnown: known }),
    totalCostUsd: deltaOf('totalCostUsd', cur.cost.totalUsd, base.cost.totalUsd, { costKnown: known }),
    costPerSuccessUsd: deltaOf('costPerSuccessUsd', cur.cost.perSuccessUsd, base.cost.perSuccessUsd, { costKnown: known }),
    totalTokens: deltaOf('totalTokens', cur.tokens.total, base.tokens.total),
    inputTokens: deltaOf('inputTokens', cur.tokens.input, base.tokens.input),
    outputTokens: deltaOf('outputTokens', cur.tokens.output, base.tokens.output),
    cachedInputTokens: deltaOf('cachedInputTokens', cur.tokens.cached, base.tokens.cached),
    tokensPerSuccess: deltaOf('tokensPerSuccess', cur.tokens.perSuccess, base.tokens.perSuccess),
    overallScore: deltaOf('overallScore', scores?.cur.overall[DEFAULT_SCORE_PRESET].value ?? null, scores?.base.overall[DEFAULT_SCORE_PRESET].value ?? null),
    accuracyScore: deltaOf('accuracyScore', scores?.cur.accuracy ?? null, scores?.base.accuracy ?? null),
    costScore: deltaOf('costScore', scores?.cur.cost ?? null, scores?.base.cost ?? null),
    timeScore: deltaOf('timeScore', scores?.cur.time ?? null, scores?.base.time ?? null),
    tokensScore: deltaOf('tokensScore', scores?.cur.tokens ?? null, scores?.base.tokens ?? null),
  };
  return COMPARED_METRICS.map((m) => by[m]);
}

/** A cell's outcome: all judged trials passed, none did, or some did. Null when none was judged. */
export function outcomeOf(cell: { passes: number; judged: number }): 'pass' | 'fail' | 'mixed' | null {
  if (cell.judged === 0) return null;
  return cell.passes === cell.judged ? 'pass' : cell.passes === 0 ? 'fail' : 'mixed';
}

export interface CompareSide {
  id: string;
  name: string;
  status: BenchmarkStatus;
  suiteKey: string;
  suiteVersion: number;
  appVersion: string;
  commit: string | null;
  finishedAt: string | null;
}

/**
 * Compares a scorecard with its baseline's. The caller has checked that both are on one suite key and version. Policies are matched by
 * ref, then by label among those left.
 */
export function compareScorecards(cur: Scorecard, base: Scorecard, sides: { current: CompareSide; baseline: CompareSide }): BenchmarkComparison {
  const left = [...base.policies];
  const pairs: { cur: PolicyScore; base: PolicyScore; matchedBy: 'ref' | 'label' }[] = [];
  const unmatched: PolicyScore[] = [];
  for (const p of cur.policies) {
    const i = left.findIndex((b) => b.ref === p.ref);
    if (i >= 0) pairs.push({ cur: p, base: left.splice(i, 1)[0]!, matchedBy: 'ref' });
    else unmatched.push(p);
  }
  for (const p of [...unmatched]) {
    const i = left.findIndex((b) => b.label === p.label);
    if (i >= 0) {
      pairs.push({ cur: p, base: left.splice(i, 1)[0]!, matchedBy: 'label' });
      unmatched.splice(unmatched.indexOf(p), 1);
    }
  }
  pairs.sort((a, b) => cur.policies.indexOf(a.cur) - cur.policies.indexOf(b.cur));

  const flipped: BenchmarkComparison['flipped'] = [];
  for (const { cur: p, base: q } of pairs) {
    for (const row of cur.matrix) {
      const brow = base.matrix.find((r) => r.challengeId === row.challengeId);
      const c = row.cells.find((x) => x.policyRef === p.ref);
      const d = brow?.cells.find((x) => x.policyRef === q.ref);
      if (!c || !d) continue;
      const [now, before] = [outcomeOf(c), outcomeOf(d)];
      if (!now || !before || now === before) continue;
      flipped.push({
        challengeId: row.challengeId,
        title: row.title,
        category: row.category,
        policyRef: p.ref,
        policyLabel: p.label,
        baseline: { outcome: before, passes: d.passes, judged: d.judged },
        current: { outcome: now, passes: c.passes, judged: c.judged },
        direction: c.passes / c.judged > d.passes / d.judged ? 'better' : 'worse',
      });
    }
  }

  const known: [boolean, boolean] = [cur.totals.costKnown, base.totals.costKnown];
  return {
    current: sides.current,
    baseline: sides.baseline,
    totals: [
      deltaOf('totalCostUsd', cur.totals.costUsd, base.totals.costUsd, { costKnown: known }),
      deltaOf('totalTokens', cur.totals.totalTokens, base.totals.totalTokens),
      deltaOf('inputTokens', cur.totals.inputTokens, base.totals.inputTokens),
      deltaOf('outputTokens', cur.totals.outputTokens, base.totals.outputTokens),
      deltaOf('cachedInputTokens', cur.totals.cachedInputTokens, base.totals.cachedInputTokens),
    ],
    policies: pairs.map(({ cur: p, base: q, matchedBy }) => ({ ref: p.ref, label: p.label, baselineRef: q.ref, baselineLabel: q.label, matchedBy, deltas: policyDeltas(p.metrics, q.metrics, { cur: p.score, base: q.score }) })),
    unmatched: { current: unmatched.map((p) => ({ ref: p.ref, label: p.label })), baseline: left.map((p) => ({ ref: p.ref, label: p.label })) },
    flipped,
  };
}
