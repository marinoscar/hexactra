// `app.skills.errors` (#1008): a skills error a run or chat went on without (the query, the match, a read, the bookkeeping).
// Labels are bounded enums: never a user, a skill name or its text.
import { Injectable, Optional } from '@nestjs/common';
import { AppMetricsService } from '@marinoscar/platform-api/host';
import { registerAppMetrics, type AppMetricDef } from '@marinoscar/platform-api/otel-core';

export const SKILL_ERROR_STAGES = ['query', 'match', 'read', 'record'] as const;
export type SkillErrorStage = (typeof SKILL_ERROR_STAGES)[number];

/** Names are permanent once dashboards read them. */
export const SKILL_METRICS: readonly AppMetricDef[] = [
  {
    key: 'skillErrors',
    name: 'app.skills.errors',
    kind: 'counter',
    unit: '{error}',
    description: 'Skills errors a run or chat went on without, by stage: query (reading the skills or the switches), match, read (skill_read), record (the run bookkeeping).',
    attributes: { stage: { kind: 'enum', values: SKILL_ERROR_STAGES } },
  },
];
registerAppMetrics(SKILL_METRICS);

/** Records the skills metrics; a no-op where the host has no metrics service (unit tests). */
@Injectable()
export class SkillMetrics {
  /** Counts kept in the process, for tests and the Doctor: never a user or a name. */
  readonly counted: Record<SkillErrorStage, number> = { query: 0, match: 0, read: 0, record: 0 };

  constructor(@Optional() private readonly metrics?: AppMetricsService) {}

  error(stage: SkillErrorStage): void {
    this.counted[stage] += 1;
    try {
      this.metrics?.add('skillErrors', 1, { stage });
    } catch {
      // A metric never fails a run.
    }
  }
}
