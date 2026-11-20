// E40.4 (#688): the `questions` namespace of the SYSTEM settings document
// (Admin, `system_settings:write`): how long request history is kept, and how
// long a question waits for an answer when its asker set no time. Registered
// before `SettingsModule.forRoot()` composes the request bodies (the import in
// src/platform/platform.ts).
import { registerSystemSettingsNamespaces, type SystemSettingsNamespace } from '@marinoscar/platform-api/settings';
import { z } from 'zod';

/** The most days request history may be kept. */
export const HISTORY_MAX_DAYS = 3650;
/** The longest default wait, in minutes: a question's own limit (24 h, `QUESTION_TIMEOUT.maxMs`). */
export const DEFAULT_WAIT_MAX_MINUTES = 24 * 60;

export const questionsSettingsSchema = z.object({
  historyKeepDays: z
    .number()
    .int()
    .min(1)
    .max(HISTORY_MAX_DAYS)
    .describe('Answered, declined and expired requests (and their record in a chat) are deleted this many days after they ended. A request still waiting is never deleted. Default 7.'),
  defaultWaitMinutes: z
    .number()
    .int()
    .min(1)
    .max(DEFAULT_WAIT_MAX_MINUTES)
    .describe('How long a question waits for an answer when the agent or the caller set no time. Then it expires and the run goes on without it. Default 60. Approvals of a connected account and the details to start a task keep 24 hours.'),
});
export type QuestionsSettings = z.infer<typeof questionsSettingsSchema>;
export const questionsSettingsPatchSchema = questionsSettingsSchema.partial();

export const QUESTIONS_SETTINGS_DEFAULTS: QuestionsSettings = { historyKeepDays: 7, defaultWaitMinutes: 60 };

export const QUESTIONS_SYSTEM_SETTINGS = {
  key: 'questions',
  description: 'Requests to the owner: how long their history is kept, and how long a question waits for an answer.',
  storedSchema: questionsSettingsSchema,
  patchSchema: questionsSettingsPatchSchema,
  putSchema: questionsSettingsSchema,
  wirePatchSchema: questionsSettingsPatchSchema,
  responseSchema: questionsSettingsSchema,
  defaults: QUESTIONS_SETTINGS_DEFAULTS,
  requiredOnPut: false,
  merge: (current, patch) => ({ ...QUESTIONS_SETTINGS_DEFAULTS, ...current, ...patch }),
} satisfies SystemSettingsNamespace<'questions', QuestionsSettings, Partial<QuestionsSettings>>;

registerSystemSettingsNamespaces([QUESTIONS_SYSTEM_SETTINGS as unknown as SystemSettingsNamespace]);

declare module '@marinoscar/platform-api/settings' {
  interface SystemSettingsNamespaces {
    questions: QuestionsSettings;
  }
}

/** A stored value, salvaged: a missing or malformed field takes its default. */
export function readQuestionsSettings(raw: unknown): QuestionsSettings {
  const r = (raw ?? {}) as Partial<Record<keyof QuestionsSettings, unknown>>;
  const pick = <K extends keyof QuestionsSettings>(k: K): QuestionsSettings[K] => {
    const parsed = questionsSettingsSchema.shape[k].safeParse(r[k]);
    return (parsed.success ? parsed.data : QUESTIONS_SETTINGS_DEFAULTS[k]) as QuestionsSettings[K];
  };
  return { historyKeepDays: pick('historyKeepDays'), defaultWaitMinutes: pick('defaultWaitMinutes') };
}
