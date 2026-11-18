import { registerUserSettingsNamespaces, type UserSettingsNamespace } from '@marinoscar/platform-api/settings';
import { z } from 'zod';

/** The `approvals` namespace of a user's settings document (#554): the "Pause all" switch of saved approvals. */
export const approvalsSettingsSchema = z.object({
  paused: z.boolean().describe('When true, no saved approval matches: every question is asked again until it is turned off.'),
});
export type ApprovalsSettings = z.infer<typeof approvalsSettingsSchema>;

export const approvalsSettingsPatchSchema = z.object({ paused: z.boolean().optional() });
type ApprovalsPatch = z.infer<typeof approvalsSettingsPatchSchema>;

/**
 * The `approvals` user settings namespace: `{ paused }`. Written by
 * `PUT /api/approval-rules/paused` (which also records the audit event); read by
 * the matcher through `ApprovalRulesService.isPaused`. Registered before
 * `SettingsModule.forRoot()` composes the request bodies (the import in src/platform/platform.ts).
 */
export const APPROVALS_USER_SETTINGS = {
  key: 'approvals',
  description: 'Saved approvals: whether every saved approval is paused.',
  schema: approvalsSettingsSchema,
  patchSchema: approvalsSettingsPatchSchema,
  defaults: { paused: false },
  merge: (current: ApprovalsSettings | undefined, patch: ApprovalsPatch | null | undefined): ApprovalsSettings | undefined => {
    if (patch === null) return undefined;
    if (patch === undefined) return current;
    const paused = patch.paused ?? current?.paused ?? false;
    // The default is never stored.
    return paused ? { paused } : undefined;
  },
} satisfies Omit<UserSettingsNamespace<'approvals', ApprovalsSettings, ApprovalsPatch>, never> & { defaults: ApprovalsSettings };

registerUserSettingsNamespaces([APPROVALS_USER_SETTINGS as unknown as UserSettingsNamespace]);

declare module '@marinoscar/platform-api/settings' {
  interface UserSettingsNamespaces {
    approvals: ApprovalsSettings;
  }
}
