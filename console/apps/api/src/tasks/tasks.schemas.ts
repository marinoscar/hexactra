import { createZodDto } from 'nestjs-zod';
import { z } from 'zod';

import { profileNameSchema } from '../fleet/fleet.schemas';
import { policyRefSchema } from '../policies/policies.schemas';
import { TASK_DEFAULTS } from './task-defaults';

const domain = z
  .string()
  .trim()
  .toLowerCase()
  .regex(/^(\*\.)?[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?(\.[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?)*$/, 'A hostname such as example.test or *.example.test');

const taskFields = {
  name: z.string().trim().min(1).max(200),
  goal: z.string().trim().min(1).max(4000),
  profile: profileNameSchema,
  hostId: z.uuid().nullable(),
  hostFallback: z.boolean(),
  allowedDomains: z.array(domain).max(50),
  // Deprecated by agent policies (#401): still accepted for one release. They map to a
  // derived personal policy named "Task: <name>" and the response carries a `Deprecation` header.
  maxSteps: z.number().int().min(1).max(1000).meta({ deprecated: true }).describe('Deprecated: use an agent policy (`policyId`). Maps to the policy\'s `budget.maxActions`.'),
  maxMinutes: z.number().int().min(1).max(480).meta({ deprecated: true }).describe('Deprecated: use an agent policy (`policyId`). Maps to the policy\'s `budget.maxActiveMinutes`.'),
  confirmRiskyActions: z.boolean(),
  model: z.string().trim().min(1).max(200).nullable().meta({ deprecated: true }).describe('Deprecated: use an agent policy (`policyId`). Maps to the policy\'s `models.pins.standard`.'),
  policyId: policyRefSchema.nullable().describe("The task's agent policy: an own policy's UUID or `builtin:<key>`. `null` follows the user's default policy."),
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
});
export class CreateTaskDto extends createZodDto(createTaskSchema) {}

// Built from the fields without their defaults: zod 4 applies `.default()`
// inside `.partial()`, which would reset every field a PATCH leaves out.
export const updateTaskSchema = z.object(taskFields).partial().refine((p) => Object.keys(p).length > 0, { message: 'Nothing to update' });
export class UpdateTaskDto extends createZodDto(updateTaskSchema) {}

export const listRunsSchema = z.object({
  taskId: z.uuid().optional(),
  status: z.enum(['queued', 'running', 'waiting_human', 'succeeded', 'failed', 'cancelled']).optional(),
  limit: z.coerce.number().int().min(1).max(200).default(50),
});
export class ListRunsDto extends createZodDto(listRunsSchema) {}
