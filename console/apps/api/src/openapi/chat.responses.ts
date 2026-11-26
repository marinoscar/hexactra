// Response shapes of the chat routes (#483), for the OpenAPI document and the
// generated SDK. `@ApiDataResponse` wraps each in the platform's `{ data }` envelope.
import { connectionSelectionViewSchema } from '../connections/agent-connections';
import { taskOutputResponseSchema, taskParameterResponseSchema } from './console.responses';
import { createZodDto } from 'nestjs-zod';
import { z } from 'zod';

const iso = z.string().describe('ISO 8601 timestamp');
const role = z.enum(['user', 'assistant', 'system']);
const kind = z.enum(['text', 'clarify', 'run', 'result', 'task_draft', 'memory', 'request']).describe('`text`: plain text. `clarify`: a question to the owner (`meta.options` are suggested answers). `run`: the card of a run (`runId`). `result`: how a run ended (`runId`). `task_draft`: a task the AI drafted from the chat (`meta`). `memory`: a suggested memory or saved sign-in (`meta.questionId`). `request`: something a run asked the owner (`meta.questionId`, `meta.input`, `meta.outcome`); never a value.');
const liveRun = z
  .object({ id: z.uuid(), status: z.enum(['queued', 'running', 'waiting_human', 'paused']) })
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
  allowedDomains: z.array(z.string()).describe("Sites the chat's runs may visit; empty is any site"),
  confirmRiskyActions: z.boolean().describe('Ask the owner before a purchase or another step that is hard to undo'),
  useSavedLogins: z.boolean().describe("Let the chat's runs sign in from the owner's saved logins (E37.3); off by default"),
  useSavedIdentity: z.boolean().describe("Let the chat's runs fill identity details from the owner's saved details (E37.6); off by default"),
  useSavedCards: z.boolean().describe("Let the chat's runs pay with a saved card (E37.7) under the owner's per-merchant approval and amount limit; off by default"),
  recordVideo: z.boolean().describe("Record a video of the chat's runs (epic #755); off by default. Not masked, owner-only"),
  connectionsMode: z.enum(['all', 'listed']).describe("Which of the owner's connections the chat may use (#969): `all` every active connection at what the owner switched on for it; `listed` only `connections`"),
  connections: z.array(connectionSelectionViewSchema).describe('The connections a limited chat may use, and how (E39.7). Empty with `all`. A new chat follows the owner\'s `connections.newChats` (`read_write`, the default: everything; `read`: Google and Microsoft read only; `off`: none).'),
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

/** `POST /chats/:id/task-draft`: a task drafted from the chat, in the shape `POST /tasks` takes. */
export const chatTaskDraftResponseSchema = z.object({
  name: z.string().describe('A short name the AI wrote, or the chat\'s title'),
  goal: z.string().describe("A standalone instruction written from the conversation; the chat's newest run goal when no model answered. Never a secret."),
  profile: z.string(),
  hostId: z.uuid().nullable(),
  hostFallback: z.boolean(),
  policyId: z.string().nullable(),
  allowedDomains: z.array(z.string()),
  confirmRiskyActions: z.boolean(),
  useSavedLogins: z.boolean().describe("The chat's saved-logins switch (E37.3), carried over to the task"),
  useSavedIdentity: z.boolean().describe("The chat's saved-details switch (E37.6), carried over to the task"),
  useSavedCards: z.boolean().describe("The chat's saved-cards switch (E37.7), carried over to the task"),
  recordVideo: z.boolean().describe("The chat's Record video switch (#906), carried over to the task"),
  parameters: z.array(taskParameterResponseSchema).describe("The goal's `{{Name}}` parameters the draft proposes (#556): amounts and dates asked every time, people and accounts defaulted from a memory or a value. Empty when nothing varies."),
  outputs: z.array(taskOutputResponseSchema).describe('The values a run of the task would return (E39.5), proposed from what the finished run reported (an amount paid, a confirmation number, a date). The owner reviews them in the task form. Empty when nothing is worth keeping.'),
  connections: z
    .array(z.object({ connectionId: z.uuid(), access: z.enum(['read', 'read_write']) }))
    .describe("E41.5: the chat's connections its runs actually used, at the access they needed (read and write when a run changed something through one). A proposal for the task form: nothing is listed on a task until the owner saves it. Empty when no run used one."),
});
export class ChatTaskDraftResponseDto extends createZodDto(chatTaskDraftResponseSchema) {}

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
  thinking: z.boolean().describe('True while the AI is working on its reply to the newest message'),
});
export class ChatDetailResponseDto extends createZodDto(chatDetailResponseSchema) {}
