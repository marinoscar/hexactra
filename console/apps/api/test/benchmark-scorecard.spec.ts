// The scorecard's formulas (E44.4, #742), without a database. Every expected number below was worked out by hand from the trials in
// this file; the Wilson bounds were computed independently (the closed form with z = 1.959963984540054, in Python) and are checked to
// three decimals.
import { compareScorecards, computeScorecard, deltaOf, median, metricsOf, outcomeOf, overlaps, percentile, rankPolicies, servedModels, wilson, type ScoreBenchmark, type ScoreTrial } from '../src/benchmark/scorecard';
import { SCORECARD_FORMAT, SCORECARD_VERSION, benchmarkComparisonSchema, scorecardSchema } from '../src/benchmark/scorecard.schemas';
import { readSummary } from '../src/benchmark/scorecard.service';

const A = 'builtin:economy';
const B = 'builtin:balanced';
const models = (model: string, extra?: { tier: 'advanced'; model: string; final?: boolean }): ScoreTrial['models'] => ({
  startTier: 'standard',
  maxTier: extra ? 'advanced' : 'standard',
  finalTier: extra?.final ? 'advanced' : 'standard',
  model,
  tiers: [{ tier: 'standard', model, fallbackModel: null }, ...(extra ? [{ tier: extra.tier, model: extra.model, fallbackModel: null }] : [])],
});

const NO_METRICS = { activeMs: null, steps: null, modelCalls: null, inputTokens: null, outputTokens: null, cachedInputTokens: null, costUsd: null, costKnown: null, stopReason: null, models: null, checks: null, claimedSuccess: null };

function trial(challengeId: 'nav-lookup' | 'form-multistep', policyRef: string, trialIndex: number, v: Partial<ScoreTrial>): ScoreTrial {
  const verdict = v.verdict ?? 'pass';
  const ranIt = verdict === 'pass' || verdict === 'fail' || verdict === 'error';
  return {
    challengeId,
    challengeTitle: challengeId === 'nav-lookup' ? 'Look up' : 'Multi-step form',
    category: challengeId === 'nav-lookup' ? 'navigation' : 'forms',
    policyRef,
    policyLabel: policyRef === A ? 'Economy' : 'Balanced',
    trialIndex,
    status: ranIt ? 'graded' : 'skipped',
    verdict,
    failureReason: verdict === 'pass' ? null : 'wrong_result',
    ...(ranIt ? { checks: [{ name: 'graded', pass: verdict === 'pass' }], claimedSuccess: verdict === 'pass', stopReason: 'finished', costKnown: true, models: models(`p:${policyRef === A ? 'a' : 'b'}`), cachedInputTokens: 0 } : NO_METRICS),
    ...v,
  } as ScoreTrial;
}

// Policy A (Economy): nav-lookup passes 3 of 3; form-multistep fails (a false success with a failed safety check), passes (a false
// failure) and errors.
const aTrials: ScoreTrial[] = [
  trial('nav-lookup', A, 0, { activeMs: 10_000, steps: 4, modelCalls: 3, inputTokens: 1000, outputTokens: 100, cachedInputTokens: 400, costUsd: 0.01 }),
  trial('nav-lookup', A, 1, { activeMs: 20_000, steps: 6, modelCalls: 5, inputTokens: 2000, outputTokens: 200, cachedInputTokens: 800, costUsd: 0.02 }),
  trial('nav-lookup', A, 2, { activeMs: 30_000, steps: 8, modelCalls: 7, inputTokens: 3000, outputTokens: 300, cachedInputTokens: 1200, costUsd: 0.03 }),
  trial('form-multistep', A, 0, { verdict: 'fail', claimedSuccess: true, activeMs: 40_000, steps: 10, modelCalls: 9, inputTokens: 4000, outputTokens: 400, costUsd: 0.04, checks: [{ name: 'safety:no-order-placed', pass: false }, { name: 'total', pass: false }] }),
  trial('form-multistep', A, 1, { claimedSuccess: false, activeMs: 50_000, steps: 12, modelCalls: 11, inputTokens: 5000, outputTokens: 500, costUsd: 0.05 }),
  trial('form-multistep', A, 2, { verdict: 'error', failureReason: 'error', stopReason: 'error', activeMs: 5_000, steps: 1, modelCalls: 1, inputTokens: 500, outputTokens: 50, costUsd: 0.005 }),
];
// Policy B (Balanced): one trial ran (a fail that gave up, with an unpriced call, escalated to a second model); the rest hit the cap.
const bTrials: ScoreTrial[] = [
  trial('nav-lookup', B, 0, { verdict: 'fail', failureReason: 'gave_up', claimedSuccess: false, activeMs: 15_000, steps: 5, modelCalls: 2, inputTokens: 2000, outputTokens: 100, costUsd: 0.02, costKnown: false, models: models('p:b1', { tier: 'advanced', model: 'p:b2', final: true }) }),
  ...[1, 2].map((i) => trial('nav-lookup', B, i, { verdict: 'skipped', failureReason: 'cap' })),
  ...[0, 1, 2].map((i) => trial('form-multistep', B, i, { verdict: 'skipped', failureReason: 'cap' })),
];

const bench: ScoreBenchmark = {
  id: '00000000-0000-4000-8000-00000000b001',
  name: 'Fixture',
  status: 'completed',
  suiteKey: 'core',
  suiteVersion: 1,
  appVersion: '1.0.0',
  commit: 'abc',
  spentUsd: 0.175,
  config: { challengeIds: ['nav-lookup', 'form-multistep'], policies: [{ ref: A, label: 'Economy' }, { ref: B, label: 'Balanced' }], trials: 3 },
};
const NOW = new Date('2026-11-01T00:00:00Z');

const to3 = (v: number | null) => (v === null ? null : Math.round(v * 1000) / 1000);

describe('wilson', () => {
  it.each([
    [0, 3, 0, 0.561],
    [1, 1, 0.207, 1],
    [2, 3, 0.208, 0.939],
    [7, 10, 0.397, 0.892],
    [10, 12, 0.552, 0.953],
    [3, 3, 0.439, 1],
    [0, 1, 0, 0.793],
    [5, 6, 0.436, 0.97],
    [4, 5, 0.376, 0.964],
    [1, 5, 0.036, 0.624],
  ])('%i of %i: [%f, %f]', (k, n, low, high) => {
    const r = wilson(k, n);
    expect([to3(r.low), to3(r.high)]).toEqual([low, high]);
    expect(r.value).toBeCloseTo(k / n, 12);
  });

  it('has no value and no interval for nothing counted', () => {
    expect(wilson(0, 0)).toEqual({ k: 0, n: 0, value: null, low: null, high: null });
  });
});

describe('median and percentile', () => {
  it('takes the middle value, or the mean of the two middle ones', () => {
    expect(median([])).toBeNull();
    expect(median([7])).toBe(7);
    expect(median([3, 1, 2])).toBe(2);
    expect(median([4, 1, 3, 2])).toBe(2.5);
  });
  it('takes the p90 by nearest rank', () => {
    expect(percentile([], 0.9)).toBeNull();
    expect(percentile([5], 0.9)).toBe(5);
    expect(percentile([1, 2, 3, 4, 5], 0.9)).toBe(5);
    expect(percentile([1, 2, 3, 4, 5, 6, 7, 8, 9, 10], 0.9)).toBe(9);
    expect(percentile([10, 1, 2, 3, 4, 5, 6, 7, 8, 9, 11], 0.9)).toBe(10);
  });
});

describe('metricsOf, one policy', () => {
  const m = metricsOf(aTrials, 3);

  it('counts the verdicts and leaves error, skipped and unsupported out of the rates', () => {
    expect(m.counts).toEqual({ total: 6, judged: 5, pass: 4, fail: 1, error: 1, skipped: 0, unsupported: 0, unfinished: 0 });
    expect(m.successRate).toMatchObject({ k: 4, n: 5, value: 0.8 });
    expect([to3(m.successRate.low), to3(m.successRate.high)]).toEqual([0.376, 0.964]);
  });

  it('reliability is the share of challenges where all k trials passed', () => {
    expect(m.passAllK).toMatchObject({ k: 3, challenges: 2, allPassed: 1, rate: { k: 1, n: 2, value: 0.5 } });
  });

  it('false success and false failure over judged trials', () => {
    expect(m.falseSuccess).toMatchObject({ k: 1, n: 5, value: 0.2 });
    expect(m.falseFailure).toMatchObject({ k: 1, n: 5, value: 0.2 });
  });

  it('speed over judged trials: median and p90 active time, median steps and model calls', () => {
    expect(m.speed).toEqual({ medianActiveMs: 30_000, p90ActiveMs: 50_000, medianSteps: 8, medianModelCalls: 7 });
  });

  it('cost: the total of every trial that ran (the error too), the median of a judged trial and the cost per success', () => {
    // 0.01 + 0.02 + 0.03 + 0.04 + 0.05 + 0.005 = 0.155; / 4 passes = 0.03875.
    expect(m.cost).toEqual({ totalUsd: 0.155, known: true, medianPerTrialUsd: 0.03, perSuccessUsd: 0.03875 });
  });

  it('tokens: totals of every trial that ran, medians of the judged trials, tokens per success', () => {
    // input 1000+2000+3000+4000+5000+500 = 15500; output 1550; cached 400+800+1200 = 2400; (15500+1550)/4 = 4262.5.
    expect(m.tokens).toEqual({ input: 15_500, output: 1_550, cached: 2_400, total: 17_050, medianInput: 3000, medianOutput: 300, medianCached: 400, perSuccess: 4262.5 });
  });

  it('failure and stop reasons, most first; safety flags apart from the rate; the models', () => {
    expect(m.failureReasons).toEqual([{ key: 'error', count: 1 }, { key: 'wrong_result', count: 1 }]);
    expect(m.stopReasons).toEqual([{ key: 'finished', count: 5 }, { key: 'error', count: 1 }]);
    expect(m.safety).toEqual({ flaggedTrials: 1, checks: [{ key: 'safety:no-order-placed', count: 1 }] });
    expect(m.models).toEqual(['p:a']);
  });
});

describe('metricsOf, the edges', () => {
  it('one trial, zero passes, unknown cost: no cost per success, the cost is "at least"', () => {
    const m = metricsOf(bTrials, 3);
    expect(m.counts).toEqual({ total: 6, judged: 1, pass: 0, fail: 1, error: 0, skipped: 5, unsupported: 0, unfinished: 0 });
    expect(m.successRate).toMatchObject({ k: 0, n: 1, value: 0, low: 0 });
    expect(to3(m.successRate.high)).toBe(0.793);
    expect(m.passAllK).toMatchObject({ challenges: 1, allPassed: 0 });
    expect(m.cost).toEqual({ totalUsd: 0.02, known: false, medianPerTrialUsd: 0.02, perSuccessUsd: null });
    expect(m.tokens).toMatchObject({ input: 2000, output: 100, total: 2100, perSuccess: null });
    expect(m.failureReasons).toEqual([{ key: 'cap', count: 5 }, { key: 'gave_up', count: 1 }]);
    // The run escalated: both tiers it used served it.
    expect(m.models).toEqual(['p:b1', 'p:b2']);
  });

  it('no trial at all: empty, never an error', () => {
    const m = metricsOf([], 3);
    expect(m.successRate.value).toBeNull();
    expect(m.passAllK.rate.value).toBeNull();
    expect(m.speed.medianActiveMs).toBeNull();
    expect(m.cost).toEqual({ totalUsd: 0, known: true, medianPerTrialUsd: null, perSuccessUsd: null });
    expect(m.tokens.perSuccess).toBeNull();
  });

  it('a skipped trial stopped part way still counts in the cost and tokens, never in the rates', () => {
    const stopped = trial('nav-lookup', A, 0, { verdict: 'skipped', failureReason: 'cancelled', costUsd: 0.03, costKnown: true, inputTokens: 900, outputTokens: 90, cachedInputTokens: 0, modelCalls: 2, stopReason: 'cancelled' });
    const m = metricsOf([stopped], 3);
    expect(m.counts.judged).toBe(0);
    expect(m.cost.totalUsd).toBe(0.03);
    expect(m.tokens.total).toBe(990);
    expect(m.stopReasons).toEqual([{ key: 'cancelled', count: 1 }]);
  });

  it('a challenge with fewer than k judged trials is not "all passed"', () => {
    const m = metricsOf(aTrials.filter((t) => t.challengeId === 'form-multistep' && t.verdict === 'pass'), 3);
    expect(m.passAllK).toMatchObject({ challenges: 1, allPassed: 0 });
  });

  it('servedModels stops at the tier the run ended on', () => {
    expect(servedModels({ models: models('p:x', { tier: 'advanced', model: 'p:y' }) })).toEqual(['p:x']);
    expect(servedModels({ models: null })).toEqual([]);
  });
});

describe('computeScorecard', () => {
  const card = computeScorecard(bench, [...aTrials, ...bTrials], { live: false, now: NOW });

  it('is a valid scorecard of the current format', () => {
    expect(scorecardSchema.parse(card)).toEqual(card);
    expect(card).toMatchObject({ format: SCORECARD_FORMAT, version: SCORECARD_VERSION, live: false, k: 3, computedAt: NOW.toISOString(), suiteKey: 'core', suiteVersion: 1 });
    expect(readSummary(JSON.parse(JSON.stringify(card)))).toEqual(card);
    expect(readSummary({ ...card, version: SCORECARD_VERSION + 1 })).toBeNull();
    expect(readSummary(null)).toBeNull();
  });

  it('totals of the whole benchmark: the spend, every token, "at least" when any cost is unknown', () => {
    expect(card.totals).toEqual({
      costUsd: 0.175,
      costKnown: false,
      inputTokens: 17_500,
      outputTokens: 1_650,
      cachedInputTokens: 2_400,
      totalTokens: 19_150,
      modelCalls: 38,
      counts: { total: 12, judged: 6, pass: 4, fail: 2, error: 1, skipped: 5, unsupported: 0, unfinished: 0 },
    });
  });

  it('policy columns in the configured order with their rank; the ranking best first', () => {
    expect(card.policies.map((p) => [p.ref, p.rank])).toEqual([[A, 1], [B, 2]]);
    expect(card.ranking).toEqual([
      { rank: 1, ref: A, label: 'Economy', successRate: 0.8, costPerSuccessUsd: 0.03875, costKnown: true, medianActiveMs: 30_000, totalCostUsd: 0.155, totalTokens: 17_050 },
      { rank: 2, ref: B, label: 'Balanced', successRate: 0, costPerSuccessUsd: null, costKnown: false, medianActiveMs: 15_000, totalCostUsd: 0.02, totalTokens: 2_100 },
    ]);
  });

  it('per policy and category: rate, total cost and tokens', () => {
    const a = card.policies[0]!;
    expect(card.categories).toEqual([{ id: 'navigation', label: 'Navigation' }, { id: 'forms', label: 'Forms' }]);
    const [nav, forms] = a.categories;
    expect(nav).toMatchObject({ category: 'navigation', metrics: { successRate: { k: 3, n: 3 }, cost: { totalUsd: 0.06, known: true, perSuccessUsd: 0.02 }, tokens: { input: 6000, output: 600, cached: 2400, total: 6600, perSuccess: 2200 } } });
    // forms: 0.04 + 0.05 + 0.005 = 0.095 over one pass; tokens 4000+5000+500 + 400+500+50 = 10450.
    expect(forms).toMatchObject({ category: 'forms', metrics: { successRate: { k: 1, n: 2, value: 0.5 }, cost: { totalUsd: 0.095, perSuccessUsd: 0.095 }, tokens: { total: 10_450, perSuccess: 10_450 }, safety: { flaggedTrials: 1 } } });
    const bForms = card.policies[1]!.categories[1]!;
    expect(bForms.metrics).toMatchObject({ counts: { judged: 0, skipped: 3 }, successRate: { value: null }, cost: { totalUsd: 0, known: true } });
    expect(card.policies[1]!.categories[0]!.metrics.cost).toEqual({ totalUsd: 0.02, known: false, medianPerTrialUsd: 0.02, perSuccessUsd: null });
  });

  it('the challenge x policy matrix: passes of k, median time and cost, total tokens, each attempt', () => {
    expect(card.matrix.map((r) => [r.challengeId, r.category, r.cells.map((c) => [c.policyRef, c.passes, c.judged, c.k, c.verdicts, c.medianActiveMs, c.medianCostUsd, c.costKnown, c.totalTokens, c.safetyFlagged])])).toEqual([
      ['nav-lookup', 'navigation', [[A, 3, 3, 3, ['pass', 'pass', 'pass'], 20_000, 0.02, true, 6600, false], [B, 0, 1, 3, ['fail', 'skipped', 'skipped'], 15_000, 0.02, false, 2100, false]]],
      ['form-multistep', 'forms', [[A, 1, 2, 3, ['fail', 'pass', 'error'], 45_000, 0.045, true, 10_450, true], [B, 0, 0, 3, ['skipped', 'skipped', 'skipped'], null, null, true, 0, false]]],
    ]);
  });

  it('a benchmark with no judged trial has an empty scorecard', () => {
    const empty = computeScorecard({ ...bench, spentUsd: 0 }, [], { live: true, now: NOW });
    expect(scorecardSchema.parse(empty)).toEqual(empty);
    expect(empty.live).toBe(true);
    expect(empty.totals).toMatchObject({ costUsd: 0, costKnown: true, totalTokens: 0 });
    expect(empty.policies.map((p) => p.metrics.successRate.value)).toEqual([null, null]);
    expect(empty.ranking.map((r) => r.ref)).toEqual([A, B]);
    expect(empty.categories).toEqual([]);
    expect(empty.matrix.map((r) => r.cells.map((c) => c.verdicts))).toEqual([[[null, null, null], [null, null, null]], [[null, null, null], [null, null, null]]]);
  });

  it('a trial still running counts as unfinished', () => {
    const live = computeScorecard(bench, [{ ...aTrials[0]!, status: 'running', verdict: null }], { live: true, now: NOW });
    expect(live.totals.counts).toMatchObject({ total: 1, unfinished: 1, judged: 0 });
  });
});

describe('rankPolicies', () => {
  const card = computeScorecard(bench, [...aTrials, ...bTrials], { live: false, now: NOW });
  const base = card.policies[0]!.metrics;
  const p = (ref: string, rate: number | null, perSuccess: number | null, active: number | null) => ({ ref, metrics: { ...base, successRate: { ...base.successRate, value: rate }, cost: { ...base.cost, perSuccessUsd: perSuccess }, speed: { ...base.speed, medianActiveMs: active } } });

  it('success rate, then cost per success, then median active time, then the configured order; nulls last', () => {
    const ranked = rankPolicies([p('none', null, null, null), p('slow', 0.8, 0.02, 9000), p('fast', 0.8, 0.02, 1000), p('dear', 0.8, 0.05, 10), p('best', 0.9, 1, 1), p('free', 0.8, null, 1), p('tie', 0.8, 0.02, 1000)]);
    expect(ranked.map((x) => x.ref)).toEqual(['best', 'fast', 'tie', 'slow', 'dear', 'free', 'none']);
  });
});

describe('compare', () => {
  const side = (id: string) => ({ id, name: id, status: 'completed' as const, suiteKey: 'core', suiteVersion: 1, appVersion: `v-${id}`, commit: `c-${id}`, finishedAt: null });

  // The baseline: Economy failed nav-lookup every time; its Balanced policy had another ref but the same label.
  const baseTrials = [
    ...aTrials.map((t) => (t.challengeId === 'nav-lookup' ? { ...t, verdict: 'fail' as const, failureReason: 'wrong_result' as const, claimedSuccess: true } : t)),
    ...bTrials.map((t) => ({ ...t, policyRef: 'user-balanced-1' })),
  ];
  const baseline = computeScorecard({ ...bench, id: 'base', spentUsd: 0.2, config: { ...bench.config, policies: [{ ref: A, label: 'Economy' }, { ref: 'user-balanced-1', label: 'Balanced' }] } }, baseTrials, { live: false, now: NOW });
  const current = computeScorecard(bench, [...aTrials, ...bTrials], { live: false, now: NOW });
  const cmp = compareScorecards(current, baseline, { current: side('cur'), baseline: side('base') });

  it('is a valid comparison with both versions and commits', () => {
    expect(benchmarkComparisonSchema.parse(cmp)).toEqual(cmp);
    expect([cmp.current.appVersion, cmp.current.commit, cmp.baseline.appVersion, cmp.baseline.commit]).toEqual(['v-cur', 'c-cur', 'v-base', 'c-base']);
  });

  it('matches policies by ref, then by label', () => {
    expect(cmp.policies.map((p) => [p.ref, p.baselineRef, p.matchedBy])).toEqual([[A, A, 'ref'], [B, 'user-balanced-1', 'label']]);
    expect(cmp.unmatched).toEqual({ current: [], baseline: [] });
  });

  it('reports the challenges that flipped', () => {
    expect(cmp.flipped).toEqual([{ challengeId: 'nav-lookup', title: 'Look up', category: 'navigation', policyRef: A, policyLabel: 'Economy', baseline: { outcome: 'fail', passes: 0, judged: 3 }, current: { outcome: 'pass', passes: 3, judged: 3 }, direction: 'better' }]);
  });

  it('deltas per metric, with withinNoise when the intervals overlap, and "at least" on a cost', () => {
    const economy = Object.fromEntries(cmp.policies[0]!.deltas.map((d) => [d.metric, d]));
    // 4/5 against 1/5: [0.376, 0.964] and [0.036, 0.624] overlap.
    expect(economy.successRate).toMatchObject({ current: 0.8, baseline: 0.2, delta: 0.6, better: 'higher', withinNoise: true, improved: null });
    expect(economy.falseSuccessRate).toMatchObject({ current: 0.2, baseline: 0.8, delta: -0.6, withinNoise: true });
    // 0.155 / 4 against 0.155 / 1.
    expect(economy.costPerSuccessUsd).toMatchObject({ current: 0.03875, baseline: 0.155, delta: -0.11625, improved: true, withinNoise: null, atLeast: false });
    expect(economy.totalTokens).toMatchObject({ delta: 0, improved: null });
    expect(economy.tokensPerSuccess).toMatchObject({ current: 4262.5, baseline: 17_050, delta: -12_787.5, improved: true });
    const balanced = Object.fromEntries(cmp.policies[1]!.deltas.map((d) => [d.metric, d]));
    expect(balanced.totalCostUsd).toMatchObject({ delta: 0, atLeast: true });
    expect(balanced.costPerSuccessUsd).toMatchObject({ current: null, baseline: null, delta: null, improved: null });
    expect(cmp.totals).toEqual([
      { metric: 'totalCostUsd', current: 0.175, baseline: 0.2, delta: -0.025, better: 'lower', improved: true, withinNoise: null, atLeast: true },
      { metric: 'totalTokens', current: 19_150, baseline: 19_150, delta: 0, better: 'lower', improved: null, withinNoise: null, atLeast: false },
      { metric: 'inputTokens', current: 17_500, baseline: 17_500, delta: 0, better: 'lower', improved: null, withinNoise: null, atLeast: false },
      { metric: 'outputTokens', current: 1_650, baseline: 1_650, delta: 0, better: 'lower', improved: null, withinNoise: null, atLeast: false },
      { metric: 'cachedInputTokens', current: 2_400, baseline: 2_400, delta: 0, better: 'lower', improved: null, withinNoise: null, atLeast: false },
    ]);
  });

  it('the input, output and cached input token deltas, for the whole benchmark and per policy (#829)', () => {
    // A heavier baseline: Economy's trials used twice the input, 50 more output each and no cached input; Balanced is the same.
    const heavy = [...aTrials.map((t) => ({ ...t, inputTokens: t.inputTokens! * 2, outputTokens: t.outputTokens! + 50, cachedInputTokens: 0 })), ...bTrials];
    const base = computeScorecard(bench, heavy, { live: false, now: NOW });
    const c = compareScorecards(current, base, { current: side('cur'), baseline: side('base') });
    expect(benchmarkComparisonSchema.parse(c)).toEqual(c);
    const economy = Object.fromEntries(c.policies[0]!.deltas.map((d) => [d.metric, d]));
    // Economy now: input 15,500, output 1,550, cached 2,400 (17,050 tokens, 4 passes). Baseline: input 31,000, output 1,550 + 6 x 50 =
    // 1,850, cached 0 (32,850 tokens, 4 passes: 8,212.5 per success).
    expect(economy.inputTokens).toEqual({ metric: 'inputTokens', current: 15_500, baseline: 31_000, delta: -15_500, better: 'lower', improved: true, withinNoise: null, atLeast: false });
    expect(economy.outputTokens).toEqual({ metric: 'outputTokens', current: 1_550, baseline: 1_850, delta: -300, better: 'lower', improved: true, withinNoise: null, atLeast: false });
    expect(economy.cachedInputTokens).toEqual({ metric: 'cachedInputTokens', current: 2_400, baseline: 0, delta: 2_400, better: 'lower', improved: false, withinNoise: null, atLeast: false });
    expect(economy.totalTokens).toMatchObject({ current: 17_050, baseline: 32_850, delta: -15_800, improved: true });
    expect(economy.tokensPerSuccess).toMatchObject({ current: 4262.5, baseline: 8212.5, delta: -3950, improved: true });
    const balanced = Object.fromEntries(c.policies[1]!.deltas.map((d) => [d.metric, d]));
    expect([balanced.inputTokens!.delta, balanced.outputTokens!.delta, balanced.cachedInputTokens!.delta]).toEqual([0, 0, 0]);
    // The whole benchmark: Balanced adds 2,000 input and 100 output to each side.
    const totals = Object.fromEntries(c.totals.map((d) => [d.metric, [d.current, d.baseline, d.delta]]));
    expect(totals).toEqual({
      totalCostUsd: [0.175, 0.175, 0],
      totalTokens: [19_150, 34_950, -15_800],
      inputTokens: [17_500, 33_000, -15_500],
      outputTokens: [1_650, 1_950, -300],
      cachedInputTokens: [2_400, 0, 2_400],
    });
  });

  it('a rate whose intervals do not overlap is a real change', () => {
    const d = deltaOf('successRate', 1, 0, { rates: [wilson(20, 20), wilson(0, 20)] });
    expect(d).toMatchObject({ delta: 1, withinNoise: false, improved: true });
    expect(overlaps(wilson(0, 0), wilson(1, 1))).toBeNull();
  });

  it('an outcome is all passed, none passed or mixed', () => {
    expect([outcomeOf({ passes: 0, judged: 0 }), outcomeOf({ passes: 2, judged: 2 }), outcomeOf({ passes: 0, judged: 2 }), outcomeOf({ passes: 1, judged: 2 })]).toEqual([null, 'pass', 'fail', 'mixed']);
  });

  it('a policy on one side only is listed as unmatched', () => {
    const only = computeScorecard({ ...bench, config: { ...bench.config, policies: [{ ref: 'other', label: 'Other' }] } }, [], { live: false, now: NOW });
    const c = compareScorecards(only, baseline, { current: side('cur'), baseline: side('base') });
    expect(c.policies).toEqual([]);
    expect(c.unmatched).toEqual({ current: [{ ref: 'other', label: 'Other' }], baseline: [{ ref: A, label: 'Economy' }, { ref: 'user-balanced-1', label: 'Balanced' }] });
    expect(c.flipped).toEqual([]);
  });
});
