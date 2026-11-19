import { createZodDto } from 'nestjs-zod';
import { z } from 'zod';

/** The kinds of fact a memory holds. */
export const MEMORY_KINDS = ['person', 'account', 'preference', 'fact'] as const;
export const MEMORY_STATUSES = ['active', 'superseded', 'archived'] as const;
export const MEMORY_SOURCES = ['owner', 'agent_proposed'] as const;
export type MemoryKindName = (typeof MEMORY_KINDS)[number];

export const MAX_ALIASES = 10;
export const MAX_ATTRIBUTES = 20;
export const MAX_ATTRIBUTE_VALUE = 500;
export const MAX_ATTRIBUTE_KEY = 60;
/** Active memories one user may keep. */
export const MAX_ACTIVE_MEMORIES = 500;

const kind = z.enum(MEMORY_KINDS).describe('`person`, `account`, `preference` or `fact`.');
const label = z.string().trim().min(1).max(120).describe('What you call it: "My wife", "Checking account". Unique among your active memories, ignoring case.');
const aliases = z
  .array(z.string().trim().min(1).max(60))
  .max(MAX_ALIASES)
  .transform((list) => [...new Set(list.map((a) => a.toLowerCase().replace(/\s+/g, ' ')))])
  .describe('Other words that mean the same ("wife", "paula"). Stored lower-cased; at most 10.');
const attributes = z
  .record(z.string().trim().min(1).max(MAX_ATTRIBUTE_KEY), z.string().trim().min(1).max(MAX_ATTRIBUTE_VALUE))
  .refine((r) => Object.keys(r).length <= MAX_ATTRIBUTES, { message: `At most ${MAX_ATTRIBUTES} attributes` })
  .describe('Named values: `{ "name": "…", "phone": "…" }`. At most 20 keys, 500 characters a value. Never a password, a code or a full card, account or Social Security number: keep the last four digits.');
const note = z.string().trim().max(1000).nullable().describe('Free text you add. At most 1000 characters. Shown as plain text.');

/** A new memory. `source`, `status`, `userId` and the source ids are never accepted from a body (`strict`). */
export const createMemorySchema = z
  .object({
    kind,
    label,
    aliases: aliases.optional(),
    attributes: attributes.default({}),
    note: note.optional(),
  })
  .strict();
export class CreateMemoryDto extends createZodDto(createMemorySchema) {}
export type CreateMemoryInput = z.infer<typeof createMemorySchema>;

/** Label, aliases, note and kind. A value changes through `supersede`, which keeps the history. */
export const updateMemorySchema = z
  .object({ kind: kind.optional(), label: label.optional(), aliases: aliases.optional(), note: note.optional() })
  .strict()
  .refine((p) => Object.keys(p).length > 0, { message: 'Nothing to update' });
export class UpdateMemoryDto extends createZodDto(updateMemorySchema) {}
export type UpdateMemoryInput = z.infer<typeof updateMemorySchema>;

/** The new version's values; label, aliases, note and kind default to the old version's. */
export const supersedeMemorySchema = z
  .object({ attributes, kind: kind.optional(), label: label.optional(), aliases: aliases.optional(), note: note.optional() })
  .strict();
export class SupersedeMemoryDto extends createZodDto(supersedeMemorySchema) {}
export type SupersedeMemoryInput = z.infer<typeof supersedeMemorySchema>;

export const listMemoriesQuerySchema = z.object({
  kind: kind.optional(),
  status: z.enum([...MEMORY_STATUSES, 'all'] as const).default('active').describe('`active` (the default), `superseded`, `archived` or `all`.'),
  q: z.string().trim().max(200).optional().describe('Searches the label, the aliases and the attribute values, ignoring case.'),
});
export class ListMemoriesQueryDto extends createZodDto(listMemoriesQuerySchema) {}

// ---- Responses (OpenAPI) ----

const iso = z.string().describe('ISO 8601 timestamp');

export const memoryResponseSchema = z.object({
  id: z.uuid(),
  kind,
  label: z.string(),
  aliases: z.array(z.string()),
  attributes: z.record(z.string(), z.string()),
  note: z.string().nullable(),
  status: z.enum(MEMORY_STATUSES),
  source: z.enum(MEMORY_SOURCES).describe('`owner`: you typed it. `agent_proposed`: the agent suggested it and you approved it.'),
  sourceRunId: z.uuid().nullable().describe('The run an agent-proposed memory came from; the run may have been deleted since.'),
  sourceConversationId: z.uuid().nullable().describe('The chat an agent-proposed memory came from; it may have been deleted since.'),
  supersededById: z.uuid().nullable().describe('The newer version, for a superseded memory.'),
  lastUsedAt: iso.nullable(),
  createdAt: iso,
  updatedAt: iso,
});
export class MemoryResponseDto extends createZodDto(memoryResponseSchema) {}

export const memoryDetailResponseSchema = memoryResponseSchema.extend({
  history: z.array(memoryResponseSchema).describe('The older versions this one replaced, newest first.'),
});
export class MemoryDetailResponseDto extends createZodDto(memoryDetailResponseSchema) {}
