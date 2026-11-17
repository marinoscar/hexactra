import { createZodDto } from 'nestjs-zod';
import { z } from 'zod';

import { agentPolicySpecSchema } from './agent-policy.schema';
import { parsePolicyRef } from './builtin-policies';
import { POLICY_SOURCES } from './policy-snapshot';

/** A policy reference: an own policy's UUID or `builtin:<key>`. */
export const policyRefSchema = z
  .string()
  .trim()
  .max(64)
  .refine((v) => parsePolicyRef(v) !== null, { message: 'A policy id: a UUID or builtin:<economy|balanced|thorough|unlimited>' })
  .describe("An agent policy's id: a UUID for the user's own policy, or `builtin:<key>` for a built-in one.");

const name = z.string().trim().min(1).max(100).describe('Unique among the user\'s policies.');
const description = z.string().trim().max(500).nullable().describe('What the policy is for.');

export const createPolicySchema = z.object({
  name,
  description: description.optional(),
  spec: agentPolicySpecSchema,
});
export class CreatePolicyDto extends createZodDto(createPolicySchema) {}

export const updatePolicySchema = z
  .object({ name: name.optional(), description: description.optional(), spec: agentPolicySpecSchema.optional() })
  .refine((p) => Object.keys(p).length > 0, { message: 'Nothing to update' });
export class UpdatePolicyDto extends createZodDto(updatePolicySchema) {}

export const duplicatePolicySchema = z.object({ name });
export class DuplicatePolicyDto extends createZodDto(duplicatePolicySchema) {}

export const deletePolicyQuerySchema = z.object({
  reassignTo: policyRefSchema.optional().describe('Move the tasks and schedules that use the policy to this one before deleting it.'),
});
export class DeletePolicyQueryDto extends createZodDto(deletePolicyQuerySchema) {}

export const setDefaultPolicySchema = z.object({
  policyId: policyRefSchema.nullable().describe('The new default policy; `null` goes back to `builtin:balanced`.'),
});
export class SetDefaultPolicyDto extends createZodDto(setDefaultPolicySchema) {}

// ---- Responses (OpenAPI) ----

const iso = z.string().describe('ISO 8601 timestamp');

export const agentPolicyResponseSchema = z.object({
  id: z.string().describe('A UUID, or `builtin:<key>` for a built-in policy.'),
  name: z.string(),
  description: z.string().nullable(),
  version: z.number().int().describe('The `If-Match` value for the next edit. Built-ins carry a constant.'),
  builtin: z.boolean().describe('Built-in policies are code: read-only, never deleted, only duplicated.'),
  spec: agentPolicySpecSchema,
  isDefault: z.boolean().describe("True for the user's default policy."),
  usage: z.object({ tasks: z.number().int(), schedules: z.number().int() }).describe('How many of the user\'s tasks and schedules reference the policy.'),
  hasNoHardStop: z.boolean().describe('True when every budget limit is unlimited: the run only ends by finishing, a stop or a stall.'),
  createdAt: iso.nullable(),
  updatedAt: iso.nullable(),
});
export class AgentPolicyResponseDto extends createZodDto(agentPolicyResponseSchema) {}

export const defaultPolicyResponseSchema = z.object({
  policyId: z.string().describe('The default policy: its id, or `builtin:balanced` when none was chosen.'),
  explicit: z.boolean().describe('False when the user never chose one.'),
});
export class DefaultPolicyResponseDto extends createZodDto(defaultPolicyResponseSchema) {}

export const policySummarySchema = z
  .object({
    id: z.string(),
    name: z.string(),
    version: z.number().int(),
    source: z.enum(POLICY_SOURCES).describe('Why this policy applied: the run request, the schedule, the task, the user default or the system default.'),
    builtin: z.boolean(),
  })
  .describe('The agent policy a run runs under; null until the run has started.');
