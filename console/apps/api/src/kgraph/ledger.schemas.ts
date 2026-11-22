// The savings ledger's routes (E46.6, #780): the query and the two responses.
import { createZodDto } from 'nestjs-zod';
import { z } from 'zod';

import { LEDGER_OUTCOMES } from './ledger';

export const ledgerQuerySchema = z.object({ taskId: z.string().uuid() }).strict();

const costKnown = z.boolean().describe('False when a model call could not be priced: `costUsd` is then a lower bound ("at least").');
export const ledgerFiguresSchema = z
  .object({
    runs: z.number().int().describe('How many runs the figures are the median of.'),
    modelCalls: z.number(),
    costUsd: z.number().describe('A lower bound while costKnown is false'),
    costKnown,
    activeMs: z.number().int(),
  })
  .describe('Medians over the runs counted.');
const baseline = ledgerFiguresSchema
  .nullable()
  .describe("The task's AI-only baseline: the median of its newest 10 (at most) succeeded AI-only runs, from the ledger's `ai_only` rows and the task's runs from before the feature was on. Null until there is one.");
const note = z.string().nullable().describe('"no baseline yet" while the baseline is null (and then no saving is shown); otherwise null.');

export const ledgerRowSchema = z.object({
  runId: z.string().uuid(),
  mode: z.enum(['learn', 'reuse']),
  procedureVersionId: z.string().nullable().describe('The procedure version the run executed; null for an AI-only run.'),
  runStatus: z.string().describe("The run's terminal status."),
  steps: z.object({ replayed: z.number().int(), recovered: z.number().int(), judge: z.number().int(), agent: z.number().int() }).describe('Steps by how they ran.'),
  modelCalls: z.number().int(),
  inputTokens: z.number().int(),
  outputTokens: z.number().int(),
  cachedInputTokens: z.number().int(),
  costUsd: z.number().describe('A lower bound while costKnown is false'),
  costKnown,
  activeMs: z.number().int(),
  outcome: z.enum(LEDGER_OUTCOMES),
  checksPassed: z.boolean().nullable().describe("Whether the procedure's outcome checks passed; null when no procedure ran."),
  finishedAt: z.string(),
});
export const ledgerSchema = z.object({ taskId: z.string().uuid(), baseline, note, rows: z.array(ledgerRowSchema).describe('Newest first, at most 200.') });

export const kgraphSummarySchema = z.object({
  tasks: z.array(
    z.object({
      taskId: z.string().uuid(),
      taskName: z.string(),
      runs: z.number().int().describe('Ledger rows read (the newest 100 at most).'),
      procedureRuns: z.number().int().describe('Runs that executed a procedure version.'),
      cleanReplayRate: z.number().nullable().describe('`replayed_clean` runs over procedure runs; null with none.'),
      baseline,
      note,
      procedureFigures: ledgerFiguresSchema.nullable().describe('Medians of the procedure runs; null with none.'),
      saving: z
        .object({
          modelCalls: z.number(),
          costUsd: z.number(),
          costKnown: z.boolean().describe('False when the baseline or the procedure runs hold a lower-bound cost: the cost saving is then approximate.'),
          activeMs: z.number(),
        })
        .nullable()
        .describe('Baseline minus the procedure runs (positive: saved). Null without a baseline or without a procedure run: a saving is never assumed.'),
    }),
  ),
});

export class LedgerQueryDto extends createZodDto(ledgerQuerySchema) {}
export class LedgerResponseDto extends createZodDto(ledgerSchema) {}
export class KgraphSummaryResponseDto extends createZodDto(kgraphSummarySchema) {}
