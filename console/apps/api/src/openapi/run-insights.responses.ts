import { createZodDto } from 'nestjs-zod';
import { z } from 'zod';

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
