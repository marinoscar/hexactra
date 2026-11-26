// Settings of Connections (E39.2, #599): the deployment's apps at Google and Microsoft.
//
//   system `connections` (Administrator, `system_settings:write`)
//     google.enabled / microsoft.enabled   the per-provider switch, default OFF: while off, nobody can connect that provider.
//     google.clientId / microsoft.clientId the OAuth client id of the app the administrator registered (BRING YOUR OWN APP).
//     microsoft.tenant                     `common` (default), `organizations`, `consumers` or a tenant id.
//   user `connections` (the OWNER's own setting, #680)
//     newChats                             DEPRECATED (E50.17): has no effect. Every chat may use everything the owner switched on in
//                                          Connections and tools. Kept so a stored settings document still parses.
//   The client SECRETS are system credentials (`connection_app_google`, `connection_app_microsoft`), write-only.
//     mcp.enabled                          MCP servers as connections (E39.9), default OFF: while off, none can be added or used.
//     mcp.allowedHosts / mcp.blockedHosts  exact host names or `*.example.test` suffixes. Empty allow-list: any public host.
//
// Registered before `SettingsModule.forRoot()` composes the request bodies (the import in src/platform/platform.ts).
import { registerSystemSettingsNamespaces, registerUserSettingsNamespaces, type SystemSettingsNamespace, type UserSettingsNamespace } from '@marinoscar/platform-api/settings';
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
      google: z.object({ enabled: z.boolean().optional(), clientId, pickerApiKey }).optional(),
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
  google: { enabled: boolean; clientId: string | null; pickerApiKey: string | null };
  microsoft: { enabled: boolean; clientId: string | null; tenant: string };
}

export const CONNECTIONS_SYSTEM_DEFAULTS: ResolvedConnectionsSystemSettings = {
  mcp: { enabled: false, allowedHosts: [], blockedHosts: [] },
  google: { enabled: false, clientId: null, pickerApiKey: null },
  microsoft: { enabled: false, clientId: null, tenant: 'common' },
};

export function resolveConnectionsSystemSettings(v: ConnectionsSystemSettings | null | undefined): ResolvedConnectionsSystemSettings {
  const g = v?.providers?.google;
  const m = v?.providers?.microsoft;
  return {
    mcp: { enabled: v?.mcp?.enabled === true, allowedHosts: v?.mcp?.allowedHosts ?? [], blockedHosts: v?.mcp?.blockedHosts ?? [] },
    google: { enabled: g?.enabled === true, clientId: g?.clientId ?? null, pickerApiKey: g?.pickerApiKey ?? null },
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
      google: { enabled: g?.enabled ?? google.enabled, clientId: g && 'clientId' in g ? (g.clientId ?? null) : google.clientId, pickerApiKey: g && 'pickerApiKey' in g ? (g.pickerApiKey ?? null) : google.pickerApiKey },
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
  interface UserSettingsNamespaces {
    connections: ConnectionsUserSettings;
  }
}

// ---- user (#680) ----

/** Deprecated (E50.17): how a new chat used to start. Readable so stored settings still parse; it decides nothing. */
export const NEW_CHAT_ACCOUNTS = ['off', 'read', 'read_write'] as const;
export type NewChatAccounts = (typeof NEW_CHAT_ACCOUNTS)[number];

export const connectionsUserSettingsSchema = z.object({
  newChats: z.enum(NEW_CHAT_ACCOUNTS).describe('Deprecated (E50.17): has no effect. Every chat may use everything you switched on in Connections and tools; each send or change still asks you first. Kept so stored settings still parse.'),
});
export type ConnectionsUserSettings = z.infer<typeof connectionsUserSettingsSchema>;
export const connectionsUserSettingsPatchSchema = connectionsUserSettingsSchema.partial();
export type ConnectionsUserSettingsPatch = z.infer<typeof connectionsUserSettingsPatchSchema>;

export const CONNECTIONS_USER_DEFAULTS: ConnectionsUserSettings = { newChats: 'read_write' };

export const CONNECTIONS_USER_SETTINGS = {
  key: 'connections',
  description: 'Connections: how a new chat starts (your accounts off, read only, or read and change).',
  schema: connectionsUserSettingsSchema,
  patchSchema: connectionsUserSettingsPatchSchema,
  merge: (current: ConnectionsUserSettings | undefined, patch: ConnectionsUserSettingsPatch | null | undefined): ConnectionsUserSettings | undefined => {
    if (patch === null) return undefined;
    if (patch === undefined) return current;
    return { ...CONNECTIONS_USER_DEFAULTS, ...current, ...patch };
  },
} satisfies UserSettingsNamespace<'connections', ConnectionsUserSettings, ConnectionsUserSettingsPatch>;

registerUserSettingsNamespaces([CONNECTIONS_USER_SETTINGS as unknown as UserSettingsNamespace]);
