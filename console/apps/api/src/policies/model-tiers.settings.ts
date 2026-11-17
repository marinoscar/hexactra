import { registerSystemSettingsNamespaces, type SystemSettingsNamespace } from '@marinoscar/platform-api/settings';

import { TIERS } from './agent-policy.schema';
import { DEFAULT_MODEL_TIERS, EMPTY_TIER, modelTiersOverrideSchema, modelTiersSchema, type ModelTiers, type ModelTiersOverride } from './model-tiers.schema';

/**
 * The `browserAgentTiers` namespace of the system settings document (Admin,
 * `system_settings:read` / `:write`): the deployment's default Fast, Standard
 * and Frontier models (#403). Every tier starts unset, so a fresh deployment
 * falls back to each user's own AI default model. The user's `tiers` in the
 * `browserAgent` namespace override these field by field. Read with
 * `getNamespace('browserAgentTiers')`; registered before
 * `SettingsModule.forRoot()` (src/platform/platform.ts).
 *
 * A PATCH merges per tier and per field; `null` clears a field.
 */
export const BROWSER_AGENT_TIERS_SYSTEM_SETTINGS = {
  key: 'browserAgentTiers',
  description: "Browser agent model tiers: the deployment's default Fast, Standard and Frontier models, reasoning effort and output caps.",
  storedSchema: modelTiersSchema,
  patchSchema: modelTiersOverrideSchema,
  putSchema: modelTiersSchema,
  wirePatchSchema: modelTiersOverrideSchema,
  responseSchema: modelTiersSchema,
  defaults: DEFAULT_MODEL_TIERS,
  requiredOnPut: false,
  merge: (current: ModelTiers, patch: ModelTiersOverride | undefined): ModelTiers => {
    const out = {} as ModelTiers;
    for (const t of TIERS) out[t] = { ...EMPTY_TIER, ...current[t], ...(patch?.[t] ?? {}) };
    return out;
  },
} satisfies SystemSettingsNamespace<'browserAgentTiers', ModelTiers, ModelTiersOverride>;

registerSystemSettingsNamespaces([BROWSER_AGENT_TIERS_SYSTEM_SETTINGS as unknown as SystemSettingsNamespace]);

// Types `SystemSettingsService.getNamespace('browserAgentTiers')`.
declare module '@marinoscar/platform-api/settings' {
  interface SystemSettingsNamespaces {
    browserAgentTiers: ModelTiers;
  }
}
