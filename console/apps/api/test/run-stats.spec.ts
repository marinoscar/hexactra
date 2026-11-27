// Run statistics (E53.1, #1069): turning the database's aggregates into the answer. The percentiles themselves are computed by
// Postgres and checked against hand-computed values in run-stats.db.spec.ts.
import { RUN_STATS_MAX_GROUPS, distributionOf, emptyRawGroup, groupStats, runStatsOf, type RawRunStatsGroup } from '../src/run-insights/run-stats';

function raw(key: string, over: { byStatus?: Partial<RawRunStatsGroup['byStatus']>; costKnown?: boolean; steps?: [number, number, number, number, number, number]; cost?: number } = {}): RawRunStatsGroup {
  const g = emptyRawGroup(key);
  Object.assign(g.byStatus, over.byStatus ?? {});
  if (over.costKnown !== undefined) g.costKnown = over.costKnown;
  if (over.steps) {
    const [n, sum, min, p50, p90, max] = over.steps;
    g.metrics.steps = { n, sum, min, p50, p90, max };
  }
  if (over.cost !== undefined) g.metrics.costUsd = { n: 1, sum: over.cost, min: over.cost, p50: over.cost, p90: over.cost, max: over.cost };
  return g;
}

describe('distributionOf', () => {
  it('is null when no finished run had a value', () => {
    expect(distributionOf({ n: 0, sum: null, min: null, p50: null, p90: null, max: null })).toBeNull();
  });

  it('computes the mean and rounds to three decimals', () => {
    expect(distributionOf({ n: 3, sum: 10, min: 1, p50: 3.33333, p90: 6, max: 6 })).toEqual({ n: 3, sum: 10, mean: 3.333, min: 1, p50: 3.333, p90: 6, max: 6 });
  });

  it('rounds cost to the micro-dollar, never a small cost to zero', () => {
    expect(distributionOf({ n: 2, sum: 0.001, min: 0.0004, p50: 0.0005, p90: 0.0006, max: 0.0006 }, true)).toEqual({ n: 2, sum: 0.001, mean: 0.0005, min: 0.0004, p50: 0.0005, p90: 0.0006, max: 0.0006 });
    expect(distributionOf({ n: 2, sum: 0.000003, min: 0.000001, p50: 0.0000015, p90: 0.000002, max: 0.000002 }, true)?.p50).toBe(0.000002);
  });
});

describe('groupStats', () => {
  it('derives runs, finished, live, the success rate and the cost per success', () => {
    const g = groupStats(raw('a', { byStatus: { succeeded: 16, failed: 3, cancelled: 1, running: 2, paused: 1 }, cost: 2.1 }));
    expect(g.runs).toBe(23);
    expect(g.finished).toBe(20);
    expect(g.live).toBe(3);
    expect(g.successRate).toBe(0.8);
    expect(g.costPerSuccessUsd).toBe(0.13125);
  });

  it('answers nulls with no finished run', () => {
    const g = groupStats(raw('a', { byStatus: { queued: 1 } }));
    expect(g.runs).toBe(1);
    expect(g.successRate).toBeNull();
    expect(g.costPerSuccessUsd).toBeNull();
    expect(g.metrics.steps).toBeNull();
  });

  it('passes the cost-known flag through', () => {
    expect(groupStats(raw('a', { costKnown: false })).costKnown).toBe(false);
  });

  it('answers an empty total for no runs', () => {
    const g = groupStats(emptyRawGroup());
    expect([g.runs, g.finished, g.live, g.successRate]).toEqual([0, 0, 0, null]);
    expect(Object.values(g.metrics).every((d) => d === null)).toBe(true);
  });
});

describe('runStatsOf', () => {
  const total = raw('', { byStatus: { succeeded: 20 } });

  it('answers the total only for groupBy none', () => {
    const s = runStatsOf({ total, groups: [raw('')], groupBy: 'none', timeZone: 'UTC', scanned: 20, truncated: false });
    expect(s.groups).toEqual([]);
    expect(s.total.runs).toBe(20);
    expect(s.groupsTruncated).toBe(false);
  });

  it('orders groups largest first, then by key, and labels them', () => {
    const groups = [raw('b', { byStatus: { succeeded: 3 } }), raw('c', { byStatus: { succeeded: 17 } }), raw('a', { byStatus: { succeeded: 3 } })];
    const s = runStatsOf({ total, groups, groupBy: 'task', timeZone: 'UTC', scanned: 23, truncated: false, label: (k) => (k === 'c' ? 'Check fares' : undefined) });
    expect(s.groups.map((g) => [g.key, g.label, g.runs])).toEqual([
      ['c', 'Check fares', 17],
      ['a', 'a', 3],
      ['b', 'b', 3],
    ]);
  });

  it('orders periods oldest first', () => {
    const groups = ['2026-06-03', '2026-06-01', '2026-06-02'].map((k) => raw(k, { byStatus: { succeeded: 1 } }));
    const s = runStatsOf({ total, groups, groupBy: 'day', timeZone: 'UTC', scanned: 3, truncated: false });
    expect(s.groups.map((g) => g.key)).toEqual(['2026-06-01', '2026-06-02', '2026-06-03']);
  });

  it(`keeps the latest ${RUN_STATS_MAX_GROUPS} periods and the largest ${RUN_STATS_MAX_GROUPS} groups`, () => {
    const days = Array.from({ length: RUN_STATS_MAX_GROUPS + 5 }, (_, i) => raw(new Date(Date.UTC(2025, 0, 1) + i * 86_400_000).toISOString().slice(0, 10), { byStatus: { succeeded: 1 } }));
    const byDay = runStatsOf({ total, groups: days, groupBy: 'day', timeZone: 'UTC', scanned: days.length, truncated: true });
    expect(byDay.groups).toHaveLength(RUN_STATS_MAX_GROUPS);
    expect(byDay.groupsTruncated).toBe(true);
    expect(byDay.truncated).toBe(true);
    expect(byDay.groups.at(-1)?.key).toBe(days.at(-1)?.key);
    const tasks = Array.from({ length: RUN_STATS_MAX_GROUPS + 5 }, (_, i) => raw(`t${String(i).padStart(4, '0')}`, { byStatus: { succeeded: i + 1 } }));
    const byTask = runStatsOf({ total, groups: tasks, groupBy: 'task', timeZone: 'UTC', scanned: 1, truncated: false });
    expect(byTask.groups).toHaveLength(RUN_STATS_MAX_GROUPS);
    expect(byTask.groups[0]?.runs).toBe(RUN_STATS_MAX_GROUPS + 5);
  });
});
