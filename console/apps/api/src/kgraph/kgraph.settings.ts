// E46.3 (#777): the `kgraph` namespaces of the SYSTEM settings document (Admin) and of a USER's settings document. Both are off by default:
// the deployment switch is the administrator's kill switch, the user switch is opt-in even when the deployment allows it. Turning either off
// deletes nothing (console docs/decisions/knowledge-graph.md). Registered before `SettingsModule.forRoot()` composes the request bodies
// (the import in src/platform/platform.ts).
import { registerSystemSettingsNamespaces, registerUserSettingsNamespaces, type SystemSettingsNamespace, type UserSettingsNamespace } from '@marinoscar/platform-api/settings';
import { z } from 'zod';

export const kgraphSystemSettingsSchema = z.object({
  enabled: z.boolean().describe('Allow the Knowledge Graph on this deployment. Off by default: no capture, replay, job, agent tool or MCP tool. Turning it off keeps what was learned.'),
  auditEvery: z.number().int().min(0).max(1000).describe('Every Nth run of a reuse-mode task runs with AI only and is compared with the procedure (E46.11). 0 never. Default 10.'),
  suspendAfterFailures: z.number().int().min(1).max(100).describe('Consecutive failed replays that suspend a procedure (E46.12). Default 3.'),
  retentionDays: z.number().int().min(1).max(3650).nullable().describe('Days an unused procedure and its traces are kept (E46.24). null keeps them. Default null.'),
  pacing: z.enum(['human', 'fast']).describe('How replayed browser actions are paced (E46.14): human (a bounded random gap between actions) or fast (only waits for the page to be ready; for account-only procedures and tests). Default human.'),
});
export type KgraphSystemSettings = z.infer<typeof kgraphSystemSettingsSchema>;
export const kgraphSystemSettingsPatchSchema = kgraphSystemSettingsSchema.partial();
export const KGRAPH_SYSTEM_DEFAULTS: KgraphSystemSettings = { enabled: false, auditEvery: 10, suspendAfterFailures: 3, retentionDays: null, pacing: 'human' };

export const KGRAPH_SYSTEM_SETTINGS = {
  key: 'kgraph',
  description: 'Knowledge Graph: whether it is allowed on this deployment, and its audit, suspension and retention rules.',
  storedSchema: kgraphSystemSettingsSchema,
  patchSchema: kgraphSystemSettingsPatchSchema,
  putSchema: kgraphSystemSettingsSchema,
  wirePatchSchema: kgraphSystemSettingsPatchSchema,
  responseSchema: kgraphSystemSettingsSchema,
  defaults: KGRAPH_SYSTEM_DEFAULTS,
  requiredOnPut: false,
  merge: (current, patch) => ({ ...KGRAPH_SYSTEM_DEFAULTS, ...current, ...patch }),
} satisfies SystemSettingsNamespace<'kgraph', KgraphSystemSettings, Partial<KgraphSystemSettings>>;

export const kgraphUserSettingsSchema = z.object({
  enabled: z.boolean().describe('Use the Knowledge Graph for your saved tasks. Off by default; turning it off keeps what was learned.'),
});
export type KgraphUserSettings = z.infer<typeof kgraphUserSettingsSchema>;
export const kgraphUserSettingsPatchSchema = kgraphUserSettingsSchema.partial();
export type KgraphUserSettingsPatch = z.infer<typeof kgraphUserSettingsPatchSchema>;
export const KGRAPH_USER_DEFAULTS: KgraphUserSettings = { enabled: false };

export const KGRAPH_USER_SETTINGS = {
  key: 'kgraph',
  description: 'Knowledge Graph: whether your saved tasks may learn and reuse procedures.',
  schema: kgraphUserSettingsSchema,
  patchSchema: kgraphUserSettingsPatchSchema,
  merge: (current: KgraphUserSettings | undefined, patch: KgraphUserSettingsPatch | null | undefined): KgraphUserSettings | undefined => {
    if (patch === null) return undefined;
    if (patch === undefined) return current;
    return { ...KGRAPH_USER_DEFAULTS, ...current, ...patch };
  },
} satisfies UserSettingsNamespace<'kgraph', KgraphUserSettings, KgraphUserSettingsPatch>;

registerSystemSettingsNamespaces([KGRAPH_SYSTEM_SETTINGS as unknown as SystemSettingsNamespace]);
registerUserSettingsNamespaces([KGRAPH_USER_SETTINGS as unknown as UserSettingsNamespace]);

declare module '@marinoscar/platform-api/settings' {
  interface SystemSettingsNamespaces {
    kgraph: KgraphSystemSettings;
  }
  interface UserSettingsNamespaces {
    kgraph: KgraphUserSettings;
  }
}

/** A stored system value, salvaged: a missing or malformed field takes its default. */
export function readKgraphSystemSettings(raw: unknown): KgraphSystemSettings {
  const r = (raw ?? {}) as Record<string, unknown>;
  const out = { ...KGRAPH_SYSTEM_DEFAULTS };
  for (const k of Object.keys(KGRAPH_SYSTEM_DEFAULTS) as (keyof KgraphSystemSettings)[]) {
    if (!(k in r)) continue;
    const parsed = kgraphSystemSettingsSchema.shape[k].safeParse(r[k]);
    if (parsed.success) (out as Record<string, unknown>)[k] = parsed.data;
  }
  return out;
}

/** The user namespace as stored in a user's settings document, with the defaults for what was never saved. */
export function readKgraphUserSettings(doc: unknown): KgraphUserSettings {
  const raw = (doc as { kgraph?: unknown } | null | undefined)?.kgraph;
  const parsed = kgraphUserSettingsPatchSchema.safeParse(raw ?? {});
  return { ...KGRAPH_USER_DEFAULTS, ...(parsed.success ? parsed.data : {}) };
}
