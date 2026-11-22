// The Benchmark Score (#871): one number per policy, the way AI models are scored on a leaderboard. Pure functions over the metrics the
// scorecard already computed, so every number is unit-tested without a database (`test/benchmark-score.spec.ts`). The definitions a
// person reads are in `docs/benchmark.md`, "The Benchmark Score"; keep both in step, and bump `SCORE_METHOD` and `SCORECARD_VERSION`
// when a formula, a weight or a threshold changes.
import {
  DEFAULT_SCORE_PRESET,
  SCORE_BADGES,
  SCORE_METHOD,
  SCORE_PRESETS,
  type BenchmarkScore,
  type OverallScore,
  type ScoreBadge,
  type ScoreDimension,
  type ScoreGrade,
  type ScoreMetrics,
  type ScorePreset,
  type Scoring,
} from './scorecard.schemas';

/** The weight of each dimension in the Overall score, per preset, in percent (each row adds up to 100). */
export const SCORE_WEIGHTS: Record<ScorePreset, Record<ScoreDimension, number>> = {
  accuracy: { accuracy: 50, cost: 20, time: 15, tokens: 15 },
  balanced: { accuracy: 25, cost: 25, time: 25, tokens: 25 },
  budget: { accuracy: 35, cost: 40, time: 10, tokens: 15 },
  speed: { accuracy: 35, cost: 15, time: 40, tokens: 10 },
};

export const SCORE_PRESET_LABELS: Record<ScorePreset, string> = {
  accuracy: 'Accuracy first',
  balanced: 'Balanced',
  budget: 'Budget',
  speed: 'Speed',
};

/** The share of accuracy that is the success rate; the rest is reliability (pass^k). */
export const ACCURACY_SUCCESS_WEIGHT = 0.7;
/** A policy with fewer judged trials than this is provisional. */
export const PROVISIONAL_BELOW = 10;
/** The lowest Overall score of each grade, best first; below the last is D. */
export const GRADE_FLOORS: readonly [ScoreGrade, number][] = [
  ['S', 90],
  ['A', 80],
  ['B', 70],
  ['C', 60],
];
/**
 * Added to both sides of a ratio so a best value of 0 (a model with no price, a cached run) does not divide by zero: a millionth of a
 * dollar, one millisecond, one token. Too small to move any real score.
 */
const EPSILON: Record<'cost' | 'time' | 'tokens', number> = { cost: 1e-6, time: 1, tokens: 1 };

/** The scoring block of a scorecard: what a page or a report prints next to the scores. */
export function scoringOf(): Scoring {
  return {
    method: SCORE_METHOD,
    defaultPreset: DEFAULT_SCORE_PRESET,
    presets: SCORE_PRESETS.map((id) => ({ id, label: SCORE_PRESET_LABELS[id], weights: { ...SCORE_WEIGHTS[id] } })),
    provisionalBelow: PROVISIONAL_BELOW,
  };
}

/** One decimal. */
export const round1 = (v: number): number => Math.round(v * 10) / 10;
const clamp100 = (v: number): number => Math.min(100, Math.max(0, v));

/** The grade of an Overall score; null for no score. */
export function gradeOf(score: number | null): ScoreGrade | null {
  if (score === null) return null;
  for (const [grade, floor] of GRADE_FLOORS) if (score >= floor) return grade;
  return 'D';
}

/** 100 x (0.7 x success + 0.3 x pass^k) x (1 - false success), from three shares between 0 and 1. */
export function accuracyFrom(success: number, passAllK: number, falseSuccess: number): number {
  return clamp100(100 * (ACCURACY_SUCCESS_WEIGHT * success + (1 - ACCURACY_SUCCESS_WEIGHT) * passAllK) * (1 - falseSuccess));
}

/**
 * The accuracy score and its band of a policy, or nulls when nothing was judged. The band takes the low ends of the success and pass^k
 * intervals with the high end of the false-success interval (and the reverse), so it is the widest accuracy the trials allow at 95%.
 */
export function accuracyScore(m: ScoreMetrics): { value: number | null; low: number | null; high: number | null } {
  const s = m.successRate;
  if (s.value === null || m.counts.judged === 0) return { value: null, low: null, high: null };
  const p = m.passAllK.rate;
  const f = m.falseSuccess;
  return {
    value: round1(accuracyFrom(s.value, p.value ?? 0, f.value ?? 0)),
    low: round1(accuracyFrom(s.low ?? 0, p.low ?? 0, f.high ?? 0)),
    high: round1(accuracyFrom(s.high ?? 0, p.high ?? 0, f.low ?? 0)),
  };
}

/** How many times worse than the best scores 0 on a lower-is-better dimension: two orders of magnitude. */
export const RELATIVE_RANGE = 100;

/**
 * A lower-is-better value scored against the best of the benchmark, on a log scale: 100 x (1 - log10(value / best) / log10(100)).
 * Equal to the best is 100, twice the best about 85, ten times 50, a hundred times or worse 0. A log scale because cost, time and tokens
 * differ by multiples, and a linear ratio (4 times the cost scoring 25) would let a cheap policy outscore an accurate one under any
 * weighting. `value` null (no pass) scores 0.
 */
export function relativeScore(value: number | null, best: number | null, dim: 'cost' | 'time' | 'tokens'): number {
  if (value === null || best === null) return 0;
  const e = EPSILON[dim];
  const ratio = (Math.max(0, value) + e) / (Math.max(0, best) + e);
  if (ratio <= 1) return 100;
  return round1(clamp100(100 * (1 - Math.log10(ratio) / Math.log10(RELATIVE_RANGE))));
}

/** The value of a policy that a lower-is-better dimension compares, or null when the policy has no pass (it scores 0 there). */
function rawOf(m: ScoreMetrics, dim: 'cost' | 'time' | 'tokens'): number | null {
  if (m.counts.pass === 0) return null;
  if (dim === 'cost') return m.cost.perSuccessUsd;
  if (dim === 'tokens') return m.tokens.perSuccess;
  return m.speed.medianActiveMs;
}

const minOf = (values: (number | null)[]): number | null => {
  const ns = values.filter((v): v is number => v !== null && Number.isFinite(v));
  return ns.length ? Math.min(...ns) : null;
};

/** The weighted mean of the four sub-scores under one preset's weights. */
export function weighted(sub: Record<ScoreDimension, number>, preset: ScorePreset): number {
  const w = SCORE_WEIGHTS[preset];
  return round1((sub.accuracy * w.accuracy + sub.cost * w.cost + sub.time * w.time + sub.tokens * w.tokens) / 100);
}

/** Nulls last, then ascending or descending. */
const cmp = (a: number | null, b: number | null, dir: 1 | -1): number => (a === null ? (b === null ? 0 : 1) : b === null ? -1 : dir * (a - b));

/**
 * The tie-break when two Overall scores are equal: the higher success rate, then the lower cost per success, then the lower median
 * active time. Zero when they are equal on all three.
 */
export function tieBreak(a: ScoreMetrics, b: ScoreMetrics): number {
  return cmp(a.successRate.value, b.successRate.value, -1) || cmp(a.cost.perSuccessUsd, b.cost.perSuccessUsd, 1) || cmp(a.speed.medianActiveMs, b.speed.medianActiveMs, 1);
}

/**
 * Scores every policy of a benchmark. The cost, time and token scores are relative to the best policy of this benchmark, so a score
 * compares policies within one benchmark; across benchmarks, compare the raw metrics. The result is in the input order.
 */
export function scorePolicies<T extends { ref: string; metrics: ScoreMetrics }>(policies: readonly T[]): BenchmarkScore[] {
  const best = {
    cost: minOf(policies.map((p) => rawOf(p.metrics, 'cost'))),
    time: minOf(policies.map((p) => rawOf(p.metrics, 'time'))),
    tokens: minOf(policies.map((p) => rawOf(p.metrics, 'tokens'))),
  };

  const base = policies.map((p) => {
    const m = p.metrics;
    const acc = accuracyScore(m);
    const rated = acc.value !== null;
    const sub = rated
      ? {
          accuracy: acc.value!,
          cost: relativeScore(rawOf(m, 'cost'), best.cost, 'cost'),
          time: relativeScore(rawOf(m, 'time'), best.time, 'time'),
          tokens: relativeScore(rawOf(m, 'tokens'), best.tokens, 'tokens'),
        }
      : null;
    const overall = {} as Record<ScorePreset, { value: number | null; low: number | null; high: number | null }>;
    for (const preset of SCORE_PRESETS) {
      overall[preset] = sub
        ? { value: weighted(sub, preset), low: weighted({ ...sub, accuracy: acc.low! }, preset), high: weighted({ ...sub, accuracy: acc.high! }, preset) }
        : { value: null, low: null, high: null };
    }
    return { m, acc, rated, sub, overall };
  });

  // The order under each preset: the higher Overall score, then the tie-break, then the benchmark's policy order.
  const ranks = {} as Record<ScorePreset, number[]>;
  for (const preset of SCORE_PRESETS) {
    const order = base
      .map((b, i) => ({ b, i }))
      .sort((x, y) => cmp(x.b.overall[preset].value, y.b.overall[preset].value, -1) || tieBreak(x.b.m, y.b.m) || x.i - y.i)
      .map((x) => x.i);
    ranks[preset] = base.map((_, i) => order.indexOf(i) + 1);
  }

  // A badge goes to every rated policy with the best sub-score of a dimension, when that best is above 0.
  const badgeDims: Record<ScoreBadge, ScoreDimension> = { most_accurate: 'accuracy', cheapest: 'cost', fastest: 'time', most_token_efficient: 'tokens' };
  const top = Object.fromEntries(
    SCORE_BADGES.map((badge) => [badge, Math.max(0, ...base.filter((b) => b.sub).map((b) => b.sub![badgeDims[badge]]))]),
  ) as Record<ScoreBadge, number>;

  return base.map((b, i) => {
    const overall = {} as Record<ScorePreset, OverallScore>;
    for (const preset of SCORE_PRESETS) {
      const o = b.overall[preset];
      const leader = base[ranks[preset].indexOf(1)]!.overall[preset];
      const tied = ranks[preset][i]! > 1 && o.high !== null && leader.low !== null && o.high >= leader.low;
      overall[preset] = { value: o.value, low: o.low, high: o.high, rank: ranks[preset][i]!, grade: gradeOf(o.value), tied };
    }
    return {
      rated: b.rated,
      provisional: b.rated && b.m.counts.judged < PROVISIONAL_BELOW,
      judged: b.m.counts.judged,
      accuracy: b.acc.value,
      accuracyLow: b.acc.low,
      accuracyHigh: b.acc.high,
      cost: b.sub?.cost ?? null,
      costKnown: b.m.cost.known,
      time: b.sub?.time ?? null,
      tokens: b.sub?.tokens ?? null,
      overall,
      badges: b.sub ? SCORE_BADGES.filter((badge) => top[badge] > 0 && b.sub![badgeDims[badge]] === top[badge]) : [],
    };
  });
}
