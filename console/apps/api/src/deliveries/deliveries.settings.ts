// The deployment's caps on deliveries (E39.6, #603): system namespace `deliveries` (Administrator, `system_settings:write`).
//   maxRecipientsPerTask   different addresses over all the email deliveries of one task (default 10)
//   maxEmailsPerDay        messages one user's deliveries send in 24 hours (default 100)
//   maxAttachmentMb        the attachments of one console email; over it the email carries the link to the report instead (default 7)
// Registered before `SettingsModule.forRoot()` composes the request bodies (the import in src/platform/platform.ts).
import { registerSystemSettingsNamespaces, type SystemSettingsNamespace } from '@marinoscar/platform-api/settings';
import { z } from 'zod';

import { DEFAULT_MAX_ATTACHMENT_BYTES, DEFAULT_MAX_EMAILS_PER_DAY, DEFAULT_MAX_RECIPIENTS_PER_TASK } from './deliveries.constants';

export const deliveriesSystemSettingsSchema = z.object({
  maxRecipientsPerTask: z.number().int().min(1).max(100).optional(),
  maxEmailsPerDay: z.number().int().min(1).max(10_000).optional(),
  maxAttachmentMb: z.number().min(1).max(25).optional(),
});
export type DeliveriesSystemSettings = z.infer<typeof deliveriesSystemSettingsSchema>;

export interface ResolvedDeliveryLimits {
  maxRecipientsPerTask: number;
  maxEmailsPerDay: number;
  maxAttachmentBytes: number;
}

export const DELIVERY_LIMIT_DEFAULTS: ResolvedDeliveryLimits = {
  maxRecipientsPerTask: DEFAULT_MAX_RECIPIENTS_PER_TASK,
  maxEmailsPerDay: DEFAULT_MAX_EMAILS_PER_DAY,
  maxAttachmentBytes: DEFAULT_MAX_ATTACHMENT_BYTES,
};

export function resolveDeliveryLimits(v: DeliveriesSystemSettings | null | undefined): ResolvedDeliveryLimits {
  return {
    maxRecipientsPerTask: v?.maxRecipientsPerTask ?? DELIVERY_LIMIT_DEFAULTS.maxRecipientsPerTask,
    maxEmailsPerDay: v?.maxEmailsPerDay ?? DELIVERY_LIMIT_DEFAULTS.maxEmailsPerDay,
    maxAttachmentBytes: v?.maxAttachmentMb ? Math.round(v.maxAttachmentMb * 1024 * 1024) : DELIVERY_LIMIT_DEFAULTS.maxAttachmentBytes,
  };
}

export const DELIVERIES_SYSTEM_SETTINGS = {
  key: 'deliveries',
  description: 'Deliveries after a run: the most email addresses one task may use, the most emails one user sends a day, and the largest attachment of a console email.',
  storedSchema: deliveriesSystemSettingsSchema,
  patchSchema: deliveriesSystemSettingsSchema,
  putSchema: deliveriesSystemSettingsSchema,
  wirePatchSchema: deliveriesSystemSettingsSchema,
  responseSchema: deliveriesSystemSettingsSchema,
  defaults: { maxRecipientsPerTask: DEFAULT_MAX_RECIPIENTS_PER_TASK, maxEmailsPerDay: DEFAULT_MAX_EMAILS_PER_DAY, maxAttachmentMb: Math.round(DEFAULT_MAX_ATTACHMENT_BYTES / (1024 * 1024)) },
  requiredOnPut: false,
  // The platform calls every namespace's merge on every settings write: no patch for this one is the current value.
  merge: (current: DeliveriesSystemSettings | undefined, patch: DeliveriesSystemSettings | undefined): DeliveriesSystemSettings => ({ ...(current ?? {}), ...(patch ?? {}) }),
} satisfies SystemSettingsNamespace<'deliveries', DeliveriesSystemSettings, DeliveriesSystemSettings>;

registerSystemSettingsNamespaces([DELIVERIES_SYSTEM_SETTINGS as unknown as SystemSettingsNamespace]);

declare module '@marinoscar/platform-api/settings' {
  interface SystemSettingsNamespaces {
    deliveries: DeliveriesSystemSettings;
  }
}
