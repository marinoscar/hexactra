// Settings of Connections (E39.2, #599): the deployment's apps at Google and Microsoft.
//
//   system `connections` (Administrator, `system_settings:write`)
//     google.enabled / microsoft.enabled   the per-provider switch, default OFF: while off, nobody can connect that provider.
//     google.clientId / microsoft.clientId the OAuth client id of the app the administrator registered (BRING YOUR OWN APP).
//     microsoft.tenant                     `common` (default), `organizations`, `consumers` or a tenant id.
//   The client SECRETS are system credentials (`connection_app_google`, `connection_app_microsoft`), write-only.
//
// Registered before `SettingsModule.forRoot()` composes the request bodies (the import in src/platform/platform.ts).
import { registerSystemSettingsNamespaces, type SystemSettingsNamespace } from '@marinoscar/platform-api/settings';
import { z } from 'zod';

const clientId = z.string().trim().min(1).max(300).nullable().optional();
/** The browser API key of Google's file picker (a public key restricted to this console's address in Google Cloud, not a secret). */
const pickerApiKey = z
  .string()
  .trim()
  .min(10)
  .max(100)
  .regex(/^[A-Za-z0-9_-]+$/, 'A Google API key')
  .nullable()
  .optional();
const tenant = z
  .string()
  .trim()
  .min(1)
  .max(100)
  .regex(/^[A-Za-z0-9.-]+$/, 'common, organizations, consumers or a tenant id')
  .optional();

export const connectionsSystemSettingsSchema = z.object({
  providers: z
    .object({
      google: z.object({ enabled: z.boolean().optional(), clientId, pickerApiKey }).optional(),
      microsoft: z.object({ enabled: z.boolean().optional(), clientId, tenant }).optional(),
    })
    .optional(),
});
export type ConnectionsSystemSettings = z.infer<typeof connectionsSystemSettingsSchema>;
export const connectionsSystemSettingsPatchSchema = connectionsSystemSettingsSchema;
export type ConnectionsSystemSettingsPatch = ConnectionsSystemSettings;

export interface ResolvedConnectionsSystemSettings {
  google: { enabled: boolean; clientId: string | null; pickerApiKey: string | null };
  microsoft: { enabled: boolean; clientId: string | null; tenant: string };
}

export const CONNECTIONS_SYSTEM_DEFAULTS: ResolvedConnectionsSystemSettings = {
  google: { enabled: false, clientId: null, pickerApiKey: null },
  microsoft: { enabled: false, clientId: null, tenant: 'common' },
};

export function resolveConnectionsSystemSettings(v: ConnectionsSystemSettings | null | undefined): ResolvedConnectionsSystemSettings {
  const g = v?.providers?.google;
  const m = v?.providers?.microsoft;
  return {
    google: { enabled: g?.enabled === true, clientId: g?.clientId ?? null, pickerApiKey: g?.pickerApiKey ?? null },
    microsoft: { enabled: m?.enabled === true, clientId: m?.clientId ?? null, tenant: m?.tenant ?? 'common' },
  };
}

const merge = (current: ConnectionsSystemSettings | undefined, patch: ConnectionsSystemSettingsPatch | undefined): ConnectionsSystemSettings => {
  // The platform calls every namespace's merge on every settings write: no patch for this one is the current value.
  const base = resolveConnectionsSystemSettings(current);
  if (!patch?.providers) return { providers: base };
  const g = patch.providers.google;
  const m = patch.providers.microsoft;
  return {
    providers: {
      google: { enabled: g?.enabled ?? base.google.enabled, clientId: g && 'clientId' in g ? (g.clientId ?? null) : base.google.clientId, pickerApiKey: g && 'pickerApiKey' in g ? (g.pickerApiKey ?? null) : base.google.pickerApiKey },
      microsoft: { enabled: m?.enabled ?? base.microsoft.enabled, clientId: m && 'clientId' in m ? (m.clientId ?? null) : base.microsoft.clientId, tenant: m?.tenant ?? base.microsoft.tenant },
    },
  };
};

export const CONNECTIONS_SYSTEM_SETTINGS = {
  key: 'connections',
  description: 'Connections: the apps the administrator registered at Google and Microsoft (client id, tenant) and the per-provider switch (off by default). The client secrets are credentials, never settings.',
  storedSchema: connectionsSystemSettingsSchema,
  patchSchema: connectionsSystemSettingsPatchSchema,
  putSchema: connectionsSystemSettingsSchema,
  wirePatchSchema: connectionsSystemSettingsPatchSchema,
  responseSchema: connectionsSystemSettingsSchema,
  defaults: { providers: CONNECTIONS_SYSTEM_DEFAULTS },
  requiredOnPut: false,
  merge: (current, patch) => merge(current, patch as ConnectionsSystemSettingsPatch | undefined),
} satisfies SystemSettingsNamespace<'connections', ConnectionsSystemSettings, ConnectionsSystemSettingsPatch>;

registerSystemSettingsNamespaces([CONNECTIONS_SYSTEM_SETTINGS as unknown as SystemSettingsNamespace]);

declare module '@marinoscar/platform-api/settings' {
  interface SystemSettingsNamespaces {
    connections: ConnectionsSystemSettings;
  }
}
