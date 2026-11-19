import { createZodDto } from 'nestjs-zod';
import { z } from 'zod';

import { profileNameSchema } from '../fleet/fleet.schemas';
import { policyRefSchema } from '../policies/policies.schemas';
import { TASK_DEFAULTS } from './task-defaults';
import { taskSchedulesField } from './task-list.schemas';
import { taskParametersField } from './task-params.schemas';

/** A site an agent may visit: a hostname, or `*.` and a hostname. */
export const domainSchema = z
  .string()
  .trim()
  .toLowerCase()
  .regex(/^(\*\.)?[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?(\.[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?)*$/, 'A hostname such as example.test or *.example.test');

/** `Task.unattendedPayments`: what an unattended run that used a saved login does at a payment step (E37.3). */
export const UNATTENDED_PAYMENTS = ['ask', 'allow'] as const;
export type UnattendedPayments = (typeof UNATTENDED_PAYMENTS)[number];

const taskFields = {
  name: z.string().trim().min(1).max(200),
  goal: z.string().trim().min(1).max(4000),
  profile: profileNameSchema,
  hostId: z.uuid().nullable(),
  hostFallback: z.boolean(),
  allowedDomains: z.array(domainSchema).max(50),
  // Deprecated by agent policies (#401): still accepted for one release. They map to a
  // derived personal policy named "Task: <name>" and the response carries a `Deprecation` header.
  maxSteps: z.number().int().min(1).max(1000).meta({ deprecated: true }).describe('Deprecated, removed in the release after the one that introduced agent policies: use an agent policy (`policyId`). Maps to the policy\'s `budget.maxActions`.'),
  maxMinutes: z.number().int().min(1).max(480).meta({ deprecated: true }).describe('Deprecated, removed in the release after the one that introduced agent policies: use an agent policy (`policyId`). Maps to the policy\'s `budget.maxActiveMinutes`.'),
  confirmRiskyActions: z.boolean(),
  model: z.string().trim().min(1).max(200).nullable().meta({ deprecated: true }).describe('Deprecated, removed in the release after the one that introduced agent policies: use an agent policy (`policyId`). Maps to the policy\'s `models.pins.standard`.'),
  policyId: policyRefSchema.nullable().describe("The task's agent policy: an own policy's UUID or `builtin:<key>`. `null` follows the user's default policy."),
  parameters: taskParametersField,
  useSavedLogins: z
    .boolean()
    .describe(
      "Let the agent sign in from the owner's saved logins when a page asks (E37.3). Off by default (a new task starts from the owner's `secrets.defaultUseSavedLogins` setting). It works only while the deployment's and the owner's secrets switches are on and a Vault is connected.",
    ),
  useSavedIdentity: z
    .boolean()
    .describe(
      "Let the agent fill identity details (a date of birth, an ID number, an address) from the owner's saved details (E37.6): it names the field and the fabric types it, so the model never reads the value. Off by default, and it works only with `useSavedLogins` on and a provider that holds identity details.",
    ),
  unattendedPayments: z
    .enum(UNATTENDED_PAYMENTS)
    .describe(
      "What an unattended run (a schedule, the API or an AI app) does at a payment step after it signed in with a saved login: `ask` (the default) keeps the confirmation on for that run even when `confirmRiskyActions` is off; `allow` leaves the task's own setting. The owner's saved approvals still apply.",
    ),
};

export const createTaskSchema = z.object({
  ...taskFields,
  profile: taskFields.profile.default('default'),
  hostId: taskFields.hostId.optional(),
  hostFallback: taskFields.hostFallback.default(true),
  allowedDomains: taskFields.allowedDomains.default([]),
  // A human emulator with the owner's full authority (#366): room to work,
  // and no confirmation before purchases unless the task opts in.
  maxSteps: taskFields.maxSteps.default(TASK_DEFAULTS.maxSteps),
  maxMinutes: taskFields.maxMinutes.default(TASK_DEFAULTS.maxMinutes),
  confirmRiskyActions: taskFields.confirmRiskyActions.default(false),
  model: taskFields.model.optional(),
  policyId: taskFields.policyId.optional(),
  parameters: taskFields.parameters.optional(),
  // Absent: the owner's `secrets.defaultUseSavedLogins` (off unless they turned it on).
  useSavedLogins: taskFields.useSavedLogins.optional(),
  useSavedIdentity: taskFields.useSavedIdentity.optional(),
  unattendedPayments: taskFields.unattendedPayments.default('ask'),
  schedules: taskSchedulesField.optional(),
});
export class CreateTaskDto extends createZodDto(createTaskSchema) {}

// Built from the fields without their defaults: zod 4 applies `.default()`
// inside `.partial()`, which would reset every field a PATCH leaves out.
export const updateTaskSchema = z.object(taskFields).partial().refine((p) => Object.keys(p).length > 0, { message: 'Nothing to update' });
export class UpdateTaskDto extends createZodDto(updateTaskSchema) {}

// The runs list, its shared filter (`runFilterSchema`) and the counts query live in runs.schemas.ts (#420).
export { ListRunsDto, RunCountsQueryDto, listRunsSchema, runCountsQuerySchema, runFilterSchema, type RunFilter } from './runs.schemas';
