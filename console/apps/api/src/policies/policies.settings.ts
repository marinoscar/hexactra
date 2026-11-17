import { registerUserSettingsNamespaces, type UserSettingsNamespace } from '@marinoscar/platform-api/settings';
import { z } from 'zod';

import { mergeTierOverrides, modelTiersOverrideSchema } from './model-tiers.schema';

/** The `browserAgent` namespace of a user's settings document (#401). */
export const browserAgentSettingsSchema = z.object({
  defaultPolicyRef: z.string().max(64).nullable().describe("The user's default agent policy: an own policy's UUID or `builtin:<key>`. `null` means `builtin:balanced`."),
  tiers: modelTiersOverrideSchema.optional().describe("The user's own model tiers: per tier, any of model, reasoning effort, output cap and fallback model. A field left out uses the deployment default (#403)."),
});
export type BrowserAgentSettings = z.infer<typeof browserAgentSettingsSchema>;

// `tiers: null` clears every tier override; inside `tiers`, `null` clears one field.
export const browserAgentSettingsPatchSchema = z.object({
  defaultPolicyRef: browserAgentSettingsSchema.shape.defaultPolicyRef.optional(),
  tiers: modelTiersOverrideSchema.nullable().optional(),
});
type BrowserAgentPatch = z.infer<typeof browserAgentSettingsPatchSchema>;

/**
 * The `browserAgent` user settings namespace: `{ defaultPolicyRef }`. Registered
 * before `SettingsModule.forRoot()` composes the request bodies (the import in
 * src/platform/platform.ts). The API validates the reference against the user's
 * policies (`PUT /api/agent-policies/default`); the generic settings route only
 * validates the shape.
 */
export const BROWSER_AGENT_USER_SETTINGS = {
  key: 'browserAgent',
  description: "Browser agent: the user's default agent policy and their own model tiers.",
  schema: browserAgentSettingsSchema,
  patchSchema: browserAgentSettingsPatchSchema,
  defaults: { defaultPolicyRef: null },
  merge: (current: BrowserAgentSettings | undefined, patch: BrowserAgentPatch | null | undefined): BrowserAgentSettings | undefined => {
    if (patch === null) return undefined;
    if (patch === undefined) return current;
    const next = patch.defaultPolicyRef === undefined ? (current?.defaultPolicyRef ?? null) : patch.defaultPolicyRef;
    const tiers = patch.tiers === undefined ? mergeTierOverrides(current?.tiers, {}) : mergeTierOverrides(current?.tiers, patch.tiers);
    // An emptied namespace is never stored.
    if (next === null && !tiers) return undefined;
    return { defaultPolicyRef: next, ...(tiers ? { tiers } : {}) };
  },
} satisfies Omit<UserSettingsNamespace<'browserAgent', BrowserAgentSettings, BrowserAgentPatch>, never> & { defaults: BrowserAgentSettings };

registerUserSettingsNamespaces([BROWSER_AGENT_USER_SETTINGS as unknown as UserSettingsNamespace]);

declare module '@marinoscar/platform-api/settings' {
  interface UserSettingsNamespaces {
    browserAgent: BrowserAgentSettings;
  }
}
