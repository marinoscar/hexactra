import { registerUserSettingsNamespaces, type UserSettingsNamespace } from '@marinoscar/platform-api/settings';
import { z } from 'zod';

/**
 * The `memories` namespace of a USER's settings document (#553): whether the
 * agent may suggest memories ("Suggest memories", on by default). Off, the
 * agent's `propose_memory` is refused; the owner's saved memories are still
 * read. Registered before `SettingsModule.forRoot()` composes the request
 * bodies (the import in src/platform/platform.ts), so `GET/PATCH
 * /api/user-settings` carry it.
 */
export const memorySettingsSchema = z.object({
  suggest: z.boolean().describe('Let the agent suggest memories for you to approve. On by default.'),
});
export type MemorySettings = z.infer<typeof memorySettingsSchema>;
export const memorySettingsPatchSchema = memorySettingsSchema.partial();
export type MemorySettingsPatch = z.infer<typeof memorySettingsPatchSchema>;

export const MEMORY_SETTINGS_DEFAULTS: MemorySettings = { suggest: true };

/** The namespace as stored in a user's settings document, with the defaults for what was never saved. */
export function memorySettingsOf(doc: unknown): MemorySettings {
  const raw = (doc as { memories?: unknown } | null | undefined)?.memories;
  const parsed = memorySettingsPatchSchema.safeParse(raw ?? {});
  return { ...MEMORY_SETTINGS_DEFAULTS, ...(parsed.success ? parsed.data : {}) };
}

export const MEMORIES_USER_SETTINGS = {
  key: 'memories',
  description: 'Memories: whether the agent may suggest facts for you to remember.',
  schema: memorySettingsSchema,
  patchSchema: memorySettingsPatchSchema,
  merge: (current: MemorySettings | undefined, patch: MemorySettingsPatch | null | undefined): MemorySettings | undefined => {
    if (patch === null) return undefined;
    if (patch === undefined) return current;
    return { ...MEMORY_SETTINGS_DEFAULTS, ...current, ...patch };
  },
} satisfies UserSettingsNamespace<'memories', MemorySettings, MemorySettingsPatch>;

registerUserSettingsNamespaces([MEMORIES_USER_SETTINGS as unknown as UserSettingsNamespace]);

declare module '@marinoscar/platform-api/settings' {
  interface UserSettingsNamespaces {
    memories: MemorySettings;
  }
}
