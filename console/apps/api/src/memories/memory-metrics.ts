// `app.memories.writes` (#551): every memory write, by operation and source.
// Labels are bounded enums: never a user, a label or a value.
import { Injectable, Optional } from '@nestjs/common';
import { AppMetricsService } from '@marinoscar/platform-api/host';
import { registerAppMetrics, type AppMetricDef } from '@marinoscar/platform-api/otel-core';

export const MEMORY_WRITE_OPS = ['create', 'update', 'supersede', 'archive', 'unarchive', 'delete'] as const;
export type MemoryWriteOp = (typeof MEMORY_WRITE_OPS)[number];

/** Names are permanent once dashboards read them. */
export const MEMORY_METRICS: readonly AppMetricDef[] = [
  {
    key: 'memoryWrites',
    name: 'app.memories.writes',
    kind: 'counter',
    unit: '{write}',
    description: 'Memory writes, by operation and by who started them (the owner, or an agent proposal the owner approved).',
    attributes: { op: { kind: 'enum', values: MEMORY_WRITE_OPS }, source: { kind: 'enum', values: ['owner', 'agent_proposed'] } },
  },
];
registerAppMetrics(MEMORY_METRICS);

/** Records the memory metrics; a no-op where the host has no metrics service (unit tests). */
@Injectable()
export class MemoryMetrics {
  constructor(@Optional() private readonly metrics?: AppMetricsService) {}

  write(op: MemoryWriteOp, source: 'owner' | 'agent_proposed'): void {
    this.metrics?.add('memoryWrites', 1, { op, source });
  }
}
