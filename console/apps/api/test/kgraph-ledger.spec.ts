// E46.6 (#780), without a database: the savings ledger's outcome, baseline (median of the newest ≤ 10 AI-only runs) and summary.
import { BASELINE_RUNS, baselineOf, ledgerOutcome, median, modelCallsSaved, NO_BASELINE_YET, summarize, type LedgerRunFigures, type RunFigures } from '../src/kgraph/ledger';
import { KgraphMetrics } from '../src/kgraph/kgraph-metrics';

const day = (n: number) => new Date(Date.UTC(2026, 10, 1 + n));
const run = (n: number, modelCalls: number, costUsd = modelCalls / 100, activeMs = modelCalls * 1000, costKnown = true): RunFigures => ({ modelCalls, costUsd, costKnown, activeMs, finishedAt: day(n) });
const counts = (o: Partial<{ replayed: number; recovered: number; judge: number; agent: number }> = {}) => ({ replayed: 0, recovered: 0, judge: 0, agent: 0, ...o });

describe('median', () => {
  it('is null for none, the middle for an odd count, the mean of the middle two for an even count', () => {
    expect(median([])).toBeNull();
    expect(median([7])).toBe(7);
    expect(median([9, 1, 5])).toBe(5);
    expect(median([4, 1, 3, 2])).toBe(2.5);
  });
});

describe('ledgerOutcome', () => {
  it('is ai_only without a procedure version (a learn run)', () => {
    expect(ledgerOutcome({ procedureVersionId: null, counts: counts({ agent: 12 }) })).toBe('ai_only');
  });
  it('classifies a run that executed a version', () => {
    expect(ledgerOutcome({ procedureVersionId: 'v1', counts: counts({ replayed: 5 }) })).toBe('replayed_clean');
    expect(ledgerOutcome({ procedureVersionId: 'v1', counts: counts({ replayed: 4, recovered: 1 }) })).toBe('recovered');
    expect(ledgerOutcome({ procedureVersionId: 'v1', counts: counts({ replayed: 2, agent: 3 }) })).toBe('fell_back');
    expect(ledgerOutcome({ procedureVersionId: 'v1', counts: counts({ replayed: 2, agent: 3 }), repaired: true })).toBe('repaired');
  });
});

describe('baselineOf', () => {
  it('is null with no AI-only run', () => {
    expect(baselineOf([])).toBeNull();
  });
  it('is the median of several, over the newest 10 only', () => {
    expect(baselineOf([run(1, 10), run(2, 30), run(3, 20)])).toEqual({ runs: 3, modelCalls: 20, costUsd: 0.2, costKnown: true, activeMs: 20_000 });
    // Twelve runs: the two oldest (huge) are left out.
    const many = [run(0, 1000), run(1, 1000), ...Array.from({ length: 10 }, (_, i) => run(10 + i, 10 + i))];
    const b = baselineOf(many)!;
    expect(b.runs).toBe(BASELINE_RUNS);
    expect(b.modelCalls).toBe(14.5);
  });
  it('carries a lower-bound cost', () => {
    expect(baselineOf([run(1, 10), run(2, 10, 0.1, 1000, false)])!.costKnown).toBe(false);
  });
});

describe('summarize', () => {
  const rows = (...r: [LedgerRunFigures['outcome'], number][]): LedgerRunFigures[] => r.map(([outcome, calls], i) => ({ ...run(i, calls), outcome }));

  it('never shows a saving without a baseline: it says "no baseline yet"', () => {
    const s = summarize(rows(['replayed_clean', 2], ['replayed_clean', 3]), null);
    expect(s.baseline).toBeNull();
    expect(s.note).toBe(NO_BASELINE_YET);
    expect(s.saving).toBeNull();
    expect(s.cleanReplayRate).toBe(1);
  });

  it('shows no saving with only AI-only runs (nothing executed a procedure)', () => {
    const s = summarize(rows(['ai_only', 20], ['ai_only', 22]), baselineOf([run(1, 20), run(2, 22)]));
    expect(s).toMatchObject({ runs: 2, procedureRuns: 0, cleanReplayRate: null, note: null, procedureFigures: null, saving: null });
  });

  it('is the baseline minus the procedure runs, with the clean-replay rate', () => {
    const baseline = baselineOf([run(1, 20), run(2, 20)]);
    const s = summarize(rows(['ai_only', 20], ['replayed_clean', 2], ['replayed_clean', 4], ['fell_back', 15], ['replayed_clean', 3]), baseline);
    expect(s.procedureRuns).toBe(4);
    expect(s.cleanReplayRate).toBe(0.75);
    expect(s.procedureFigures!.modelCalls).toBe(3.5);
    expect(s.saving).toEqual({ modelCalls: 16.5, costUsd: 0.165, costKnown: true, activeMs: 16_500 });
  });
});

describe('modelCallsSaved and the metrics', () => {
  it('counts only a procedure run against a baseline', () => {
    const b = baselineOf([run(1, 20)]);
    expect(modelCallsSaved('replayed_clean', 3, b)).toBe(17);
    expect(modelCallsSaved('ai_only', 3, b)).toBe(0);
    expect(modelCallsSaved('replayed_clean', 3, null)).toBe(0);
    expect(modelCallsSaved('fell_back', 30, b)).toBe(0);
  });
  it('records app.kgraph.runs and app.kgraph.model_calls_saved with bounded labels', () => {
    const add = jest.fn();
    const m = new KgraphMetrics({ add } as never);
    m.run('learn', 'ai_only');
    m.modelCallsSaved(0);
    m.modelCallsSaved(4);
    expect(add.mock.calls).toEqual([
      ['kgraphRuns', 1, { mode: 'learn', outcome: 'ai_only' }],
      ['kgraphModelCallsSaved', 4],
    ]);
  });
});
