// The console's run metrics and their dashboard group: the group passes the
// platform's metric-group checks, every family reads a table a registered
// metric produces (conformance.spec.ts computes every registered group, this one included, on an empty store), and the service records bounded labels only.
import { appMetricRegistry } from '@marinoscar/platform-api/otel-core';
import { checkMetricGroups } from '@marinoscar/platform-api/telemetry/testing';

import { RUNS_METRIC_GROUP } from '../src/platform/telemetry/runs.metric-group';
import { RUN_METRICS, RunMetrics } from '../src/tasks/run-metrics';

/** The GreptimeDB table an OTLP metric lands in: dots to `_`, then `_total` (counter) or `_seconds_bucket` (histogram in s). */
function tableOf(def: (typeof RUN_METRICS)[number]): string {
  const base = def.name.replace(/\./g, '_');
  return def.kind === 'histogram' ? `${base}_seconds_bucket` : `${base}_total`;
}

describe('run metrics', () => {
  it('registers every app.runs.* metric', () => {
    for (const def of RUN_METRICS) expect(appMetricRegistry.get(def.key)).toMatchObject({ name: def.name });
  });

  it('the Browser agents group passes the platform checks and reads only tables the metrics produce', () => {
    expect(checkMetricGroups([RUNS_METRIC_GROUP])).toEqual([]);
    const tables = new Set(RUN_METRICS.map(tableOf));
    for (const f of RUNS_METRIC_GROUP.families) expect(tables).toContain(f.table);
  });

  it('records outcomes, durations, steps, handoffs and tokens with enum labels', () => {
    const calls: [string, string, number, Record<string, unknown> | undefined][] = [];
    const fake = {
      add: (k: string, v = 1, a?: Record<string, unknown>) => calls.push(['add', k, v, a]),
      record: (k: string, v: number, a?: Record<string, unknown>) => calls.push(['record', k, v, a]),
    };
    const m = new RunMetrics(fake as never);
    m.started('schedule');
    m.handoff();
    m.step('action', true);
    m.tokens(1200, 0);
    m.finished('failed', 'schedule', 42.5);
    expect(calls).toEqual([
      ['add', 'runsStarted', 1, { trigger: 'schedule' }],
      ['add', 'runHandoffs', 1, undefined],
      ['add', 'runSteps', 1, { kind: 'action', ok: 'true' }],
      ['add', 'runTokens', 1200, { direction: 'input' }],
      ['add', 'runsFinished', 1, { status: 'failed', trigger: 'schedule' }],
      ['record', 'runDuration', 42.5, { status: 'failed' }],
    ]);
    // Every label is a declared enum: no user, task, goal or URL ever becomes a metric label.
    for (const [, key, , attrs] of calls) {
      const declared = RUN_METRICS.find((d) => d.key === key)!.attributes ?? {};
      for (const label of Object.keys(attrs ?? {})) expect(declared[label]).toMatchObject({ kind: 'enum' });
    }
  });

  it('is a no-op without a metrics service', () => {
    expect(() => new RunMetrics().finished('succeeded', 'manual', 1)).not.toThrow();
  });
});
