// E45.3 (#758): the `recordings` namespace of the SYSTEM settings document
// (Admin, `system_settings:write`): how long run recordings are kept, and how
// long one recording may be (docs/recordings.md). Registered before
// `SettingsModule.forRoot()` composes the request bodies (the import in
// src/platform/platform.ts).
import { registerSystemSettingsNamespaces, type SystemSettingsNamespace } from '@marinoscar/platform-api/settings';
import { z } from 'zod';

/** The most days a recording may be kept when a limit is set. */
export const RECORDINGS_MAX_KEEP_DAYS = 3650;
/** The longest one recording may be, in minutes. */
export const RECORDINGS_MAX_MINUTES = 480;

export const recordingsSettingsSchema = z.object({
  keepDays: z
    .number()
    .int()
    .min(1)
    .max(RECORDINGS_MAX_KEEP_DAYS)
    .nullable()
    .describe('Finished run recordings are deleted this many days after they were made. null keeps them indefinitely. Default 30.'),
  maxMinutes: z
    .number()
    .int()
    .min(1)
    .max(RECORDINGS_MAX_MINUTES)
    .describe('The longest one recording may be. The recorder stops at this length; the run goes on. Default 60.'),
});
export type RecordingsSettings = z.infer<typeof recordingsSettingsSchema>;
export const recordingsSettingsPatchSchema = recordingsSettingsSchema.partial();

export const RECORDINGS_SETTINGS_DEFAULTS: RecordingsSettings = { keepDays: 30, maxMinutes: 60 };

export const RECORDINGS_SYSTEM_SETTINGS = {
  key: 'recordings',
  description: 'Run recordings: how long they are kept (or indefinitely), and how long one may be.',
  storedSchema: recordingsSettingsSchema,
  patchSchema: recordingsSettingsPatchSchema,
  putSchema: recordingsSettingsSchema,
  wirePatchSchema: recordingsSettingsPatchSchema,
  responseSchema: recordingsSettingsSchema,
  defaults: RECORDINGS_SETTINGS_DEFAULTS,
  requiredOnPut: false,
  merge: (current, patch) => ({ ...RECORDINGS_SETTINGS_DEFAULTS, ...current, ...patch }),
} satisfies SystemSettingsNamespace<'recordings', RecordingsSettings, Partial<RecordingsSettings>>;

registerSystemSettingsNamespaces([RECORDINGS_SYSTEM_SETTINGS as unknown as SystemSettingsNamespace]);

declare module '@marinoscar/platform-api/settings' {
  interface SystemSettingsNamespaces {
    recordings: RecordingsSettings;
  }
}

/** A stored value, salvaged: a missing or malformed field takes its default (`keepDays: null` is a valid choice, kept as is). */
export function readRecordingsSettings(raw: unknown): RecordingsSettings {
  const r = (raw ?? {}) as Partial<Record<keyof RecordingsSettings, unknown>>;
  const pick = <K extends keyof RecordingsSettings>(k: K): RecordingsSettings[K] => {
    if (!(k in r)) return RECORDINGS_SETTINGS_DEFAULTS[k];
    const parsed = recordingsSettingsSchema.shape[k].safeParse(r[k]);
    return (parsed.success ? parsed.data : RECORDINGS_SETTINGS_DEFAULTS[k]) as RecordingsSettings[K];
  };
  return { keepDays: pick('keepDays'), maxMinutes: pick('maxMinutes') };
}

/** When a finished recording made at `createdAt` is deleted under `keepDays`; null while recordings are kept indefinitely. */
export function recordingExpiresAt(createdAt: Date, keepDays: number | null): Date | null {
  return keepDays === null ? null : new Date(createdAt.getTime() + keepDays * 86_400_000);
}
