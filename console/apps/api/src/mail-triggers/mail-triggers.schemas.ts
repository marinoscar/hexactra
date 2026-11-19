// Request and response shapes of the mail trigger routes (E39.8, #605). A response carries ids, rules, counts and codes; there is no
// field that can hold the subject, the sender, a snippet or the body of a message except the preview, which is cut and masked.
import { createZodDto } from 'nestjs-zod';
import { z } from 'zod';

import { mailInputsSchema } from './mail-inputs';
import { mailMatchSchema } from './mail-match';
import { MAIL_TRIGGER_OUTCOMES, MAIL_TRIGGER_STATUSES, MAX_RUNS_PER_DAY_CEILING } from './mail-triggers.constants';

const iso = z.string().describe('ISO 8601 timestamp');
const afterStart = z
  .string()
  .regex(/^(none|mark_read|add_label:[^\s\u0000-\u001f]{1,60})$/, '`none`, `mark_read` or `add_label:<label id>`')
  .describe('What happens to the message after a run was queued: `none`, `mark_read` or `add_label:<label id>`. The last two need the connection\'s `mail_modify` switch.');
const name = z.string().trim().min(1).max(120);
const pollSeconds = z.number().int().min(60).max(86_400).describe('How often to look for mail, in seconds: 300 by default, never under the deployment minimum (60 unless the administrator raised it).');
const maxRunsPerDay = z.number().int().min(1).max(MAX_RUNS_PER_DAY_CEILING).describe('The most runs this trigger starts in a UTC day (10 by default). The owner\'s own daily cap across triggers also applies.');

export const createMailTriggerSchema = z
  .object({
    name: name.optional().describe('Defaults to the first sender.'),
    connectionId: z.uuid().describe('The connected account whose mailbox is watched (needs `mail_read`).'),
    match: mailMatchSchema,
    inputs: mailInputsSchema.nullable().optional().describe("How the task's parameters get values from the message: `{ [key]: { fixed } | { header: 'subject'|'from'|'date' } | { capture: { source: 'subject'|'text', pattern } } }`. The message text is never pasted into the goal."),
    afterStart: afterStart.optional(),
    pollSeconds: pollSeconds.optional(),
    maxRunsPerDay: maxRunsPerDay.optional(),
    enabled: z.boolean().optional(),
  })
  .strict();
export class CreateMailTriggerDto extends createZodDto(createMailTriggerSchema) {}

// No defaults here (zod 4 applies `.default()` inside `.partial()`): a field left out is unchanged.
export const updateMailTriggerSchema = z
  .object({
    name: name.optional(),
    connectionId: z.uuid().optional(),
    match: mailMatchSchema.optional(),
    inputs: mailInputsSchema.nullable().optional(),
    afterStart: afterStart.optional(),
    pollSeconds: pollSeconds.optional(),
    maxRunsPerDay: maxRunsPerDay.optional(),
    enabled: z.boolean().optional().describe('Enabling again starts from now: mail that arrived while it was off never fires.'),
  })
  .strict();
export class UpdateMailTriggerDto extends createZodDto(updateMailTriggerSchema) {}

export const mailTriggerEventsQuerySchema = z.object({
  limit: z.coerce.number().int().min(1).max(100).default(30),
  before: z.string().max(40).optional().describe('An ISO instant: only events before it (the previous page ends here).'),
});
export class MailTriggerEventsQueryDto extends createZodDto(mailTriggerEventsQuerySchema) {}

export const mailTriggerResponseSchema = z.object({
  id: z.uuid(),
  taskId: z.uuid(),
  connectionId: z.uuid(),
  connectionLabel: z.string().nullable().describe('Null when the connection was removed.'),
  name: z.string(),
  enabled: z.boolean(),
  match: z.object({ from: z.array(z.string()), to: z.string().optional(), subjectContains: z.string().optional(), textContains: z.string().optional(), hasAttachment: z.boolean().optional(), label: z.string().optional() }),
  inputs: z.record(z.string(), z.unknown()).nullable(),
  afterStart: z.string(),
  pollSeconds: z.number().int(),
  maxRunsPerDay: z.number().int(),
  status: z.enum(MAIL_TRIGGER_STATUSES),
  statusReason: z.string().nullable(),
  lastCheckedAt: iso.nullable(),
  lastMatchedAt: iso.nullable(),
  runsToday: z.number().int().describe('Runs this trigger started since 00:00 UTC.'),
  createdAt: iso,
  updatedAt: iso,
});
export class MailTriggerResponseDto extends createZodDto(mailTriggerResponseSchema) {}

export const mailTriggerEventResponseSchema = z.object({
  id: z.uuid(),
  outcome: z.enum(MAIL_TRIGGER_OUTCOMES),
  reason: z.string().nullable().describe('`SENDER_NOT_VERIFIED`, `TRIGGER_DAILY_LIMIT`, `USER_DAILY_LIMIT`, `OWN_MESSAGE`, `START_FAILED`.'),
  runId: z.uuid().nullable(),
  messageAt: iso.nullable(),
  createdAt: iso,
});
export class MailTriggerEventResponseDto extends createZodDto(mailTriggerEventResponseSchema) {}

export const mailTriggerTestResponseSchema = z.object({
  messages: z
    .array(
      z.object({
        date: iso.nullable(),
        subject: z.string().describe('The first 60 characters of the subject.'),
        from: z.string().nullable(),
        wouldStart: z.boolean().describe('False when it arrived before the trigger was enabled, came from the account itself, or failed the sender check.'),
        reason: z.enum(['before_enabled', 'own_message', 'sender_not_verified']).nullable(),
        senderVerified: z.enum(['pass', 'fail', 'unknown']),
      }),
    )
    .describe('Up to the last 5 messages that match the rules. Nothing is started.'),
  note: z.string().nullable(),
});
export class MailTriggerTestResponseDto extends createZodDto(mailTriggerTestResponseSchema) {}
export type MailTriggerTestResult = z.infer<typeof mailTriggerTestResponseSchema>;
