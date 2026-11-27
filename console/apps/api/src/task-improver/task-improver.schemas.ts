import { createZodDto } from 'nestjs-zod';
import { z } from 'zod';

// The shapes of "Improve this task" (E52.8, #1023): what the model must answer, what a request takes, and what the API returns.

const evidence = z.object({ runId: z.string().uuid(), seqFrom: z.number().int().min(1), seqTo: z.number().int().min(1), finding: z.string().max(40).optional() }).strict();

export const proposalChangeSchema = z
  .object({ kind: z.enum(['add', 'replace', 'remove']), text: z.string().min(1).max(500), why: z.string().min(1).max(500), evidence: z.array(evidence).max(10) })
  .strict();
export type ProposalChange = z.infer<typeof proposalChangeSchema>;

export const proposalSiteFactSchema = z
  .object({ site: z.string().min(3).max(253), kind: z.enum(['navigation', 'timing', 'quirk']), text: z.string().min(1).max(300), evidence: z.array(evidence.omit({ finding: true })).max(10) })
  .strict();
export type ProposalSiteFact = z.infer<typeof proposalSiteFactSchema>;

/** What the model answers, through the `propose` tool. */
export const proposalAnswerSchema = z
  .object({
    summary: z.string().min(1).max(1000),
    proposedGoal: z.string().min(1).max(4000),
    changes: z.array(proposalChangeSchema).max(12),
    siteFacts: z.array(proposalSiteFactSchema).max(5),
    confidence: z.enum(['low', 'medium', 'high']),
  })
  .strict();
export type ProposalAnswer = z.infer<typeof proposalAnswerSchema>;

export const requestImprovementSchema = z.object({ runIds: z.array(z.string().uuid()).min(1).max(10).optional() }).strict();
export class RequestImprovementDto extends createZodDto(requestImprovementSchema) {}

export const appliedSchema = z.object({ goal: z.string().min(1).max(4000) }).strict();
export class AppliedDto extends createZodDto(appliedSchema) {}

export const IMPROVEMENT_STATUSES = ['queued', 'running', 'ready', 'failed', 'applied', 'dismissed'] as const;
export type ImprovementStatus = (typeof IMPROVEMENT_STATUSES)[number];
