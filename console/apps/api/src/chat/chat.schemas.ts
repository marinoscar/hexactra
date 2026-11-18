// The chat routes' inputs (#483). A chat's run settings (profile, machine,
// agent policy) mean what they mean on a task (tasks.schemas.ts).
import { createZodDto } from 'nestjs-zod';
import { z } from 'zod';

import { policyRefSchema } from '../policies/policies.schemas';
import { domainSchema } from '../tasks/tasks.schemas';

export const CHAT_STATUSES = ['active', 'archived'] as const;
export const CHAT_TITLE_MAX = 200;
export const CHAT_MESSAGE_MAX = 8000;
export const CHATS_PAGE_MAX = 100;
/** The most messages one read returns; a longer thread is read in increments with `afterSeq`. */
export const CHAT_MESSAGES_MAX = 500;

const title = z.string().trim().max(CHAT_TITLE_MAX);
const runSettings = {
  profile: z.string().trim().min(1).max(32).describe('The browser profile the chat\'s runs use.'),
  hostId: z.uuid().nullable().describe('The machine the chat\'s runs prefer; `null` lets the console choose.'),
  hostFallback: z.boolean().describe('Whether a run may use another machine when the preferred one is offline.'),
  policyId: policyRefSchema.nullable().describe("The agent policy of the chat's runs: an own policy's UUID or `builtin:<key>`. `null` follows the user's default policy."),
  allowedDomains: z.array(domainSchema).max(50).describe("Sites the chat's runs may visit, as on a task; empty (the default) is any site."),
  confirmRiskyActions: z.boolean().describe('Ask the owner before a purchase or another step that is hard to undo. On by default in a chat.'),
};

/** `GET /chats`. */
export const listChatsSchema = z.object({
  status: z.enum(CHAT_STATUSES).default('active').describe('`active` (the default) or `archived`.'),
  cursor: z.string().min(1).max(400).optional().describe("The previous page's `nextCursor`. Opaque: do not parse or build it."),
  limit: z.coerce.number().int().min(1).max(CHATS_PAGE_MAX).default(30).describe(`Rows to return: 1 to ${CHATS_PAGE_MAX}. Default 30.`),
});

/** `POST /chats`: every field optional; the title comes from the first message when it is absent. */
export const createChatSchema = z.object({
  title: title.optional(),
  profile: runSettings.profile.optional(),
  hostId: runSettings.hostId.optional(),
  hostFallback: runSettings.hostFallback.optional(),
  policyId: runSettings.policyId.optional(),
  allowedDomains: runSettings.allowedDomains.optional(),
  confirmRiskyActions: runSettings.confirmRiskyActions.optional(),
});

/** `PATCH /chats/:id`: at least one field. `status` archives and unarchives. */
export const updateChatSchema = z
  .object({
    title: title.min(1).optional(),
    status: z.enum(CHAT_STATUSES).optional(),
    profile: runSettings.profile.optional(),
    hostId: runSettings.hostId.optional(),
    hostFallback: runSettings.hostFallback.optional(),
    policyId: runSettings.policyId.optional(),
  allowedDomains: runSettings.allowedDomains.optional(),
  confirmRiskyActions: runSettings.confirmRiskyActions.optional(),
  })
  .refine((patch) => Object.keys(patch).length > 0, { message: 'Nothing to update' });

/** `GET /chats/:id`. */
export const getChatSchema = z.object({
  afterSeq: z.coerce.number().int().min(0).default(0).describe('Only messages with a `seq` greater than this: `0` (the default) is the whole thread.'),
});

/** `POST /chats/:id/messages`. */
export const postMessageSchema = z.object({
  text: z.string().trim().min(1).max(CHAT_MESSAGE_MAX).describe('What the owner wrote. Never a password or a code: the agent asks for those through a request.'),
});

/** `POST /chats/:id/task-link`: the task that was saved from the chat. */
export const linkTaskSchema = z.object({
  taskId: z.uuid().describe('A task of the caller, saved from this chat.'),
});

export class LinkTaskDto extends createZodDto(linkTaskSchema) {}
export class ListChatsDto extends createZodDto(listChatsSchema) {}
export class CreateChatDto extends createZodDto(createChatSchema) {}
export class UpdateChatDto extends createZodDto(updateChatSchema) {}
export class GetChatDto extends createZodDto(getChatSchema) {}
export class PostMessageDto extends createZodDto(postMessageSchema) {}
