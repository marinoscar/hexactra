import { registerSystemSettingsNamespaces, type SystemSettingsNamespace } from '@marinoscar/platform-api/settings';

import { browserAgentCeilingsPatchSchema, browserAgentCeilingsSchema, NO_CEILINGS, type BrowserAgentCeilings } from './budget-ceilings.schemas';

/**
 * The `browserAgentCeilings` namespace of the system settings document (Admin,
 * `system_settings:write`): the most any agent policy may allow a run. All
 * `null` by default (no ceilings). Read once per run, at its first advance,
 * into the run's `policy_snapshot.effectiveBudget`. Registered before
 * `SettingsModule.forRoot()` (src/platform/platform.ts).
 */
export const BROWSER_AGENT_CEILINGS_SYSTEM_SETTINGS = {
  key: 'browserAgentCeilings',
  description: 'Browser agent ceilings: the most any policy may allow a run (actions, model calls, active minutes, tokens, cost).',
  storedSchema: browserAgentCeilingsSchema,
  patchSchema: browserAgentCeilingsPatchSchema,
  putSchema: browserAgentCeilingsSchema,
  wirePatchSchema: browserAgentCeilingsPatchSchema,
  responseSchema: browserAgentCeilingsSchema,
  defaults: NO_CEILINGS,
  requiredOnPut: false,
  merge: (current, patch) => ({ ...current, ...patch }),
} satisfies SystemSettingsNamespace<'browserAgentCeilings', BrowserAgentCeilings, Partial<BrowserAgentCeilings>>;

registerSystemSettingsNamespaces([BROWSER_AGENT_CEILINGS_SYSTEM_SETTINGS as unknown as SystemSettingsNamespace]);

// Types `SystemSettingsService.getNamespace('browserAgentCeilings')`.
declare module '@marinoscar/platform-api/settings' {
  interface SystemSettingsNamespaces {
    browserAgentCeilings: BrowserAgentCeilings;
  }
}
