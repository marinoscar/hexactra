// The shapes of deliveries (E39.6, #603): what the owner configures per kind (zod, strict: an unknown key is refused), the requests
// of the routes and what they answer. A delivery's recipients, destination and file name are fixed here, at setup: nothing in a run can
// add, change or redirect one (docs/deliveries.md).
import { createZodDto } from 'nestjs-zod';
import { z } from 'zod';

import { DELIVERY_ERROR_CODES, DELIVERY_KINDS, DELIVERY_WHEN, MAX_RECIPIENTS_PER_DELIVERY, RUN_DELIVERY_STATUSES, SUBJECT_MAX } from './deliveries.constants';
import { hasControl } from './delivery.templates';

const line = (max: number) =>
  z
    .string()
    .min(1)
    .max(max)
    .refine((v) => !hasControl(v), { message: 'must not contain line breaks or control characters' });
const address = z.email().max(254).describe('An email address.');
const connectionId = z.uuid().describe("One of the owner's connections (`GET /connections`).");

export const ATTACHMENT_SCREENSHOTS = ['none', 'final', 'all'] as const;
const files = z
  .object({
    pdf: z.boolean().default(true).describe("The run's PDF report (masked)."),
    json: z.boolean().default(false).describe("The run's JSON trace (masked)."),
    screenshots: z.enum(ATTACHMENT_SCREENSHOTS).default('none').describe('The masked step pictures: none, only the last one, or all of them.'),
  })
  .strict();

/** The fixed run fields a spreadsheet column can take besides an output. */
export const RUN_FIELDS = ['run_date', 'status', 'task', 'goal', 'result', 'run_link', 'report_link', 'cost', 'steps'] as const;
export type RunField = (typeof RUN_FIELDS)[number];

export const columnSourceSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('output'), key: z.string().regex(/^[a-z][a-z0-9_]{0,39}$/).describe("An output key of the task.") }).strict(),
  z.object({ kind: z.literal('field'), field: z.enum(RUN_FIELDS) }).strict(),
]);
export type ColumnSource = z.infer<typeof columnSourceSchema>;

export const MAX_SHEET_COLUMNS = 50;

// ----- per kind ---------------------------------------------------------------------------------------------------------

export const emailConfigSchema = z
  .object({
    via: z
      .union([z.literal('console'), z.object({ connectionId }).strict()])
      .default('console')
      .describe("`console`: the console's own email sender. `{ connectionId }`: sent from the owner's Gmail or Outlook account (needs `mail_send`)."),
    to: z.array(address).min(1).max(MAX_RECIPIENTS_PER_DELIVERY).describe('1 to 10 addresses. Fixed here: nothing in a run can add one.'),
    cc: z.array(address).max(MAX_RECIPIENTS_PER_DELIVERY).optional().describe('Sent as a copy through a connection; through the console each address gets its own message.'),
    subject: line(SUBJECT_MAX).optional().describe('A template: `{{task}}`, `{{date}}`, `{{status}}`, `{{output:<key>}}`. Default `{{task}}: {{status}} on {{date}}`.'),
    attach: files.default({ pdf: true, json: false, screenshots: 'none' }).describe('Attachments are always the masked files.'),
    includeOutputs: z.boolean().default(true).describe("Put the run's outputs in the message as a table."),
    includeSensitive: z.boolean().default(false).describe('Send outputs marked sensitive as they are. Off (the default): they read `[hidden]`.'),
  })
  .strict();

export const webhookConfigSchema = z
  .object({
    url: z.url().max(2000).describe('An https address (a private network address is refused). The body is signed with the delivery\'s secret (Standard Webhooks).'),
    includeOutputs: z.boolean().default(true),
    includeReportLink: z.boolean().default(true).describe('Add `reportUrl`: a signed link to the masked PDF, valid 7 days.'),
    includeSensitive: z.boolean().default(false),
  })
  .strict();

export const sheetRowConfigSchema = z
  .object({
    connectionId,
    fileId: z.string().min(1).max(512).refine((v) => !hasControl(v)).optional().describe('The spreadsheet. Omit with `createIfMissing` to have the first send create it.'),
    sheet: line(100).optional().describe('The tab; default the first.'),
    newTitle: line(255).optional().describe('The title of the spreadsheet `createIfMissing` creates; default the task name.'),
    columns: z
      .array(z.object({ header: line(100), value: columnSourceSchema }).strict())
      .min(1)
      .max(MAX_SHEET_COLUMNS)
      .describe('One cell per column, in order. A "Run ID" column is always added last: it is how a retry avoids a second row.'),
    createIfMissing: z.boolean().default(false),
    includeSensitive: z.boolean().default(false),
  })
  .strict()
  .refine((c) => c.fileId !== undefined || c.createIfMissing, { message: 'Give a fileId, or switch createIfMissing on', path: ['fileId'] });

export const folderConfigSchema = z
  .object({
    target: z
      .union([z.literal('storage'), z.object({ connectionId, folderId: z.string().min(1).max(512).refine((v) => !hasControl(v)) }).strict()])
      .describe("`storage`: the deployment's own object storage under your own prefix. Or a folder of one of your connections."),
    files: files,
    nameTemplate: line(120).default('{{task}} {{date}}').describe('The file name without its extension: `{{task}}`, `{{date}}`, `{{status}}`, `{{output:<key>}}`.'),
  })
  .strict();

export type EmailConfig = z.infer<typeof emailConfigSchema>;
export type WebhookConfig = z.infer<typeof webhookConfigSchema>;
export type SheetRowConfig = z.infer<typeof sheetRowConfigSchema>;
export type FolderConfig = z.infer<typeof folderConfigSchema>;
export type DeliveryConfig = EmailConfig | WebhookConfig | SheetRowConfig | FolderConfig;

export const CONFIG_SCHEMAS = { email: emailConfigSchema, webhook: webhookConfigSchema, sheet_row: sheetRowConfigSchema, folder: folderConfigSchema } as const;

// ----- requests ----------------------------------------------------------------------------------------------------------

const base = {
  enabled: z.boolean().optional().describe('Default true. A delivery with an address that is not yours or a connection\'s needs that address confirmed before it can be on.'),
  when: z.enum(DELIVERY_WHEN).optional().describe('`always` (default), `succeeded`, `failed`, or `needs_attention` (failed, outputs missing, or a confirmed step without success).'),
  position: z.number().int().min(0).max(1000).optional(),
};

/**
 * The request. `config` is validated against the schema of its `kind` by the service (400 `INVALID_DELIVERY` with a path per problem):
 * `email` { via, to, cc?, subject?, attach, includeOutputs, includeSensitive }, `webhook` { url, includeOutputs, includeReportLink,
 * includeSensitive }, `sheet_row` { connectionId, fileId?, sheet?, newTitle?, columns, createIfMissing, includeSensitive }, `folder` { target, files, nameTemplate }.
 */
export const createDeliverySchema = z
  .object({
    kind: z.enum(DELIVERY_KINDS),
    config: z.record(z.string(), z.unknown()).describe('The configuration of the kind (see the description of this route).'),
    ...base,
  })
  .strict();
export class CreateDeliveryDto extends createZodDto(createDeliverySchema) {}
export type CreateDelivery = z.infer<typeof createDeliverySchema>;

/** A patch: the kind never changes. `config` is the whole new config for the stored kind (validated against it). */
export const updateDeliverySchema = z
  .object({ ...base, config: z.record(z.string(), z.unknown()).optional().describe("The whole new config for the delivery's kind.") })
  .strict();
export class UpdateDeliveryDto extends createZodDto(updateDeliverySchema) {}

export const confirmRecipientSchema = z.object({ address }).strict();
export class ConfirmRecipientDto extends createZodDto(confirmRecipientSchema) {}

export const runDeliveryRetrySchema = z.object({}).strict();

// ----- responses ---------------------------------------------------------------------------------------------------------

const iso = z.string().describe('An ISO 8601 instant.');

/** How a recipient stands: yours, confirmed by you, waiting for your confirmation, or having stopped the emails. */
export const RECIPIENT_STATES = ['own', 'confirmed', 'unconfirmed', 'unsubscribed'] as const;
export const recipientViewSchema = z.object({ address: z.string(), state: z.enum(RECIPIENT_STATES) });

export const deliveryResponseSchema = z.object({
  id: z.uuid(),
  taskId: z.uuid(),
  kind: z.enum(DELIVERY_KINDS),
  enabled: z.boolean(),
  when: z.enum(DELIVERY_WHEN),
  position: z.number().int(),
  config: z.record(z.string(), z.unknown()).describe('The configuration as stored. Never a secret.'),
  recipients: z.array(recipientViewSchema).describe('`email`: where each address stands. Empty for other kinds.'),
  connection: z.object({ id: z.uuid(), label: z.string().nullable() }).nullable().describe('The connection it uses; `label` is null once the connection was removed.'),
  disabledReason: z.enum(['connection_removed']).nullable().describe('Why the system switched it off.'),
  webhookSecretConfigured: z.boolean().nullable().describe('`webhook`: a signing secret is stored. Null for other kinds.'),
  createdAt: iso,
  updatedAt: iso,
});
export class DeliveryResponseDto extends createZodDto(deliveryResponseSchema) {}

export const deliveryCreatedResponseSchema = deliveryResponseSchema.extend({
  signingSecret: z.string().nullable().describe('`webhook` only, only on creation: the secret to verify the signature with (`whsec_...`). It cannot be read again.'),
});
export class DeliveryCreatedResponseDto extends createZodDto(deliveryCreatedResponseSchema) {}

export const deliveryTestResponseSchema = z.object({
  ok: z.boolean(),
  code: z.enum(DELIVERY_ERROR_CODES).nullable(),
  message: z.string().describe('One fixed sentence.'),
  detail: z.record(z.string(), z.unknown()).describe('Safe facts: sizes, counts, and for a sheet the `location` of the TEST row.'),
});
export class DeliveryTestResponseDto extends createZodDto(deliveryTestResponseSchema) {}

export const runDeliveryResponseSchema = z.object({
  id: z.uuid(),
  runId: z.uuid(),
  deliveryId: z.uuid().nullable().describe('Null once the delivery was deleted: the log stays.'),
  kind: z.enum(DELIVERY_KINDS),
  status: z.enum(RUN_DELIVERY_STATUSES),
  attempts: z.number().int(),
  errorCode: z.enum(DELIVERY_ERROR_CODES).nullable(),
  errorText: z.string().nullable().describe('A fixed sentence for the code.'),
  detail: z.record(z.string(), z.unknown()).describe('Safe facts only: the destination, sizes, counts. Never content.'),
  sentAt: iso.nullable(),
  nextAttemptAt: iso.nullable(),
  createdAt: iso,
});
export class RunDeliveryResponseDto extends createZodDto(runDeliveryResponseSchema) {}

export const deliveryRecipientResponseSchema = z.object({ address: z.string(), confirmedAt: iso, unsubscribedAt: iso.nullable() });
export class DeliveryRecipientResponseDto extends createZodDto(deliveryRecipientResponseSchema) {}

/** `run_status` and the run page: counts by status. */
export const deliverySummarySchema = z.object({ total: z.number().int(), pending: z.number().int(), sending: z.number().int(), sent: z.number().int(), failed: z.number().int(), skipped: z.number().int() });
export type DeliverySummary = z.infer<typeof deliverySummarySchema>;
