// The Benchmark Score (#871), without a database. Every expected number was worked out by hand from the metrics in this file (the
// formulas are in docs/benchmark.md, "The Benchmark Score"); a value whose last decimal sits on a .x5 boundary is checked to within 0.05.
import { computeScorecard, type ScoreBenchmark, type ScoreTrial } from '../src/benchmark/scorecard';
import { SCORE_PRESETS, scorecardSchema, type Rate, type ScoreMetrics } from '../src/benchmark/scorecard.schemas';
import { SCORE_WEIGHTS, accuracyFrom, accuracyScore, gradeOf, relativeScore, scorePolicies, scoringOf, weighted } from '../src/benchmark/score';

const rate = (value: number | null, low: number | null, high: number | null): Rate => ({ k: 0, n: 0, value, low, high });

interface Fixture {
  judged: number;
  pass: number;
  s: [number, number, number];
  p: [number, number, number];
  f: [number, number, number];
  costPerSuccess: number | null;
  tokensPerSuccess: number | null;
  medianMs: number | null;
  known?: boolean;
}

function metrics(x: Fixture): ScoreMetrics {
  return {
    counts: { total: x.judged, judged: x.judged, pass: x.pass, fail: x.judged - x.pass, error: 0, skipped: 0, unsupported: 0, unfinished: 0 },
    successRate: rate(...x.s),
    passAllK: { k: 3, challenges: 1, allPassed: 0, rate: rate(...x.p) },
    falseSuccess: rate(...x.f),
    falseFailure: rate(0, 0, 0),
    askedPerson: { trials: 0, rate: rate(0, 0, 0), questions: 0 },
    speed: { medianActiveMs: x.medianMs, p90ActiveMs: x.medianMs, medianSteps: null, medianModelCalls: null },
    cost: { totalUsd: 0, known: x.known ?? true, medianPerTrialUsd: null, perSuccessUsd: x.costPerSuccess },
    tokens: { input: 0, output: 0, cached: 0, total: 0, medianInput: null, medianOutput: null, medianCached: null, perSuccess: x.tokensPerSuccess },
    failureReasons: [],
    stopReasons: [],
    safety: { flaggedTrials: 0, checks: [] },
    models: [],
  };
}

const NONE: ScoreMetrics = { ...metrics({ judged: 0, pass: 0, s: [0, 0, 0], p: [0, 0, 0], f: [0, 0, 0], costPerSuccess: null, tokensPerSuccess: null, medianMs: null }), successRate: rate(null, null, null), passAllK: { k: 3, challenges: 0, allPassed: 0, rate: rate(null, null, null) }, falseSuccess: rate(null, null, null) };

// accurate: 90% success, slower and four times dearer. cheap: 60% success, the cheapest, fastest and leanest. none: nothing judged.
// zero: judged but never passed.
const POLICIES = [
  { ref: 'accurate', metrics: metrics({ judged: 20, pass: 18, s: [0.9, 0.7, 0.97], p: [0.8, 0.55, 0.93], f: [0, 0, 0.16], costPerSuccess: 0.04, tokensPerSuccess: 4000, medianMs: 20_000 }) },
  { ref: 'cheap', metrics: metrics({ judged: 20, pass: 12, s: [0.6, 0.39, 0.78], p: [0.4, 0.2, 0.64], f: [0.1, 0.03, 0.3], costPerSuccess: 0.01, tokensPerSuccess: 1000, medianMs: 10_000, known: false }) },
  { ref: 'none', metrics: NONE },
  { ref: 'zero', metrics: metrics({ judged: 5, pass: 0, s: [0, 0, 0.43], p: [0, 0, 0.49], f: [0.2, 0.04, 0.62], costPerSuccess: null, tokensPerSuccess: null, medianMs: 3_000 }) },
];

describe('the formulas', () => {
  it('accuracy is 100 x (0.7 x success + 0.3 x pass^k) x (1 - false success)', () => {
    expect(accuracyFrom(1, 1, 0)).toBe(100);
    expect(accuracyFrom(0.8, 0.5, 0.1)).toBeCloseTo(63.9, 9);
    expect(accuracyFrom(0, 0, 0)).toBe(0);
  });

  it('a lower-is-better value scores on a log scale against the best: equal 100, 2x 84.9, 4x 69.9, 10x 50, 100x and worse 0', () => {
    expect(relativeScore(5, 5, 'time')).toBe(100);
    expect(relativeScore(2, 1, 'cost')).toBe(84.9);
    expect(relativeScore(0.04, 0.01, 'cost')).toBe(69.9);
    expect(relativeScore(10, 1, 'cost')).toBe(50);
    expect(relativeScore(100, 1, 'cost')).toBe(0);
    expect(relativeScore(1000, 1, 'cost')).toBe(0);
  });

  it('no value (no pass) scores 0; a best of 0 does not divide by zero', () => {
    expect(relativeScore(null, 1, 'cost')).toBe(0);
    expect(relativeScore(0, 0, 'cost')).toBe(100);
    expect(relativeScore(1, 0, 'cost')).toBe(0);
  });

  it('grades: S 90+, A 80+, B 70+, C 60+, D below, none without a score', () => {
    expect([90, 89.9, 80, 79.9, 70, 60, 59.9, 0].map(gradeOf)).toEqual(['S', 'A', 'A', 'B', 'B', 'C', 'D', 'D']);
    expect(gradeOf(null)).toBeNull();
  });

  it('every preset weighs the four dimensions to 100; weighted() is their weighted mean', () => {
    for (const p of SCORE_PRESETS) expect(Object.values(SCORE_WEIGHTS[p]).reduce((a, b) => a + b, 0)).toBe(100);
    const sub = { accuracy: 80, cost: 50, time: 100, tokens: 40 };
    expect(weighted(sub, 'accuracy')).toBe(71);
    expect(weighted(sub, 'balanced')).toBe(67.5);
    expect(weighted(sub, 'budget')).toBe(64);
    expect(weighted(sub, 'speed')).toBe(79.5);
    expect(scoringOf()).toMatchObject({ method: 'hexactra.benchmark-score/1', defaultPreset: 'accuracy', provisionalBelow: 10 });
    expect(scoringOf().presets.map((p) => p.id)).toEqual([...SCORE_PRESETS]);
  });

  it('the accuracy band takes the low ends with the high end of false success, and the reverse', () => {
    expect(accuracyScore(POLICIES[0]!.metrics)).toEqual({ value: 87, low: 55, high: 95.8 });
    expect(accuracyScore(NONE)).toEqual({ value: null, low: null, high: null });
  });
});

describe('scorePolicies', () => {
  const [accurate, cheap, none, zero] = scorePolicies(POLICIES);

  it('sub-scores: accuracy from the rates; cost, time and tokens against the best policy; 0 without a pass', () => {
    expect(accurate).toMatchObject({ rated: true, provisional: false, accuracy: 87, cost: 69.9, time: 84.9, tokens: 69.9, costKnown: true });
    expect(cheap).toMatchObject({ rated: true, accuracy: 48.6, accuracyLow: 23.3, accuracyHigh: 71.6, cost: 100, time: 100, tokens: 100, costKnown: false });
    expect(zero).toMatchObject({ rated: true, provisional: true, accuracy: 0, cost: 0, time: 0, tokens: 0 });
    expect(none).toMatchObject({ rated: false, provisional: false, accuracy: null, cost: null, time: null, tokens: null, badges: [] });
  });

  it('accuracy first: the accurate policy wins, the cheap one is tied with it (their bands overlap)', () => {
    expect(accurate!.overall.accuracy).toEqual({ value: 80.7, low: 64.7, high: 85.1, rank: 1, grade: 'A', tied: false });
    expect(cheap!.overall.accuracy).toMatchObject({ value: 74.3, rank: 2, grade: 'B', tied: true });
    // 23.3 x 50 + 100 x 50 = 6165 / 100: 61.65, rounded half up to 61.7.
    expect(cheap!.overall.accuracy.low).toBe(61.7);
    expect(zero!.overall.accuracy).toEqual({ value: 0, low: 0, high: 21.5, rank: 3, grade: 'D', tied: false });
    expect(none!.overall.accuracy).toEqual({ value: null, low: null, high: null, rank: 4, grade: null, tied: false });
  });

  it('the order changes with the preset: budget and speed put the cheap policy first', () => {
    expect(accurate!.overall.budget).toMatchObject({ value: 77.4, rank: 2, tied: true });
    expect(cheap!.overall.budget).toMatchObject({ value: 82, rank: 1, grade: 'A' });
    expect(accurate!.overall.speed).toMatchObject({ value: 81.9, rank: 2 });
    expect(cheap!.overall.speed).toMatchObject({ value: 82, rank: 1 });
    expect(accurate!.overall.balanced.value).toBe(77.9);
    expect(cheap!.overall.balanced.value).toBeCloseTo(87.15, 1);
  });

  it('badges go to the best of each dimension; none to a policy that is not rated or scores 0', () => {
    expect(accurate!.badges).toEqual(['most_accurate']);
    expect(cheap!.badges).toEqual(['cheapest', 'fastest', 'most_token_efficient']);
    expect(zero!.badges).toEqual([]);
  });

  it('equal scores fall back to success rate, then cost per success, then time, then the configured order', () => {
    const m = POLICIES[0]!.metrics;
    const twins = scorePolicies([{ ref: 'a', metrics: m }, { ref: 'b', metrics: m }]);
    expect(twins.map((s) => s.overall.accuracy.rank)).toEqual([1, 2]);
    expect(twins[1]!.overall.accuracy.tied).toBe(true);
    expect(twins.map((s) => s.badges)).toEqual([['most_accurate', 'cheapest', 'fastest', 'most_token_efficient'], ['most_accurate', 'cheapest', 'fastest', 'most_token_efficient']]);
  });

  it('a single policy scores 100 on cost, time and tokens', () => {
    const [only] = scorePolicies([POLICIES[0]!]);
    expect(only).toMatchObject({ cost: 100, time: 100, tokens: 100 });
    expect(only!.overall.accuracy.value).toBe(93.5);
    expect(only!.overall.accuracy.grade).toBe('S');
  });
});

describe('in the scorecard', () => {
  const bench: ScoreBenchmark = {
    id: '00000000-0000-4000-8000-00000000b002',
    name: 'Score fixture',
    status: 'completed',
    suiteKey: 'core',
    suiteVersion: 2,
    appVersion: '1.0.0',
    commit: null,
    spentUsd: 0,
    config: { challengeIds: ['nav-lookup'], policies: [{ ref: 'slow', label: 'Slow' }, { ref: 'fast', label: 'Fast' }], trials: 2 },
  };
  const t = (policyRef: string, trialIndex: number, verdict: 'pass' | 'fail', activeMs: number, costUsd: number): ScoreTrial =>
    ({
      challengeId: 'nav-lookup',
      challengeTitle: 'Look up',
      category: 'navigation',
      policyRef,
      policyLabel: policyRef === 'slow' ? 'Slow' : 'Fast',
      trialIndex,
      status: 'graded',
      verdict,
      failureReason: verdict === 'pass' ? null : 'wrong_result',
      checks: [],
      claimedSuccess: verdict === 'pass',
      activeMs,
      steps: 1,
      modelCalls: 1,
      inputTokens: 1000,
      outputTokens: 100,
      cachedInputTokens: 0,
      costUsd,
      costKnown: true,
      stopReason: 'finished',
      models: null,
      questions: 0,
    }) as ScoreTrial;

  it('ranks by the default preset, carries every score and the scoring block, and parses', () => {
    // Both pass every trial; Fast is ten times faster and half the cost, so it ranks first although it is listed second.
    const card = computeScorecard(bench, [t('slow', 0, 'pass', 100_000, 0.02), t('slow', 1, 'pass', 100_000, 0.02), t('fast', 0, 'pass', 10_000, 0.01), t('fast', 1, 'pass', 10_000, 0.01)], { live: false });
    expect(card.ranking.map((r) => [r.ref, r.rank, r.grade])).toEqual([
      ['fast', 1, 'S'],
      ['slow', 2, 'A'],
    ]);
    const slow = card.policies.find((p) => p.ref === 'slow')!;
    expect(slow.score).toMatchObject({ accuracy: 100, cost: 84.9, time: 50, tokens: 100, provisional: true });
    // 100 x 50 + 84.9 x 20 + 50 x 15 + 100 x 15 = 8948 / 100.
    expect(card.ranking[1]!.score).toBe(89.5);
    expect(slow.rank).toBe(2);
    expect(card.scoring.defaultPreset).toBe('accuracy');
    expect(scorecardSchema.safeParse(card).success).toBe(true);
  });
});
