import { registerUserSettingsNamespaces, type UserSettingsNamespace } from '@marinoscar/platform-api/settings';
import { z } from 'zod';

/** A model of the AI catalogue as `provider:modelId`; null is "my default model". */
const helperModel = z
  .string()
  .trim()
  .min(3)
  .max(200)
  .regex(/^[A-Za-z0-9][A-Za-z0-9._-]*:[A-Za-z0-9][A-Za-z0-9._:/-]*$/, 'A model as provider:model')
  .nullable();

/**
 * The `aiHelpers` namespace of a USER's settings document (E55.1, #1094): the
 * models the owner picks for the helpers around the agent, which are not
 * browser-agent calls and so are outside the model tiers.
 *
 * - `titleModel` writes the short titles of runs and chats.
 * - `taskModel` creates and improves tasks: the task builder, the chat's task
 *   draft and "Improve this task".
 *
 * Null (the default) is the owner's default AI model, as before this setting.
 * A pick that can no longer be used falls back to the default model
 * (helper-models.ts); it never fails a feature. Registered before
 * `SettingsModule.forRoot()` (the import in src/platform/platform.ts).
 */
export const aiHelpersSettingsSchema = z.object({
  titleModel: helperModel.describe('The model that writes short titles for runs and chats. Null uses your default model.'),
  taskModel: helperModel.describe('The model that creates and improves tasks. Null uses your default model.'),
  runTitles: z.boolean().describe('Write a short title for each run. On by default.'),
  chatTitles: z.boolean().describe('Write a short title for each chat. On by default.'),
});
export type AiHelpersSettings = z.infer<typeof aiHelpersSettingsSchema>;
export const aiHelpersSettingsPatchSchema = aiHelpersSettingsSchema.partial();
export type AiHelpersSettingsPatch = z.infer<typeof aiHelpersSettingsPatchSchema>;

export const AI_HELPERS_DEFAULTS: AiHelpersSettings = { titleModel: null, taskModel: null, runTitles: true, chatTitles: true };

/** The namespace as stored in a user's settings document, with the defaults for what was never saved. */
export function aiHelpersSettingsOf(doc: unknown): AiHelpersSettings {
  const raw = (doc as { aiHelpers?: unknown } | null | undefined)?.aiHelpers;
  const parsed = aiHelpersSettingsPatchSchema.safeParse(raw ?? {});
  return { ...AI_HELPERS_DEFAULTS, ...(parsed.success ? parsed.data : {}) };
}

export const AI_HELPERS_USER_SETTINGS = {
  key: 'aiHelpers',
  description: 'Helper models: the model that writes titles, and the model that creates and improves tasks.',
  schema: aiHelpersSettingsSchema,
  patchSchema: aiHelpersSettingsPatchSchema,
  merge: (current: AiHelpersSettings | undefined, patch: AiHelpersSettingsPatch | null | undefined): AiHelpersSettings | undefined => {
    if (patch === null) return undefined;
    if (patch === undefined) return current;
    return { ...AI_HELPERS_DEFAULTS, ...current, ...patch };
  },
} satisfies UserSettingsNamespace<'aiHelpers', AiHelpersSettings, AiHelpersSettingsPatch>;

registerUserSettingsNamespaces([AI_HELPERS_USER_SETTINGS as unknown as UserSettingsNamespace]);

declare module '@marinoscar/platform-api/settings' {
  interface UserSettingsNamespaces {
    aiHelpers: AiHelpersSettings;
  }
}
