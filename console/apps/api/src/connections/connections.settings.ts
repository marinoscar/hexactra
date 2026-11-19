// Settings of Connections (E39.2, #599): the deployment's apps at Google and Microsoft.
//
//   system `connections` (Administrator, `system_settings:write`)
//     google.enabled / microsoft.enabled   the per-provider switch, default OFF: while off, nobody can connect that provider.
//     google.clientId / microsoft.clientId the OAuth client id of the app the administrator registered (BRING YOUR OWN APP).
//     microsoft.tenant                     `common` (default), `organizations`, `consumers` or a tenant id.
//   The client SECRETS are system credentials (`connection_app_google`, `connection_app_microsoft`), write-only.
//     mcp.enabled                          MCP servers as connections (E39.9), default OFF: while off, none can be added or used.
//     mcp.allowedHosts / mcp.blockedHosts  exact host names or `*.example.test` suffixes. Empty allow-list: any public host.
//
// Registered before `SettingsModule.forRoot()` composes the request bodies (the import in src/platform/platform.ts).
import { registerSystemSettingsNamespaces, type SystemSettingsNamespace } from '@marinoscar/platform-api/settings';
import { z } from 'zod';

const clientId = z.string().trim().min(1).max(300).nullable().optional();
const tenant = z
  .string()
  .trim()
  .min(1)
  .max(100)
  .regex(/^[A-Za-z0-9.-]+$/, 'common, organizations, consumers or a tenant id')
  .optional();

/** A host name or a `*.suffix` pattern: lower-case, no scheme, port or path. */
const hostPattern = z
  .string()
  .trim()
  .toLowerCase()
  .min(1)
  .max(253)
  .regex(/^(\*\.)?[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)*$/, 'A host name such as mcp.example.test or *.example.test');
const hostList = z.array(hostPattern).max(200);

export const connectionsSystemSettingsSchema = z.object({
  mcp: z.object({ enabled: z.boolean().optional(), allowedHosts: hostList.optional(), blockedHosts: hostList.optional() }).optional(),
  providers: z
    .object({
      google: z.object({ enabled: z.boolean().optional(), clientId }).optional(),
      microsoft: z.object({ enabled: z.boolean().optional(), clientId, tenant }).optional(),
    })
    .optional(),
});
export type ConnectionsSystemSettings = z.infer<typeof connectionsSystemSettingsSchema>;
export const connectionsSystemSettingsPatchSchema = connectionsSystemSettingsSchema;
export type ConnectionsSystemSettingsPatch = ConnectionsSystemSettings;

export interface ResolvedMcpSettings {
  enabled: boolean;
  allowedHosts: string[];
  blockedHosts: string[];
}

export interface ResolvedConnectionsSystemSettings {
  mcp: ResolvedMcpSettings;
  google: { enabled: boolean; clientId: string | null };
  microsoft: { enabled: boolean; clientId: string | null; tenant: string };
}

export const CONNECTIONS_SYSTEM_DEFAULTS: ResolvedConnectionsSystemSettings = {
  mcp: { enabled: false, allowedHosts: [], blockedHosts: [] },
  google: { enabled: false, clientId: null },
  microsoft: { enabled: false, clientId: null, tenant: 'common' },
};

export function resolveConnectionsSystemSettings(v: ConnectionsSystemSettings | null | undefined): ResolvedConnectionsSystemSettings {
  const g = v?.providers?.google;
  const m = v?.providers?.microsoft;
  return {
    mcp: { enabled: v?.mcp?.enabled === true, allowedHosts: v?.mcp?.allowedHosts ?? [], blockedHosts: v?.mcp?.blockedHosts ?? [] },
    google: { enabled: g?.enabled === true, clientId: g?.clientId ?? null },
    microsoft: { enabled: m?.enabled === true, clientId: m?.clientId ?? null, tenant: m?.tenant ?? 'common' },
  };
}

const merge = (current: ConnectionsSystemSettings | undefined, patch: ConnectionsSystemSettingsPatch | undefined): ConnectionsSystemSettings => {
  // The platform calls every namespace's merge on every settings write: no patch for this one is the current value.
  const base = resolveConnectionsSystemSettings(current);
  const mcp = {
    enabled: patch?.mcp?.enabled ?? base.mcp.enabled,
    allowedHosts: patch?.mcp?.allowedHosts ?? base.mcp.allowedHosts,
    blockedHosts: patch?.mcp?.blockedHosts ?? base.mcp.blockedHosts,
  };
  const { google, microsoft } = base;
  if (!patch?.providers) return { mcp, providers: { google, microsoft } };
  const g = patch.providers.google;
  const m = patch.providers.microsoft;
  return {
    mcp,
    providers: {
      google: { enabled: g?.enabled ?? google.enabled, clientId: g && 'clientId' in g ? (g.clientId ?? null) : google.clientId },
      microsoft: { enabled: m?.enabled ?? microsoft.enabled, clientId: m && 'clientId' in m ? (m.clientId ?? null) : microsoft.clientId, tenant: m?.tenant ?? microsoft.tenant },
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
  defaults: { providers: { google: CONNECTIONS_SYSTEM_DEFAULTS.google, microsoft: CONNECTIONS_SYSTEM_DEFAULTS.microsoft }, mcp: CONNECTIONS_SYSTEM_DEFAULTS.mcp },
  requiredOnPut: false,
  merge: (current, patch) => merge(current, patch as ConnectionsSystemSettingsPatch | undefined),
} satisfies SystemSettingsNamespace<'connections', ConnectionsSystemSettings, ConnectionsSystemSettingsPatch>;

registerSystemSettingsNamespaces([CONNECTIONS_SYSTEM_SETTINGS as unknown as SystemSettingsNamespace]);

declare module '@marinoscar/platform-api/settings' {
  interface SystemSettingsNamespaces {
    connections: ConnectionsSystemSettings;
  }
}
