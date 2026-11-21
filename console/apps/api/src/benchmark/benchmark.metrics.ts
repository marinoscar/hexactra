// The benchmark metrics (E44.3, #741): `app.benchmarks.started` and `app.benchmarks.trials` by verdict. Labels are closed lists:
// never a user, a policy, a challenge or a host.
import { Injectable, Optional } from '@nestjs/common';
import { AppMetricsService } from '@marinoscar/platform-api/host';
import { registerAppMetrics, type AppMetricDef } from '@marinoscar/platform-api/otel-core';

import { TRIAL_VERDICTS } from './benchmark.constants';

/** Names are permanent once dashboards read them. */
export const BENCHMARK_METRICS: readonly AppMetricDef[] = [
  { key: 'benchmarksStarted', name: 'app.benchmarks.started', kind: 'counter', unit: '{benchmark}', description: 'Benchmarks an administrator started.' },
  {
    key: 'benchmarkTrials',
    name: 'app.benchmarks.trials',
    kind: 'counter',
    unit: '{trial}',
    description: 'Benchmark trials that ended, by verdict (pass, fail, error, skipped, unsupported).',
    attributes: { verdict: { kind: 'enum', values: TRIAL_VERDICTS } },
  },
];
registerAppMetrics(BENCHMARK_METRICS);

/** Records the benchmark metrics; a no-op where the host has no metrics service (unit tests). */
@Injectable()
export class BenchmarkMetrics {
  constructor(@Optional() private readonly metrics?: AppMetricsService) {}

  started(): void {
    this.metrics?.add('benchmarksStarted' as never, 1);
  }

  trials(verdict: string, count = 1): void {
    if (count > 0) this.metrics?.add('benchmarkTrials' as never, count, { verdict });
  }
}
