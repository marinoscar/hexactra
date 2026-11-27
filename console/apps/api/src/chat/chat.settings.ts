import { registerUserSettingsNamespaces, type UserSettingsNamespace } from '@marinoscar/platform-api/settings';
import { z } from 'zod';

/**
 * The `chat` namespace of a USER's settings document (E51.2, #1007): whether
 * the chat reads the owner's saved tasks and runs one when it fits ("Use my
 * saved tasks when one fits", on by default). Off, the chat's input has no
 * task block, it is offered no `list_tasks` and its instructions keep the
 * line from before #1007: the owner can still name a task. Registered before
 * `SettingsModule.forRoot()` composes the request bodies (the import in
 * src/platform/platform.ts), so `GET/PATCH /api/user-settings` carry it.
 */
export const chatSettingsSchema = z.object({
  useSavedTasks: z.boolean().describe('Let the chat use one of your saved tasks when it does what you ask. On by default.'),
});
export type ChatSettings = z.infer<typeof chatSettingsSchema>;
export const chatSettingsPatchSchema = chatSettingsSchema.partial();
export type ChatSettingsPatch = z.infer<typeof chatSettingsPatchSchema>;

export const CHAT_SETTINGS_DEFAULTS: ChatSettings = { useSavedTasks: true };

/** The namespace as stored in a user's settings document, with the defaults for what was never saved. */
export function chatSettingsOf(doc: unknown): ChatSettings {
  const raw = (doc as { chat?: unknown } | null | undefined)?.chat;
  const parsed = chatSettingsPatchSchema.safeParse(raw ?? {});
  return { ...CHAT_SETTINGS_DEFAULTS, ...(parsed.success ? parsed.data : {}) };
}

export const CHAT_USER_SETTINGS = {
  key: 'chat',
  description: 'Chat: whether the chat may use your saved tasks when one fits.',
  schema: chatSettingsSchema,
  patchSchema: chatSettingsPatchSchema,
  merge: (current: ChatSettings | undefined, patch: ChatSettingsPatch | null | undefined): ChatSettings | undefined => {
    if (patch === null) return undefined;
    if (patch === undefined) return current;
    return { ...CHAT_SETTINGS_DEFAULTS, ...current, ...patch };
  },
} satisfies UserSettingsNamespace<'chat', ChatSettings, ChatSettingsPatch>;

registerUserSettingsNamespaces([CHAT_USER_SETTINGS as unknown as UserSettingsNamespace]);

declare module '@marinoscar/platform-api/settings' {
  interface UserSettingsNamespaces {
    chat: ChatSettings;
  }
}
