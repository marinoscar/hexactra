import {
  registerSystemSettingsNamespaces,
  registerUserSettingsNamespaces,
  type SystemSettingsNamespace,
  type UserSettingsNamespace,
} from '@marinoscar/platform-api/settings';

import {
  NO_RETENTION_CEILING,
  RUN_RETENTION_DEFAULTS,
  runRetentionCeilingPatchSchema,
  runRetentionCeilingSchema,
  runRetentionSettingsPatchSchema,
  runRetentionSettingsSchema,
  type RunRetentionCeiling,
  type RunRetentionSettings,
  type RunRetentionSettingsPatch,
} from './run-retention.schemas';

/**
 * The `runs` namespace of a USER's settings document (#422): how long that
 * user's finished runs are kept. Registered before `SettingsModule.forRoot()`
 * composes the request bodies (the import in src/platform/platform.ts), so
 * `GET/PATCH /api/user-settings` carry it.
 *
 * A user who never saved it has no stored value: the defaults apply
 * (`RUN_RETENTION_DEFAULTS`), and the nightly job tells them once before it
 * deletes anything. Saving a limit stamps `noticeSentAt`: the user chose the
 * rule, so no notice is owed. `null` as the patch clears the namespace.
 */
export const RUNS_USER_SETTINGS = {
  key: 'runs',
  description: 'Run history: how long finished runs are kept (days, and the newest N per task).',
  schema: runRetentionSettingsSchema,
  patchSchema: runRetentionSettingsPatchSchema,
  defaults: RUN_RETENTION_DEFAULTS,
  merge: (current: RunRetentionSettings | undefined, patch: RunRetentionSettingsPatch | null | undefined): RunRetentionSettings | undefined => {
    if (patch === null) return undefined;
    if (patch === undefined) return current;
    const base = current ?? RUN_RETENTION_DEFAULTS;
    const pick = <K extends 'keepDays' | 'keepPerTask' | 'keepFailedDays'>(key: K) => (patch[key] === undefined ? base[key] : patch[key]) as RunRetentionSettings[K];
    return {
      keepDays: pick('keepDays'),
      keepPerTask: pick('keepPerTask'),
      keepFailedDays: pick('keepFailedDays'),
      noticeSentAt: patch.noticeSentAt ?? current?.noticeSentAt ?? new Date().toISOString(),
    };
  },
} satisfies UserSettingsNamespace<'runs', RunRetentionSettings, RunRetentionSettingsPatch> & { defaults: Omit<RunRetentionSettings, 'noticeSentAt'> };

registerUserSettingsNamespaces([RUNS_USER_SETTINGS as unknown as UserSettingsNamespace]);

/**
 * The `runs` namespace of the SYSTEM settings document (Admin,
 * `system_settings:write`): the most days any user's runs are kept. `null` by
 * default (no ceiling). Read by the retention job each night, never stored on
 * a user.
 */
export const RUNS_SYSTEM_SETTINGS = {
  key: 'runs',
  description: "Run history: the most days any user's finished runs are kept.",
  storedSchema: runRetentionCeilingSchema,
  patchSchema: runRetentionCeilingPatchSchema,
  putSchema: runRetentionCeilingSchema,
  wirePatchSchema: runRetentionCeilingPatchSchema,
  responseSchema: runRetentionCeilingSchema,
  defaults: NO_RETENTION_CEILING,
  requiredOnPut: false,
  merge: (current, patch) => ({ ...current, ...patch }),
} satisfies SystemSettingsNamespace<'runs', RunRetentionCeiling, Partial<RunRetentionCeiling>>;

registerSystemSettingsNamespaces([RUNS_SYSTEM_SETTINGS as unknown as SystemSettingsNamespace]);

declare module '@marinoscar/platform-api/settings' {
  interface UserSettingsNamespaces {
    runs: RunRetentionSettings;
  }
  interface SystemSettingsNamespaces {
    runs: RunRetentionCeiling;
  }
}
