// Settings of web search (E50.5, #975).
//
//   system `webSearch` (Administrator, `system_settings:write`)
//     enabled                      the deployment's switch, default ON: search works as soon as a provider has a usable key.
//     providers.<id>.enabled       per provider, default ON.
//     providers.<id>.costPerCallUsd  an override of the provider's ESTIMATED cost per call (null: the provider's default estimate).
//     providers.<id>.baseUrl       a self-hosted provider's address (SearXNG, E50.8).
//     order                        provider ids, first usable wins (default ['brave']). A provider not listed is not used.
//     shareDeploymentKey           default ON: everyone may use the deployment's key (the system tier).
//     allowUserKeys                default ON: a user's own key (the user tier) is used.
//     limits.perRun                default 30 searches a run; null is unlimited (enforced per port: one port per run, E50.7).
//     limits.perUserPerDay         default 300 searches a user a day (UTC); null is unlimited.
//   user `webSearch` (the owner's own)
//     enabled                      default ON.
//     provider                     a preferred provider among the usable ones; null: the deployment's order.
//
// The keys are service credentials (`web_search.<id>`), never settings. Registered before `SettingsModule.forRoot()` composes the
// request bodies (the import in src/platform/platform.ts).
import { registerSystemSettingsNamespaces, registerUserSettingsNamespaces, type SystemSettingsNamespace, type UserSettingsNamespace } from '@marinoscar/platform-api/settings';
import { z } from 'zod';

const providerId = z.string().regex(/^[a-z][a-z0-9_]{0,31}$/, 'A provider id such as brave');
const limit = z.number().int().min(1).max(100_000).nullable();

const providerSettingsSchema = z.object({
  enabled: z.boolean().optional(),
  costPerCallUsd: z.number().min(0).max(10).nullable().optional(),
  baseUrl: z.string().trim().url().max(500).nullable().optional(),
});

export const webSearchSystemSettingsSchema = z.object({
  enabled: z.boolean().optional(),
  providers: z.record(providerId, providerSettingsSchema).optional(),
  order: z.array(providerId).max(20).optional(),
  shareDeploymentKey: z.boolean().optional(),
  allowUserKeys: z.boolean().optional(),
  limits: z.object({ perRun: limit.optional(), perUserPerDay: limit.optional() }).optional(),
});
export type WebSearchSystemSettings = z.infer<typeof webSearchSystemSettingsSchema>;

export interface ResolvedProviderSettings {
  enabled: boolean;
  costPerCallUsd: number | null;
  baseUrl: string | null;
}

export interface ResolvedWebSearchSystemSettings {
  enabled: boolean;
  providers: Record<string, ResolvedProviderSettings>;
  order: string[];
  shareDeploymentKey: boolean;
  allowUserKeys: boolean;
  limits: { perRun: number | null; perUserPerDay: number | null };
}

export const WEB_SEARCH_DEFAULT_ORDER = ['brave'];
export const WEB_SEARCH_DEFAULT_LIMITS = { perRun: 30, perUserPerDay: 300 } as const;

export const PROVIDER_DEFAULTS: ResolvedProviderSettings = { enabled: true, costPerCallUsd: null, baseUrl: null };

export function resolveWebSearchSystemSettings(v: WebSearchSystemSettings | null | undefined): ResolvedWebSearchSystemSettings {
  const providers: Record<string, ResolvedProviderSettings> = {};
  for (const [id, p] of Object.entries(v?.providers ?? {})) {
    providers[id] = { enabled: p?.enabled ?? true, costPerCallUsd: p?.costPerCallUsd ?? null, baseUrl: p?.baseUrl ?? null };
  }
  return {
    enabled: v?.enabled ?? true,
    providers,
    order: v?.order ? [...new Set(v.order)] : [...WEB_SEARCH_DEFAULT_ORDER],
    shareDeploymentKey: v?.shareDeploymentKey ?? true,
    allowUserKeys: v?.allowUserKeys ?? true,
    limits: {
      perRun: v?.limits && 'perRun' in v.limits ? (v.limits.perRun ?? null) : WEB_SEARCH_DEFAULT_LIMITS.perRun,
      perUserPerDay: v?.limits && 'perUserPerDay' in v.limits ? (v.limits.perUserPerDay ?? null) : WEB_SEARCH_DEFAULT_LIMITS.perUserPerDay,
    },
  };
}

/** A provider's resolved settings (the defaults when none were saved). */
export const providerSettingsOf = (s: ResolvedWebSearchSystemSettings, id: string): ResolvedProviderSettings => s.providers[id] ?? PROVIDER_DEFAULTS;

/** A patch: a field left out is kept; `null` on a nullable field clears it (a limit becomes unlimited). Providers merge per id and per field. */
export function mergeWebSearchSystemSettings(current: WebSearchSystemSettings | undefined, patch: WebSearchSystemSettings | undefined): WebSearchSystemSettings {
  const base = resolveWebSearchSystemSettings(current);
  if (!patch) return toStored(base);
  const providers: Record<string, ResolvedProviderSettings> = { ...base.providers };
  for (const [id, p] of Object.entries(patch.providers ?? {})) {
    const was = providers[id] ?? PROVIDER_DEFAULTS;
    providers[id] = {
      enabled: p?.enabled ?? was.enabled,
      costPerCallUsd: p && 'costPerCallUsd' in p ? (p.costPerCallUsd ?? null) : was.costPerCallUsd,
      baseUrl: p && 'baseUrl' in p ? (p.baseUrl ?? null) : was.baseUrl,
    };
  }
  return toStored({
    enabled: patch.enabled ?? base.enabled,
    providers,
    order: patch.order ? [...new Set(patch.order)] : base.order,
    shareDeploymentKey: patch.shareDeploymentKey ?? base.shareDeploymentKey,
    allowUserKeys: patch.allowUserKeys ?? base.allowUserKeys,
    limits: {
      perRun: patch.limits && 'perRun' in patch.limits ? (patch.limits.perRun ?? null) : base.limits.perRun,
      perUserPerDay: patch.limits && 'perUserPerDay' in patch.limits ? (patch.limits.perUserPerDay ?? null) : base.limits.perUserPerDay,
    },
  });
}

const toStored = (r: ResolvedWebSearchSystemSettings): WebSearchSystemSettings => ({
  enabled: r.enabled,
  providers: r.providers,
  order: r.order,
  shareDeploymentKey: r.shareDeploymentKey,
  allowUserKeys: r.allowUserKeys,
  limits: { perRun: r.limits.perRun, perUserPerDay: r.limits.perUserPerDay },
});

export const WEB_SEARCH_SYSTEM_SETTINGS = {
  key: 'webSearch',
  description: 'Web search: the deployment switch, the search providers (switch, order, cost estimate override), whether everyone may use the deployment key and whether users may use their own, and the limits per run and per user per day. The keys are service credentials, never settings.',
  storedSchema: webSearchSystemSettingsSchema,
  patchSchema: webSearchSystemSettingsSchema,
  putSchema: webSearchSystemSettingsSchema,
  wirePatchSchema: webSearchSystemSettingsSchema,
  responseSchema: webSearchSystemSettingsSchema,
  defaults: toStored(resolveWebSearchSystemSettings(null)),
  requiredOnPut: false,
  merge: (current, patch) => mergeWebSearchSystemSettings(current, patch as WebSearchSystemSettings | undefined),
} satisfies SystemSettingsNamespace<'webSearch', WebSearchSystemSettings, WebSearchSystemSettings>;

registerSystemSettingsNamespaces([WEB_SEARCH_SYSTEM_SETTINGS as unknown as SystemSettingsNamespace]);

// ---- user ----

export const webSearchUserSettingsSchema = z.object({
  enabled: z.boolean().describe('Web search for your runs and chats (default on). Off: the agent searches in the browser.'),
  provider: providerId.nullable().describe('The search provider you prefer among the usable ones; `null` follows the deployment\'s order.'),
});
export type WebSearchUserSettings = z.infer<typeof webSearchUserSettingsSchema>;
export const webSearchUserSettingsPatchSchema = webSearchUserSettingsSchema.partial();
export type WebSearchUserSettingsPatch = z.infer<typeof webSearchUserSettingsPatchSchema>;

export const WEB_SEARCH_USER_DEFAULTS: WebSearchUserSettings = { enabled: true, provider: null };

/** The owner's settings from their settings document; the defaults when never saved or not valid. */
export function webSearchUserOf(doc: unknown): WebSearchUserSettings {
  const raw = (doc as { webSearch?: unknown } | null | undefined)?.webSearch;
  const parsed = webSearchUserSettingsPatchSchema.safeParse(raw ?? {});
  return { ...WEB_SEARCH_USER_DEFAULTS, ...(parsed.success ? parsed.data : {}) };
}

export const WEB_SEARCH_USER_SETTINGS = {
  key: 'webSearch',
  description: 'Web search: your switch and the provider you prefer.',
  schema: webSearchUserSettingsSchema,
  patchSchema: webSearchUserSettingsPatchSchema,
  merge: (current: WebSearchUserSettings | undefined, patch: WebSearchUserSettingsPatch | null | undefined): WebSearchUserSettings | undefined => {
    if (patch === null) return undefined;
    if (patch === undefined) return current;
    return { ...WEB_SEARCH_USER_DEFAULTS, ...current, ...patch };
  },
} satisfies UserSettingsNamespace<'webSearch', WebSearchUserSettings, WebSearchUserSettingsPatch>;

registerUserSettingsNamespaces([WEB_SEARCH_USER_SETTINGS as unknown as UserSettingsNamespace]);

declare module '@marinoscar/platform-api/settings' {
  interface SystemSettingsNamespaces {
    webSearch: WebSearchSystemSettings;
  }
  interface UserSettingsNamespaces {
    webSearch: WebSearchUserSettings;
  }
}
