import { createZodDto } from 'nestjs-zod';
import { z } from 'zod';
import { timeZoneIdSchema } from '@marinoscar/platform-contract/settings';

import { RUN_STATS_ADMIN_GROUP_BY, RUN_STATS_GROUP_BY, RUN_STATS_MAX_GROUPS, RUN_STATS_MAX_RUNS } from '../run-insights/run-stats';
import { runFilterSchema } from '../tasks/runs.schemas';

// The responses of the run and task insights (E52.6, E52.7).

export const RUN_FINDING_CODES = ['loop', 'selector_miss', 'repeated_click', 'observation_heavy', 'slow_start', 'waited_for_owner', 'budget_pressure', 'failures', 'unknown_outcome'] as const;

export const runFindingSchema = z.object({
  code: z.enum(RUN_FINDING_CODES).describe('What kind of finding it is'),
  severity: z.enum(['info', 'warn']),
  title: z.string().describe('One line for a person'),
  detail: z.string().describe('One or two sentences, facts only'),
  seqFrom: z.number().int().nullable().describe('The first step it is about, or null'),
  seqTo: z.number().int().nullable().describe('The last step it is about, or null'),
  stepsSpent: z.number().int().describe('Steps attributable to it; 0 when not applicable'),
  evidence: z.record(z.string(), z.union([z.string(), z.number(), z.boolean(), z.array(z.number())])).describe('The facts behind it'),
});

export const runDiagnosticsResponseSchema = z.object({
  runId: z.uuid(),
  computedAt: z.string().describe('When the findings were computed (on read, ISO 8601)'),
  stepsRead: z.number().int(),
  truncated: z.boolean().describe('True when the run has more than 2,000 steps: the findings cover the first 2,000'),
  findings: z.array(runFindingSchema).describe('Warnings first, then by steps spent'),
});
export class RunDiagnosticsResponseDto extends createZodDto(runDiagnosticsResponseSchema) {}

const spreadSchema = z.object({ min: z.number(), median: z.number(), p90: z.number(), max: z.number(), ratio: z.number().describe('max ÷ median; 1 when the median is 0') });

export const taskConsistencyResponseSchema = z.object({
  taskId: z.uuid(),
  runs: z.number().int().describe('The finished runs counted'),
  succeeded: z.number().int(),
  successRate: z.number().describe('0 to 1'),
  steps: spreadSchema.nullable(),
  modelCalls: spreadSchema.nullable(),
  activeMs: spreadSchema.nullable(),
  costUsd: spreadSchema.nullable().describe('Null when the cost of a counted run is unknown'),
  label: z.enum(['not_enough_runs', 'steady', 'varies', 'erratic']).describe('Fewer than 3 runs: not_enough_runs. steady: the largest run is at most 1.5× the median in steps and 90% succeeded; erratic: over 3× or under 60% succeeded; varies otherwise'),
  since: z.string().nullable(),
  perRun: z.array(
    z.object({
      runId: z.uuid(),
      status: z.string(),
      createdAt: z.string(),
      stepCount: z.number().int(),
      costUsd: z.number().nullable(),
      activeMs: z.number().int(),
      findings: z.array(z.object({ code: z.string(), severity: z.string() })).describe('The findings of the 10 newest runs; empty for older ones'),
    }),
  ),
});
export class TaskConsistencyResponseDto extends createZodDto(taskConsistencyResponseSchema) {}

export const taskConsistencyQuerySchema = z.object({
  last: z.coerce.number().int().min(3).max(50).default(20).describe('How many of the newest finished runs to count (3 to 50)'),
  since: z.iso.datetime({ offset: true }).optional().describe('Only runs created at or after this time (ISO 8601)'),
});
export class TaskConsistencyQueryDto extends createZodDto(taskConsistencyQuerySchema) {}

// Run statistics (E53.1, #1069).

/** `GET /runs/stats`: the runs list's filter, a grouping and the time zone of the days and weeks. */
export const runStatsQuerySchema = runFilterSchema.extend({
  groupBy: z.enum(RUN_STATS_GROUP_BY).default('none').describe('One grouping: `none` (the total only), `task`, `policy`, `stopReason`, `status`, `trigger`, `origin`, `tier` (the model tier the run ended on), `day` or `week` (by creation time in `tz`; a week starts on Monday).'),
  tz: timeZoneIdSchema.optional().describe("IANA time zone of the days and weeks; default the caller's time zone setting."),
});
export class RunStatsQueryDto extends createZodDto(runStatsQuerySchema) {}

/**
 * `GET /admin/runs/stats` (E53.2): the same, over every user, plus `groupBy=user`. No goal search: a goal is a person's own text, and
 * an aggregate over a search would let an administrator probe what others asked for.
 */
export const adminRunStatsQuerySchema = runFilterSchema
  .omit({ q: true })
  .extend({
    groupBy: z.enum(RUN_STATS_ADMIN_GROUP_BY).default('none').describe('As `GET /runs/stats`, plus `user`.'),
    tz: timeZoneIdSchema.optional().describe("IANA time zone of the days and weeks; default the caller's time zone setting."),
    q: z.never({ error: 'A goal search is not offered across users' }).optional().describe('Refused: a goal is the person’s own text.'),
  });
export class AdminRunStatsQueryDto extends createZodDto(adminRunStatsQuerySchema) {}

const distributionSchema = z
  .object({
    n: z.number().int().describe('Finished runs with a value'),
    sum: z.number(),
    mean: z.number(),
    min: z.number(),
    p50: z.number().describe('The median (the mean of the two middle values of an even list)'),
    p90: z.number().describe('The 90th percentile, by the nearest rank'),
    max: z.number(),
  })
  .nullable()
  .describe('Over the finished runs of the group; null when it has none');

const runStatsGroupSchema = z.object({
  runs: z.number().int().describe('Every matching run, live or finished'),
  finished: z.number().int().describe('succeeded + failed + cancelled: what the distributions and the success rate are over'),
  live: z.number().int().describe('queued + running + waiting_human + paused'),
  byStatus: z.object({
    queued: z.number().int(),
    running: z.number().int(),
    waiting_human: z.number().int(),
    paused: z.number().int(),
    succeeded: z.number().int(),
    failed: z.number().int(),
    cancelled: z.number().int(),
  }),
  successRate: z.number().nullable().describe('succeeded ÷ finished, 0 to 1; null with no finished run'),
  costPerSuccessUsd: z.number().nullable().describe("The finished runs' cost ÷ the succeeded runs; null with none succeeded. A lower bound while costKnown is false"),
  costKnown: z.boolean().describe('False when a finished run had a model call that could not be priced'),
  metrics: z.object({
    workingMs: distributionSchema.describe('Time in `running` (waiting for a person never counts)'),
    wallMs: distributionSchema.describe('From start to finish, waits included; runs that never started are left out'),
    modelMs: distributionSchema.describe('Time spent waiting for the model (E54.0), measured per call; runs from before it was measured are left out'),
    steps: distributionSchema,
    modelCalls: distributionSchema,
    inputTokens: distributionSchema.describe('Input tokens, cached included'),
    cachedInputTokens: distributionSchema,
    outputTokens: distributionSchema,
    totalTokens: distributionSchema.describe('Input + output'),
    costUsd: distributionSchema.describe("Each run's stored cost: the prices of the day it ran"),
  }),
});

export const runStatsResponseSchema = z.object({
  groupBy: z.enum(RUN_STATS_ADMIN_GROUP_BY),
  timeZone: z.string().describe('The time zone of the days and weeks'),
  scanned: z.number().int().describe(`Runs read: at most ${RUN_STATS_MAX_RUNS}, the newest`),
  truncated: z.boolean().describe(`True when more than ${RUN_STATS_MAX_RUNS} runs matched: narrow the filter (from, to) for exact numbers`),
  total: runStatsGroupSchema,
  groups: z
    .array(runStatsGroupSchema.extend({ key: z.string().describe('An id, a value, `none`, or the first day of the period (YYYY-MM-DD)'), label: z.string().describe('What a person reads: a task or policy name, else the key') }))
    .describe('Empty for groupBy=none. Periods oldest first (a period with no run is absent); any other grouping largest first'),
  groupsTruncated: z.boolean().describe(`True when there were more than ${RUN_STATS_MAX_GROUPS} groups: the largest (or the latest periods) are kept`),
});
export class RunStatsResponseDto extends createZodDto(runStatsResponseSchema) {}
