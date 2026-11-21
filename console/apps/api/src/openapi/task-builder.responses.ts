// Response shapes of the task builder routes (E42.1, #718), for the OpenAPI document and the generated SDK.
import { createZodDto } from 'nestjs-zod';
import { z } from 'zod';

import { specFields } from '../task-builder/task-builder.spec.schema';
import { chatMessageResponseSchema, chatTaskDraftResponseSchema } from './chat.responses';

const iso = z.string().describe('ISO 8601 timestamp');

export const taskBuilderSpecResponseSchema = z.object(specFields).describe('What the builder has learned about the task so far. Every field is optional; never a secret.');
export class TaskBuilderSpecResponseDto extends createZodDto(taskBuilderSpecResponseSchema) {}

export const taskBuilderResponseSchema = z.object({
  id: z.uuid().describe("The builder's id (a conversation's: its live updates are `GET /chats/{id}/stream`)"),
  title: z.string().describe('Empty until the first message names it'),
  status: z.enum(['active', 'archived']).describe('Archived once its task is saved'),
  spec: taskBuilderSpecResponseSchema,
  createdAt: iso,
  updatedAt: iso,
});
export class TaskBuilderResponseDto extends createZodDto(taskBuilderResponseSchema) {}

export const taskBuilderDetailResponseSchema = taskBuilderResponseSchema.extend({
  messages: z.array(chatMessageResponseSchema),
  hasMore: z.boolean().describe('True when more messages follow the last one returned: read on with `afterSeq`'),
  thinking: z.boolean().describe('True while the builder is working on its reply'),
});
export class TaskBuilderDetailResponseDto extends createZodDto(taskBuilderDetailResponseSchema) {}

/** `POST /task-builder/{id}/draft`: the chat draft's shape, plus the schedules and what the owner should check. */
export const taskBuilderDraftResponseSchema = chatTaskDraftResponseSchema.extend({
  unattendedPayments: z.enum(['ask', 'allow']),
  needsBrowser: z.enum(['auto', 'always', 'never']),
  schedules: z
    .array(z.object({ cron: z.string(), timezone: z.string(), enabled: z.boolean(), concurrency: z.enum(['skip', 'queue']), policyId: z.null(), inputs: z.record(z.string(), z.string()).optional().describe('Preset values by parameter key') }))
    .describe('The schedules the spec holds that pass the checks, in the shape `POST /tasks` takes in `schedules[]`'),
  warnings: z.array(z.string()).describe('What could not be carried over as the spec said (an unknown account, an invalid schedule), in words for the form'),
});
export class TaskBuilderDraftResponseDto extends createZodDto(taskBuilderDraftResponseSchema) {}
