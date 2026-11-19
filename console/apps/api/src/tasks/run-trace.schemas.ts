// The run trace file (#542): its zod schema, which is the OpenAPI response of
// `GET /runs/{id}/export`, the JSON Schema shipped in packages/sdk
// (run-trace.schema.json, checked by test/run-trace-export.spec.ts) and the
// MCP tool `run_export`'s output. One shape for the JSON file here and the
// PDF report of #543, both built by `RunTraceService.build`.
import { SENSITIVE_PATTERN_IDS } from '@app/shared/sensitive-patterns';
import { createZodDto } from 'nestjs-zod';
import { z } from 'zod';

import { runClientSchema, runOriginSchema } from '../connected-apps/connected-apps.schemas';
import { runBudgetSchema, runStepResponseSchema } from '../openapi/console.responses';
import { TIERS } from '../policies/agent-policy.schema';
import { agentPolicySpecSchema } from '../policies/agent-policy.schema';
import { POLICY_SOURCES } from '../policies/policy-snapshot';
import { RUN_STOP_REASONS } from '../runner/budget';

/** The `type` of every run trace file. */
export const RUN_TRACE_TYPE = 'hexactra.run-trace';
/** The file format this build writes. A change that older readers cannot follow bumps it. */
export const RUN_TRACE_FORMAT_VERSION = 1;
/** The largest file the route sends; above it, 413 `EXPORT_TOO_LARGE` (use `screenshots=none`). */
export const RUN_EXPORT_MAX_BYTES = 50 * 1024 * 1024;
/** How many exports one user may ask for in a minute. */
export const RUN_EXPORT_RATE_LIMIT = 10;
/** The most chat messages a file carries (the newest of the run's conversation). */
export const RUN_TRACE_MAX_CHAT = 1_000;

export const RUN_EXPORT_FORMATS = ['json', 'pdf'] as const;
export type RunExportFormat = (typeof RUN_EXPORT_FORMATS)[number];
export const RUN_EXPORT_SCREENSHOTS = ['embed', 'none'] as const;
export type RunExportScreenshots = (typeof RUN_EXPORT_SCREENSHOTS)[number];
/** The paper of the PDF report (#543). */
export const RUN_EXPORT_PAPERS = ['a4', 'letter'] as const;

export const runExportQuerySchema = z.object({
  format: z.enum(RUN_EXPORT_FORMATS).default('json').describe('`json` (the default): the run trace file. `pdf`: the run report (#543), rendered from the same masked trace.'),
  screenshots: z
    .enum(RUN_EXPORT_SCREENSHOTS)
    .default('embed')
    .describe('`embed` (the default) puts each masked trace picture in the file (`steps[].screenshot.data` as base64, or in the report after its step); `none` leaves the images out (a much smaller file).'),
  paper: z.enum(RUN_EXPORT_PAPERS).default('a4').describe('The PDF report\'s paper: `a4` (the default) or `letter`. Ignored for `json`.'),
});
export class RunExportQueryDto extends createZodDto(runExportQuerySchema) {}

const iso = z.string().describe('ISO 8601 timestamp');
const runStatus = z.enum(['queued', 'running', 'waiting_human', 'paused', 'succeeded', 'failed', 'cancelled']);

const screenshotSchema = z
  .object({
    moment: z.enum(['question', 'before_confirmed', 'after_confirmed', 'failure', 'final']).nullable().describe('The key moment the picture records'),
    masked: z.number().int().nullable().describe('How many regions the extension masked in the picture'),
    note: z.enum(['unavailable', 'masked_failed', 'no_storage', 'capped']).nullable().describe('Why a key moment has no picture; null when it has one'),
    contentType: z.string().nullable().describe('`image/jpeg` or `image/png`; null without a picture'),
    bytes: z.number().int().nullable().describe('Size of the stored image; null with `screenshots=none` or when it could not be read'),
    data: z.string().optional().describe('The masked image, base64. Only with `screenshots=embed`.'),
  })
  .describe('The masked trace picture of a step (#541); null for a step that records no key moment');

export const runTraceStepSchema = z.object({
  seq: z.number().int(),
  at: iso,
  kind: z.string().describe('action | handoff | finish | error | note | routing | guidance | end (see `GET /runs/{id}`)'),
  action: z.string().nullable(),
  args: z.record(z.string(), z.unknown()).nullable().describe('The stored, redacted arguments, masked again'),
  ok: z.boolean(),
  summary: z.string().describe('Masked'),
  reasoning: z.string().nullable().describe("The model's own words, masked"),
  durationMs: z.number().int().nullable(),
  question: runStepResponseSchema.shape.question,
  screenshot: screenshotSchema.nullable(),
});

export const runTraceSchema = z
  .object({
    type: z.literal(RUN_TRACE_TYPE),
    formatVersion: z.literal(RUN_TRACE_FORMAT_VERSION).describe('Version of this file format'),
    exportedAt: iso,
    partial: z.boolean().describe('True for a run that was live (queued, running, waiting for its person) when it was exported'),
    console: z.object({ version: z.string().describe('The console version that wrote the file') }),
    masking: z.object({
      applied: z.literal(true).describe('Always true: there is no unmasked export'),
      patternsVersion: z.number().int().describe('Version of the sensitive-text pattern table (docs/runs.md, "What is masked")'),
      hits: z.partialRecord(z.enum(SENSITIVE_PATTERN_IDS as [string, ...string[]]), z.number().int()).describe('How many matches of each pattern the export masked; patterns with none are left out'),
    }),
    run: z.object({
      id: z.uuid(),
      goal: z.string(),
      status: runStatus,
      stopReason: z.enum(RUN_STOP_REASONS).nullable(),
      result: z.string().nullable(),
      error: z.string().nullable(),
      trigger: z.enum(['manual', 'schedule', 'api', 'mcp', 'external', 'chat']),
      origin: runOriginSchema,
      client: runClientSchema.nullable(),
      taskId: z.uuid().nullable(),
      taskName: z.string().nullable(),
      conversationId: z.uuid().nullable(),
      profile: z.string(),
      traceIds: z.array(z.string()).describe("The OpenTelemetry trace ids of the run's jobs (32 hex characters each), oldest first, the newest 100: one trace per job. Empty with the telemetry slice off. Find them in the deployment's trace collector."),
      host: z.object({ id: z.uuid(), name: z.string().nullable() }).nullable().describe('The machine the run used; `name` null when the fabric could not be asked'),
      createdAt: iso,
      startedAt: iso.nullable(),
      finishedAt: iso.nullable(),
      confirmedActions: z.array(z.object({ seq: z.number().int(), prompt: z.string(), action: z.string(), at: iso })).describe('Steps the owner confirmed that the run carried out (#540)'),
      usage: z
        .object({
          stepCount: z.number().int(),
          modelCalls: z.number().int(),
          inputTokens: z.number().int(),
          outputTokens: z.number().int(),
          cachedInputTokens: z.number().int(),
          costUsd: z.number().describe('A lower bound while costKnown is false'),
          costKnown: z.boolean(),
          activeMs: z.number().int().describe('Time spent working, waits for a person excluded'),
        })
        .describe('What the run used'),
    }),
    policy: z
      .object({ id: z.string(), name: z.string(), version: z.number().int(), builtin: z.boolean(), source: z.enum(POLICY_SOURCES).nullable(), spec: agentPolicySpecSchema })
      .nullable()
      .describe('The agent policy the run ran under, as snapshotted at its start; null before its first step'),
    budget: runBudgetSchema.nullable(),
    models: z
      .array(z.object({ tier: z.enum(TIERS), model: z.string().nullable(), calls: z.number().int().nullable().describe('Model calls on this tier; null when the run used several tiers (calls are counted per run)') }))
      .describe('The tiers the run used, in order, with their models'),
    steps: z.array(runTraceStepSchema),
    chat: z
      .array(z.object({ seq: z.number().int(), role: z.enum(['user', 'assistant', 'system']), kind: z.string(), text: z.string(), at: iso }))
      .describe("The messages of the run's conversation (a chat run); empty for any other run"),
  })
  .describe('A run trace file: everything about a run that is safe to share, masked. Never the transcript, a token, a withheld answer or an AI app\'s grant or limits.');
export class RunTraceDto extends createZodDto(runTraceSchema) {}

/** The file as a type: what `RunTraceService.build` returns and the PDF report reads. */
export type RunTrace = z.infer<typeof runTraceSchema>;
export type RunTraceStep = z.infer<typeof runTraceStepSchema>;
export type RunTraceScreenshot = z.infer<typeof screenshotSchema>;
