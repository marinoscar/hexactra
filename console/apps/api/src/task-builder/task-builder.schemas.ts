// The task builder routes' inputs (E42.1, #718).
import { createZodDto } from 'nestjs-zod';
import { z } from 'zod';

import { CHAT_MESSAGE_MAX } from '../chat/chat.schemas';
import { taskBuilderSpecPatchSchema } from './task-builder.spec.schema';

/** `POST /task-builder`. */
export const createTaskBuilderSchema = z.object({
  seed: z.string().trim().min(1).max(CHAT_MESSAGE_MAX).optional().describe("The owner's first message (what the task should do): the builder answers it at once. Never a password or a code."),
});
export class CreateTaskBuilderDto extends createZodDto(createTaskBuilderSchema) {}

/** `PATCH /task-builder/:id/spec`: any of the spec's top-level fields; `null` clears one. */
export class PatchTaskSpecDto extends createZodDto(taskBuilderSpecPatchSchema as unknown as z.ZodObject) {}
