import { registerSystemSettingsNamespaces, registerUserSettingsNamespaces, type SystemSettingsNamespace, type UserSettingsNamespace } from '@marinoscar/platform-api/settings';

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

/**
 * The `agentPricing` namespace of a USER's settings document (#735): the
 * user's own model prices, for a user who brings their own key and pays their
 * provider a different rate. They replace the deployment's price of the same
 * model for THAT user only: their runs' cost and cost budgets (from the run's
 * next job, as the deployment's prices) and their own usage report. The
 * deployment-wide report keeps the deployment's prices. Saved with
 * `PATCH /api/user-settings` (`{ "agentPricing": { "models": { … } } }`);
 * `null` clears it. A PATCH replaces the whole table.
 */
export const AGENT_PRICING_USER_SETTINGS = {
  key: 'agentPricing',
  description: 'My model prices: what each model costs me per million tokens, replacing the deployment price for my runs and my usage report.',
  schema: agentPricingSettingsSchema,
  patchSchema: agentPricingSettingsPatchSchema.nullable(),
  defaults: { currency: 'USD', models: {} },
  merge: (current: AgentPricingSettings | undefined, patch: Partial<AgentPricingSettings> | null | undefined): AgentPricingSettings | undefined => {
    if (patch === null) return undefined;
    if (patch === undefined) return current;
    return { currency: 'USD', models: patch.models ?? current?.models ?? {} };
  },
} satisfies UserSettingsNamespace<'agentPricing', AgentPricingSettings, Partial<AgentPricingSettings> | null> & { defaults: AgentPricingSettings };

registerUserSettingsNamespaces([AGENT_PRICING_USER_SETTINGS as unknown as UserSettingsNamespace]);

/** A user's own price table from their stored settings document (`user_settings.value`); empty when none or unreadable. */
export function userPriceOverrides(settingsValue: unknown): PriceTable {
  const raw = (settingsValue as { agentPricing?: unknown } | null | undefined)?.agentPricing;
  const parsed = agentPricingSettingsSchema.safeParse(raw);
  return parsed.success ? parsed.data.models : {};
}

/** The deployment's table with the user's own prices on top (a user's price wins for that model). */
export function mergePrices(deployment: PriceTable, user: PriceTable): PriceTable {
  return Object.keys(user).length === 0 ? deployment : { ...deployment, ...user };
}

/** Reads a user's own price table: one row, no settings service needed. */
export async function readUserPriceOverrides(db: { userSettings: { findUnique(args: { where: { userId: string }; select: { value: true } }): Promise<{ value: unknown } | null> } }, userId: string): Promise<PriceTable> {
  const row = await db.userSettings.findUnique({ where: { userId }, select: { value: true } });
  return userPriceOverrides(row?.value);
}

/** The price table of a stored namespace value (empty when nothing is listed). */
export function priceTableOf(settings: Pick<AgentPricingSettings, 'models'> | null | undefined): PriceTable {
  return settings?.models ?? {};
}

// Types `SystemSettingsService.getNamespace('agentPricing')`.
declare module '@marinoscar/platform-api/settings' {
  interface SystemSettingsNamespaces {
    agentPricing: AgentPricingSettings;
  }
  interface UserSettingsNamespaces {
    agentPricing: AgentPricingSettings;
  }
}
