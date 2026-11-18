// Response shapes of the chat routes (#483), for the OpenAPI document and the
// generated SDK. `@ApiDataResponse` wraps each in the platform's `{ data }` envelope.
import { createZodDto } from 'nestjs-zod';
import { z } from 'zod';

const iso = z.string().describe('ISO 8601 timestamp');
const role = z.enum(['user', 'assistant', 'system']);
const kind = z.enum(['text', 'clarify', 'run', 'result', 'task_draft']).describe('`text`: plain text. `clarify`: a question to the owner (`meta.options` are suggested answers). `run`: the card of a run (`runId`). `result`: how a run ended (`runId`). `task_draft`: a task the AI drafted from the chat (`meta`).');
const liveRun = z
  .object({ id: z.uuid(), status: z.enum(['queued', 'running', 'waiting_human']) })
  .nullable()
  .describe("The chat's live run (queued, running or waiting for a person); null when it has none");

export const chatResponseSchema = z.object({
  id: z.uuid(),
  title: z.string().describe('Empty until the first message names the chat, or the owner does'),
  status: z.enum(['active', 'archived']).describe('An archived chat is read-only'),
  profile: z.string().describe("The browser profile the chat's runs use"),
  hostId: z.uuid().nullable().describe("The machine the chat's runs prefer; null lets the console choose"),
  hostFallback: z.boolean(),
  policyId: z.string().nullable().describe("The agent policy of the chat's runs (a UUID or `builtin:<key>`); null follows the user's default"),
  lastMessageAt: iso,
  createdAt: iso,
  updatedAt: iso,
});
export class ChatResponseDto extends createZodDto(chatResponseSchema) {}

export const chatMessageResponseSchema = z.object({
  id: z.uuid(),
  seq: z.number().int().describe('Order within the chat, from 1'),
  role,
  kind,
  text: z.string().describe('Never a secret: a credential the agent asks for goes to the browser, not to the chat'),
  runId: z.uuid().nullable().describe('The run a `run` or `result` message is about'),
  meta: z.unknown().nullable().describe('Kind-specific data; null for plain text'),
  createdAt: iso,
});
export class ChatMessageResponseDto extends createZodDto(chatMessageResponseSchema) {}

export const chatListItemResponseSchema = chatResponseSchema.extend({
  preview: z.object({ role, kind, text: z.string().describe('The start of the newest message, on one line') }).nullable().describe('Null for a chat with no message'),
  liveRun,
});

/** `GET /chats`: one page of chats. */
export const chatPageResponseSchema = z.object({
  items: z.array(chatListItemResponseSchema),
  nextCursor: z.string().nullable().describe('Pass it as `cursor` to read the next page; null on the last page. Opaque: do not parse or build it.'),
});
export class ChatPageResponseDto extends createZodDto(chatPageResponseSchema) {}

/** `GET /chats/:id`: the chat with its messages, oldest first. */
export const chatDetailResponseSchema = chatResponseSchema.extend({
  messages: z.array(chatMessageResponseSchema),
  hasMore: z.boolean().describe('True when more messages follow the last one returned: read on with `afterSeq`'),
  liveRun,
});
export class ChatDetailResponseDto extends createZodDto(chatDetailResponseSchema) {}
