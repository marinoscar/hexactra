import { createZodDto } from 'nestjs-zod';
import { z } from 'zod';

export const SKILL_NAME_MAX = 60;
export const SKILL_DESCRIPTION_MAX = 200;
export const SKILL_BODY_MAX = 4000;
export const SKILL_SITES_MAX = 10;
/** Skills one owner may keep (active and archived). */
export const MAX_SKILLS = 100;

/**
 * Removes control and invisible characters (#1008): C0/C1 controls, zero-width and bidirectional marks, the BOM. A line break and a tab
 * are kept where `keepLines` (the text of a skill); a name and a description are one line.
 */
export function cleanText(value: string, keepLines = false): string {
  const noInvisible = value.replace(/[​-‏‪-‮⁠-⁤⁦-⁯﻿­]/g, '');
  const normalised = noInvisible.replace(/\r\n?/g, '\n');
  // eslint-disable-next-line no-control-regex
  const noControl = keepLines ? normalised.replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F-\u009F]/g, '') : normalised.replace(/[\u0000-\u001F\u007F-\u009F]+/g, ' ');
  return keepLines ? noControl.trim() : noControl.replace(/\s+/g, ' ').trim();
}

const name = z
  .string()
  .transform((v) => cleanText(v))
  .pipe(z.string().min(1).max(SKILL_NAME_MAX))
  .describe('What you call it: "Google Messages". 1 to 60 characters, unique among your skills ignoring case.');
const description = z
  .string()
  .transform((v) => cleanText(v))
  .pipe(z.string().min(1).max(SKILL_DESCRIPTION_MAX))
  .describe('When to use it: "How I send text messages from Google Messages on the web". 1 to 200 characters. The agent is shown it, not the text.');
const body = z
  .string()
  .transform((v) => cleanText(v, true))
  .pipe(z.string().min(1).max(SKILL_BODY_MAX))
  .describe('The guidance, plain text or Markdown, 1 to 4,000 characters. Never a password, a code, a token or a full card, account or Social Security number.');
const sites = z
  .array(z.string().trim().min(1).max(253))
  .max(SKILL_SITES_MAX)
  .describe('Registrable domains the skill is about ("google.com"), at most 10. A host or an address is stored as its registrable domain; anything else is refused with `INVALID_SITE`.');
const enabled = z.boolean().describe('Off: the skill is kept but not offered to a run or a chat.');

/** A new skill. `userId`, `useCount` and the dates are never accepted from a body (`strict`). */
export const createSkillSchema = z.object({ name, description, body, sites: sites.default([]), enabled: enabled.default(true) }).strict();
export class CreateSkillDto extends createZodDto(createSkillSchema) {}
export type CreateSkillInput = z.infer<typeof createSkillSchema>;

export const updateSkillSchema = z
  .object({ name: name.optional(), description: description.optional(), body: body.optional(), sites: sites.optional(), enabled: enabled.optional() })
  .strict()
  .refine((p) => Object.keys(p).length > 0, { message: 'Nothing to update' });
export class UpdateSkillDto extends createZodDto(updateSkillSchema) {}
export type UpdateSkillInput = z.infer<typeof updateSkillSchema>;

export const listSkillsQuerySchema = z.object({
  q: z.string().trim().max(200).optional().describe('Searches the name, the description and the sites, ignoring case.'),
  archived: z
    .enum(['true', 'false', 'all'])
    .default('false')
    .describe('`false` (the default): the skills in use; `true`: the archived ones; `all`: both.'),
});
export class ListSkillsQueryDto extends createZodDto(listSkillsQuerySchema) {}

// ---- Responses (OpenAPI) ----

const iso = z.string().describe('ISO 8601 timestamp');

export const skillResponseSchema = z.object({
  id: z.uuid(),
  name: z.string(),
  description: z.string(),
  body: z.string().describe('The guidance. Only its owner reads it here; a run reads it through `skill_read`, and it is never kept in a step.'),
  sites: z.array(z.string()),
  enabled: z.boolean(),
  archivedAt: iso.nullable(),
  lastUsedAt: iso.nullable().describe('When a run last read it.'),
  useCount: z.number().int().describe('How many runs read it.'),
  createdAt: iso,
  updatedAt: iso,
});
export class SkillResponseDto extends createZodDto(skillResponseSchema) {}
