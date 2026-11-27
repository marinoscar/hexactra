// The two switches of skills (#1008), both ON by default:
//
//   system `skills` (Administrator, `system_settings:write`)
//     enabled    the deployment's switch. Off: no run or chat is given the skills block or offered `skill_read`; the skills are kept.
//   user `skills` (the owner's own, Settings → Skills)
//     enabled    the owner's switch. Off: the same, for this owner's runs and chats.
//
// Each skill's own `enabled` is a column of the skill. Registered before `SettingsModule.forRoot()` composes the request bodies (the import
// in src/platform/platform.ts), so `GET/PATCH /api/system-settings` and `/api/user-settings` carry them.
import { registerSystemSettingsNamespaces, registerUserSettingsNamespaces, type SystemSettingsNamespace, type UserSettingsNamespace } from '@marinoscar/platform-api/settings';
import { z } from 'zod';

// ---- system ----

export const skillsSystemSettingsSchema = z.object({
  enabled: z.boolean().optional().describe("Skills for every user's runs and chats (default on)."),
});
export type SkillsSystemSettings = z.infer<typeof skillsSystemSettingsSchema>;

/** The deployment's switch from the system settings namespace; on when never saved or not valid. */
export function skillsSystemEnabled(v: unknown): boolean {
  const parsed = skillsSystemSettingsSchema.safeParse(v ?? {});
  return parsed.success ? (parsed.data.enabled ?? true) : true;
}

export const SKILLS_SYSTEM_SETTINGS = {
  key: 'skills',
  description: "Skills: the deployment's switch (default on). Off, no run or chat is offered the owners' skills; the skills are kept.",
  storedSchema: skillsSystemSettingsSchema,
  patchSchema: skillsSystemSettingsSchema,
  putSchema: skillsSystemSettingsSchema,
  wirePatchSchema: skillsSystemSettingsSchema,
  responseSchema: skillsSystemSettingsSchema,
  defaults: { enabled: true },
  requiredOnPut: false,
  merge: (current: SkillsSystemSettings | undefined, patch: unknown) => ({ enabled: (patch as SkillsSystemSettings | undefined)?.enabled ?? current?.enabled ?? true }),
} satisfies SystemSettingsNamespace<'skills', SkillsSystemSettings, SkillsSystemSettings>;

registerSystemSettingsNamespaces([SKILLS_SYSTEM_SETTINGS as unknown as SystemSettingsNamespace]);

// ---- user ----

export const skillsUserSettingsSchema = z.object({
  enabled: z.boolean().describe('Offer your skills to your runs and chats (default on). Off: they are kept but not offered.'),
});
export type SkillsUserSettings = z.infer<typeof skillsUserSettingsSchema>;
export const skillsUserSettingsPatchSchema = skillsUserSettingsSchema.partial();
export type SkillsUserSettingsPatch = z.infer<typeof skillsUserSettingsPatchSchema>;

export const SKILLS_USER_DEFAULTS: SkillsUserSettings = { enabled: true };

/** The owner's settings from their settings document; the defaults when never saved or not valid. */
export function skillsUserOf(doc: unknown): SkillsUserSettings {
  const raw = (doc as { skills?: unknown } | null | undefined)?.skills;
  const parsed = skillsUserSettingsPatchSchema.safeParse(raw ?? {});
  return { ...SKILLS_USER_DEFAULTS, ...(parsed.success ? parsed.data : {}) };
}

export const SKILLS_USER_SETTINGS = {
  key: 'skills',
  description: 'Skills: whether your skills are offered to your runs and chats.',
  schema: skillsUserSettingsSchema,
  patchSchema: skillsUserSettingsPatchSchema,
  merge: (current: SkillsUserSettings | undefined, patch: SkillsUserSettingsPatch | null | undefined): SkillsUserSettings | undefined => {
    if (patch === null) return undefined;
    if (patch === undefined) return current;
    return { ...SKILLS_USER_DEFAULTS, ...current, ...patch };
  },
} satisfies UserSettingsNamespace<'skills', SkillsUserSettings, SkillsUserSettingsPatch>;

registerUserSettingsNamespaces([SKILLS_USER_SETTINGS as unknown as UserSettingsNamespace]);

declare module '@marinoscar/platform-api/settings' {
  interface SystemSettingsNamespaces {
    skills: SkillsSystemSettings;
  }
  interface UserSettingsNamespaces {
    skills: SkillsUserSettings;
  }
}
