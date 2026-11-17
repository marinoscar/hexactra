import { createZodDto } from 'nestjs-zod';
import { z } from 'zod';

import { agentPolicySpecSchema } from './agent-policy.schema';
import { MAX_IMPORT_POLICIES, POLICY_FILE_KIND } from './policy-transfer';

export const CONFLICT_MODES = ['rename', 'skip', 'replace'] as const;

const idList = z
  .string()
  .trim()
  .min(1)
  .max(8000)
  .default('all')
  .describe('`all` (the default: the built-in policies, then your own), or a comma-separated list of policy ids (UUIDs of your own policies, or `builtin:<key>`). Built-ins can be exported as a starting template.');

const flag = z
  .enum(['true', 'false'])
  .default('true')
  .transform((v) => v === 'true')
  .describe('Keep model pins (the default). `false` strips them, so the file works on any deployment.');

export const exportPoliciesQuerySchema = z.object({ ids: idList, includePins: flag });
export class ExportPoliciesQueryDto extends createZodDto(exportPoliciesQuerySchema) {}

/** The documented shape of the file (also what `GET /agent-policies/export` returns). */
export const policyFileSchema = z
  .object({
    kind: z.literal(POLICY_FILE_KIND),
    formatVersion: z.number().int().min(1).describe('Version of this file format. A newer version than the deployment reads is refused.'),
    exportedAt: z.string().describe('ISO 8601 timestamp of the export.'),
    policies: z
      .array(z.object({ name: z.string().max(100), description: z.string().max(500).nullable(), spec: agentPolicySpecSchema }))
      .max(MAX_IMPORT_POLICIES),
  })
  .describe('A portable set of agent policies: no ids, no user, no versions, no task usage, nothing secret.');
export class PolicyFileDto extends createZodDto(policyFileSchema) {}

/**
 * The request body. `file` is only checked to be an object here: the service
 * validates it entry by entry, so a bad policy is a 400 `POLICY_IMPORT_INVALID`
 * that lists every problem at once.
 */
export const importPoliciesSchema = z.object({
  file: z.record(z.string(), z.unknown()).describe('The exported file, as JSON. At most 100 policies and 256 KB.'),
  onConflict: z.enum(CONFLICT_MODES).default('rename').describe('When you already have a policy with the same name: `rename` adds " (2)", " (3)"...; `skip` leaves yours and skips the entry; `replace` overwrites yours and bumps its version.'),
});
export class ImportPoliciesDto extends createZodDto(importPoliciesSchema) {}

const warning = z.object({
  index: z.number().int().describe('Position of the policy in the file, from 0.'),
  name: z.string(),
  code: z.enum(['PIN_DROPPED', 'EXCEEDS_CEILING']),
  message: z.string(),
});

export const importPoliciesResponseSchema = z.object({
  created: z.array(z.object({ index: z.number().int(), id: z.string(), name: z.string(), renamedFrom: z.string().nullable().describe('The name in the file, when it was renamed.') })),
  replaced: z.array(z.object({ index: z.number().int(), id: z.string(), name: z.string(), version: z.number().int() })),
  skipped: z.array(z.object({ index: z.number().int(), name: z.string(), reason: z.literal('name_taken') })),
  warnings: z.array(warning).describe('A model pin dropped because it is unknown or disabled here; a budget above the deployment ceilings (stored as written, clamped at run time).'),
  errors: z.array(z.object({ index: z.number().int(), name: z.string().nullable(), issues: z.array(z.object({ path: z.string(), message: z.string() })) })).describe('Always empty on success: an invalid file is a 400.'),
});
export class ImportPoliciesResponseDto extends createZodDto(importPoliciesResponseSchema) {}
export type ImportPoliciesResponse = z.infer<typeof importPoliciesResponseSchema>;
