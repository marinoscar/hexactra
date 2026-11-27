// How consistent a task's runs are (E52.7, #1022): the spread maths and every label boundary.
import { CONSISTENCY, consistencyOf, labelOf, spreadOf, type ConsistencyRun } from '../src/run-insights/task-consistency';

const at = new Date('2026-11-26T22:00:00Z');
const run = (i: number, steps: number, status = 'succeeded', costKnown = true): ConsistencyRun => ({ runId: `00000000-0000-4000-8000-${String(i).padStart(12, '0')}`, status, createdAt: new Date(at.getTime() - i * 60_000), stepCount: steps, modelCalls: steps, activeMs: steps * 1000, costUsd: steps / 1000, costKnown });

describe('spreadOf', () => {
  it('an odd list, an even list, one value, an empty list and a zero median', () => {
    expect(spreadOf([33, 124, 35])).toEqual({ min: 33, median: 35, p90: 124, max: 124, ratio: 3.543 });
    expect(spreadOf([10, 20, 30, 40])).toEqual({ min: 10, median: 25, p90: 40, max: 40, ratio: 1.6 });
    expect(spreadOf([7])).toEqual({ min: 7, median: 7, p90: 7, max: 7, ratio: 1 });
    expect(spreadOf([])).toBeNull();
    expect(spreadOf([0, 0, 5])).toMatchObject({ median: 0, ratio: 1 });
  });

  it('the 90th percentile by nearest rank', () => {
    expect(spreadOf(Array.from({ length: 20 }, (_, i) => i + 1))!.p90).toBe(18);
  });
});

describe('labelOf', () => {
  const s = (ratio: number) => ({ min: 1, median: 10, p90: 10, max: 10 * ratio, ratio });
  it('needs 3 runs', () => {
    expect(labelOf(2, s(1), 1)).toBe('not_enough_runs');
    expect(labelOf(3, null, 1)).toBe('not_enough_runs');
  });
  it('steady at a ratio of 1.5 and 90% success, not above either boundary', () => {
    expect(labelOf(3, s(CONSISTENCY.steadyRatio), CONSISTENCY.steadySuccess)).toBe('steady');
    expect(labelOf(3, s(1.51), 1)).toBe('varies');
    expect(labelOf(3, s(1), 0.89)).toBe('varies');
  });
  it('erratic above a ratio of 3 or under 60% success', () => {
    expect(labelOf(3, s(3), 1)).toBe('varies');
    expect(labelOf(3, s(3.01), 1)).toBe('erratic');
    expect(labelOf(3, s(1), 0.59)).toBe('erratic');
    expect(labelOf(3, s(1), 0.6)).toBe('varies');
  });
});

describe('consistencyOf', () => {
  it('the messaging task of epic #1015: 124, 35, 43 and 33 steps is erratic', () => {
    const c = consistencyOf('task', [run(1, 33), run(2, 43), run(3, 35), run(4, 124)], null);
    expect(c).toMatchObject({ runs: 4, succeeded: 4, successRate: 1, label: 'erratic', since: null, steps: { median: 39, max: 124 } });
    expect(c.perRun.map((r) => r.stepCount)).toEqual([33, 43, 35, 124]);
  });

  it('a cost that is unknown for one run is no cost spread at all', () => {
    expect(consistencyOf('task', [run(1, 10), run(2, 11, 'succeeded', false), run(3, 12)], null).costUsd).toBeNull();
    expect(consistencyOf('task', [run(1, 10), run(2, 11), run(3, 12)], null).costUsd).toMatchObject({ median: 0.011 });
  });

  it('carries the findings it was given and the time it counted from', () => {
    const since = new Date('2026-11-20T00:00:00Z');
    const r = run(1, 10);
    const c = consistencyOf('task', [r], since, new Map([[r.runId, [{ code: 'loop', severity: 'warn' }]]]));
    expect(c).toMatchObject({ since: since.toISOString(), label: 'not_enough_runs', perRun: [{ findings: [{ code: 'loop', severity: 'warn' }] }] });
  });

  it('no runs at all', () => {
    expect(consistencyOf('task', [], null)).toMatchObject({ runs: 0, successRate: 0, steps: null, label: 'not_enough_runs', perRun: [] });
  });
});
