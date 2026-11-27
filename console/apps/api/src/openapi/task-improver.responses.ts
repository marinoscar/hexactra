import { createZodDto } from 'nestjs-zod';
import { z } from 'zod';

// The responses of "Improve this task" (E52.8, #1023).

const evidence = z.object({ runId: z.uuid(), seqFrom: z.number().int(), seqTo: z.number().int(), finding: z.string().optional() });

export const improvementResponseSchema = z.object({
  id: z.uuid(),
  taskId: z.uuid(),
  status: z.enum(['queued', 'running', 'ready', 'failed', 'applied', 'dismissed']),
  runIds: z.array(z.uuid()).describe('The runs read, newest first'),
  goalBefore: z.string().describe("The task's goal template when the proposal was asked for"),
  proposedGoal: z.string().nullable(),
  summary: z.string().nullable().describe('What went wrong across the runs, in plain words'),
  changes: z
    .array(z.object({ kind: z.enum(['add', 'replace', 'remove']), text: z.string(), why: z.string(), evidence: z.array(evidence) }))
    .optional()
    .describe('Each change with the steps that show why; absent in a list'),
  siteFacts: z
    .array(z.object({ site: z.string(), kind: z.enum(['navigation', 'timing', 'quirk']), text: z.string(), evidence: z.array(evidence.omit({ finding: true })) }))
    .optional()
    .describe('Facts about a site worth keeping (proposals only: the owner turns one into a Knowledge Graph fact in the console); absent in a list'),
  confidence: z.enum(['low', 'medium', 'high']).nullable(),
  model: z.string().nullable(),
  usedImages: z.boolean(),
  error: z.string().nullable().describe('Why a failed proposal failed, for a person'),
  appliedGoal: z.string().nullable().describe('The goal the owner saved, when applied'),
  createdAt: z.string(),
  finishedAt: z.string().nullable(),
  decidedAt: z.string().nullable(),
});
export class ImprovementResponseDto extends createZodDto(improvementResponseSchema) {}

export class ImprovementListResponseDto extends createZodDto(z.object({ items: z.array(improvementResponseSchema) })) {}

export class ImprovementRequestedResponseDto extends createZodDto(z.object({ id: z.uuid(), status: z.literal('queued') })) {}
