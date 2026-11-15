import { createZodDto } from 'nestjs-zod';
import { z } from 'zod';

import { QUESTION_STATUSES, questionAnswerSchema, questionSpecObject } from './questions.contract';
import { MAX_WAIT_MS } from './questions.service';

/** `POST /api/questions`: the question (the input-specific rules are checked by `QuestionsService.parseSpec`). */
export const createQuestionSchema = questionSpecObject.extend({
  /** Who asks, e.g. the agent framework's name: recorded as `agent:<asker>`; omitted, the question is `user:<id>`. */
  asker: z.string().trim().min(1).max(100).optional(),
});
export class CreateQuestionDto extends createZodDto(createQuestionSchema) {}

/** Which channel answered: a short label such as `web`, `cli`, `mcp` or `push`. */
const channel = z.string().trim().regex(/^[a-z0-9][a-z0-9_.-]{0,39}$/, 'A channel is 1-40 lowercase letters, digits, ".", "_" or "-"');

export const answerQuestionSchema = questionAnswerSchema.extend({ channel: channel.optional() });
export class AnswerQuestionDto extends createZodDto(answerQuestionSchema) {}

/** The body is optional. */
export const cancelQuestionSchema = z.object({ channel: channel.optional() }).strict().default({});
export class CancelQuestionDto extends createZodDto(cancelQuestionSchema) {}

export const listQuestionsSchema = z.object({
  status: z.enum(QUESTION_STATUSES).optional(),
  runId: z.uuid().optional(),
  limit: z.coerce.number().int().min(1).max(200).default(50),
});
export class ListQuestionsDto extends createZodDto(listQuestionsSchema) {}

export const getQuestionSchema = z.object({
  /** Hold the request up to this long (at most 30 s) while the question is pending. */
  waitMs: z.coerce.number().int().min(0).max(MAX_WAIT_MS).default(0),
});
export class GetQuestionDto extends createZodDto(getQuestionSchema) {}
