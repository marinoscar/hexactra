// Request and response shapes of the diagnostics routes (E50.10, #980). No field can hold content, a provider message, an address or
// a token: codes from a closed list, remedy keys of `packages/shared/diagnostics.json`, counts, booleans, host names and ids.
import { createZodDto } from 'nestjs-zod';
import { z } from 'zod';

import { DIAGNOSTIC_TARGET_KINDS, DIAGNOSTIC_TRIGGERS, STAGE_STATUSES, diagnosticStageSchema } from './diagnostic-report';
import { DEFAULT_HISTORY, KEEP_PER_TARGET } from './diagnostics-history.service';

const iso = z.string().describe('ISO 8601 timestamp');
const status = z.enum(STAGE_STATUSES);

const stageSchema = diagnosticStageSchema.describe(
  'One stage, in order: `id` (`status`, `provider_installed`, `sign_in`, `capability:<name>`, `server`, `latency`, or a provider\'s own), `status` (`pass`, `warn`, `fail`, `skipped`), `code` (closed list, never provider text), `remedy` (a key of the remedy table, rendered by the client), `ms`, and `data` (counts, booleans, a host name or an id; never content, an address or a token).',
);

export const diagnosticReportSchema = z.object({
  id: z.string().uuid(),
  target: z.object({ kind: z.enum(DIAGNOSTIC_TARGET_KINDS), id: z.string() }),
  trigger: z.enum(DIAGNOSTIC_TRIGGERS).describe('Who ran it: `owner`, `admin`, `cli` or the daily `health_job`.'),
  overall: status.describe('`fail` if a stage failed, else `warn` if one warned, else `pass`; `skipped` when nothing ran.'),
  startedAt: iso,
  finishedAt: iso,
  stages: z.array(stageSchema),
});
export class DiagnosticReportResponseDto extends createZodDto(diagnosticReportSchema) {}

export const diagnosticSummarySchema = z.object({
  targetId: z.string().describe("The connection's id."),
  overall: status,
  at: iso.describe('When its last report finished ("last checked").'),
});
export class DiagnosticSummaryResponseDto extends createZodDto(diagnosticSummarySchema) {}

export const diagnosticHistoryQuerySchema = z
  .object({
    limit: z.coerce.number().int().min(1).max(KEEP_PER_TARGET).default(DEFAULT_HISTORY).describe(`How many of the last reports (default ${DEFAULT_HISTORY}, at most ${KEEP_PER_TARGET}).`),
  })
  .strict();
export class DiagnosticHistoryQueryDto extends createZodDto(diagnosticHistoryQuerySchema) {}

