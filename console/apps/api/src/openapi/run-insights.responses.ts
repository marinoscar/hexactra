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
