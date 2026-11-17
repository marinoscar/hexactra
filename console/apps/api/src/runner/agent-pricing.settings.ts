import { registerSystemSettingsNamespaces, type SystemSettingsNamespace } from '@marinoscar/platform-api/settings';

import { agentPricingSettingsPatchSchema, agentPricingSettingsSchema, type AgentPricingSettings } from './agent-pricing.schemas';
import type { PriceTable } from './cost';

/**
 * The `agentPricing` namespace of the system settings document (Admin,
 * `system_settings:write`): what each model costs per million tokens. Empty
 * by default: the platform and the console ship no rates (they change, and
 * they are the deployment's contract with a provider), so until an admin
 * lists a model its calls are unpriced ("at least" on a run).
 * Registered before `SettingsModule.forRoot()` (src/platform/platform.ts).
 */
export const AGENT_PRICING_SYSTEM_SETTINGS = {
  key: 'agentPricing',
  description: 'Agent pricing: what each model costs per million tokens, for run cost and the AI usage report.',
  storedSchema: agentPricingSettingsSchema,
  patchSchema: agentPricingSettingsPatchSchema,
  putSchema: agentPricingSettingsSchema,
  wirePatchSchema: agentPricingSettingsPatchSchema,
  responseSchema: agentPricingSettingsSchema,
  defaults: { currency: 'USD', models: {} },
  requiredOnPut: false,
  merge: (current, patch) => ({ currency: 'USD', models: patch?.models ?? current.models }),
} satisfies SystemSettingsNamespace<'agentPricing', AgentPricingSettings, Partial<AgentPricingSettings>>;

registerSystemSettingsNamespaces([AGENT_PRICING_SYSTEM_SETTINGS as unknown as SystemSettingsNamespace]);

/** The price table of a stored namespace value (empty when nothing is listed). */
export function priceTableOf(settings: Pick<AgentPricingSettings, 'models'> | null | undefined): PriceTable {
  return settings?.models ?? {};
}

// Types `SystemSettingsService.getNamespace('agentPricing')`.
declare module '@marinoscar/platform-api/settings' {
  interface SystemSettingsNamespaces {
    agentPricing: AgentPricingSettings;
  }
}
