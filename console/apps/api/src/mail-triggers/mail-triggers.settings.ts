// The deployment-wide limits of mail triggers (E39.8, #605), system settings namespace `mailTriggers` (Administrator,
// `system_settings:write`; the API and the CLI set them, there is no page for them yet):
//   minPollSeconds        no trigger polls more often than this (60 default, the issue's minimum)
//   maxTriggersPerUser    how many triggers one user may have (20)
//   maxRunsPerUserPerDay  runs all of one user's triggers may start per UTC day (50)
// Registered before `SettingsModule.forRoot()` composes the request bodies (the import in src/platform/platform.ts).
import { registerSystemSettingsNamespaces, type SystemSettingsNamespace } from '@marinoscar/platform-api/settings';
import { z } from 'zod';

import { DEFAULT_MAIL_TRIGGER_LIMITS, type MailTriggerLimits } from './mail-triggers.constants';

export const mailTriggersSettingsSchema = z.object({
  minPollSeconds: z.number().int().min(60).max(86_400).optional(),
  maxTriggersPerUser: z.number().int().min(1).max(200).optional(),
  maxRunsPerUserPerDay: z.number().int().min(1).max(1000).optional(),
});
export type MailTriggersSettings = z.infer<typeof mailTriggersSettingsSchema>;

export function resolveMailTriggerLimits(v: MailTriggersSettings | null | undefined): MailTriggerLimits {
  return {
    minPollSeconds: v?.minPollSeconds ?? DEFAULT_MAIL_TRIGGER_LIMITS.minPollSeconds,
    maxTriggersPerUser: v?.maxTriggersPerUser ?? DEFAULT_MAIL_TRIGGER_LIMITS.maxTriggersPerUser,
    maxRunsPerUserPerDay: v?.maxRunsPerUserPerDay ?? DEFAULT_MAIL_TRIGGER_LIMITS.maxRunsPerUserPerDay,
  };
}

export const MAIL_TRIGGERS_SYSTEM_SETTINGS = {
  key: 'mailTriggers',
  description: 'Email triggers: the fastest a trigger may poll (seconds), how many triggers one user may have, and how many runs one user\'s triggers may start per day.',
  storedSchema: mailTriggersSettingsSchema,
  patchSchema: mailTriggersSettingsSchema,
  putSchema: mailTriggersSettingsSchema,
  wirePatchSchema: mailTriggersSettingsSchema,
  responseSchema: mailTriggersSettingsSchema,
  defaults: { ...DEFAULT_MAIL_TRIGGER_LIMITS },
  requiredOnPut: false,
  // The platform calls every namespace's merge on every settings write: no patch for this one is the current value.
  merge: (current, patch) => resolveMailTriggerLimits({ ...(current as MailTriggersSettings | undefined), ...(patch as MailTriggersSettings | undefined) }),
} satisfies SystemSettingsNamespace<'mailTriggers', MailTriggersSettings, MailTriggersSettings>;

registerSystemSettingsNamespaces([MAIL_TRIGGERS_SYSTEM_SETTINGS as unknown as SystemSettingsNamespace]);

declare module '@marinoscar/platform-api/settings' {
  interface SystemSettingsNamespaces {
    mailTriggers: MailTriggersSettings;
  }
}
