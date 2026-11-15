import { createZodDto } from 'nestjs-zod';
import { z } from 'zod';

import { profileNameSchema } from '../fleet/fleet.schemas';

const domain = z
  .string()
  .trim()
  .toLowerCase()
  .regex(/^(\*\.)?[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?(\.[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?)*$/, 'A hostname such as example.test or *.example.test');

export const createTaskSchema = z.object({
  name: z.string().trim().min(1).max(200),
  goal: z.string().trim().min(1).max(4000),
  profile: profileNameSchema.default('default'),
  hostId: z.uuid().nullable().optional(),
  allowedDomains: z.array(domain).max(50).default([]),
  maxSteps: z.number().int().min(1).max(200).default(40),
  maxMinutes: z.number().int().min(1).max(240).default(15),
  confirmRiskyActions: z.boolean().default(true),
  model: z.string().trim().min(1).max(200).nullable().optional(),
});
export class CreateTaskDto extends createZodDto(createTaskSchema) {}

export const updateTaskSchema = createTaskSchema.partial().refine((p) => Object.keys(p).length > 0, { message: 'Nothing to update' });
export class UpdateTaskDto extends createZodDto(updateTaskSchema) {}

export const listRunsSchema = z.object({
  taskId: z.uuid().optional(),
  status: z.enum(['queued', 'running', 'waiting_human', 'succeeded', 'failed', 'cancelled']).optional(),
  limit: z.coerce.number().int().min(1).max(200).default(50),
});
export class ListRunsDto extends createZodDto(listRunsSchema) {}
