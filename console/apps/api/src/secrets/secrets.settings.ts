// Settings of the secrets providers (E37.2, #591).
//
//   system `secrets`  (Administrator, `system_settings:write`)
//     agentUse.enabled     the DEPLOYMENT's kill switch, default OFF: while it is off, `secrets_lookup` answers
//                          "not enabled" and nothing is released, whatever a Vault allows.
//     vault.baseUrl/clientId   an optional deployment-wide default Vault and OAuth client, so owners only press
//                          Connect (the client secret is a system credential, purpose `secrets_vault_client`).
//     vault.allowedHosts   exact host names exempt from the private-address check (an on-premises Vault);
//                          `https` is still required.
//     store.enabled        the built-in store (E37.5) on or off (E37.12, #711), default OFF. A runtime switch: never an
//                          environment variable. Only its key (`SECRETS_STORE_KEY`) is a deployment secret.
//   user `secrets`    the OWNER's switch (default OFF): `agentUse.enabled`; their provider and default for new tasks; and the
//                     registrable domains they chose "Never for this site" for on a "Save this login?" card (E37.4b).
//
// Both switches must be on for anything to be looked up or released. Registered before
// `SettingsModule.forRoot()` composes the request bodies (the import in src/platform/platform.ts).
import { registerSystemSettingsNamespaces, registerUserSettingsNamespaces, type SystemSettingsNamespace, type UserSettingsNamespace } from '@marinoscar/platform-api/settings';
import { z } from 'zod';

const hostName = z.string().trim().toLowerCase().min(1).max(253).regex(/^[a-z0-9.-]+$/, 'A host name, such as vault.example.test');
/** At most this many sites are remembered as "Never for this site". */
export const MAX_NEVER_SAVE_SITES = 200;
const registrableDomainName = z.string().trim().toLowerCase().min(1).max(253).regex(/^[a-z0-9.-]+$/, 'A site such as example.test');
const vaultUrl = z
  .string()
  .trim()
  .max(2048)
  .refine((v) => {
    try {
      const u = new URL(v);
      return u.protocol === 'https:' || u.protocol === 'http:';
    } catch {
      return false;
    }
  }, 'A web address, such as https://vault.example.test');

// ---- system ----

export const secretsSystemSettingsSchema = z.object({
  agentUse: z.object({ enabled: z.boolean().describe('Deployment kill switch for the agent using stored secrets. Off by default.') }),
  store: z
    .object({ enabled: z.boolean().describe("Offer the built-in store (Hexactra's own encrypted store for saved logins) to every owner. Off by default; needs the deployment's SECRETS_STORE_KEY, which the installer generates.") })
    .optional(),
  vault: z
    .object({
      baseUrl: vaultUrl.nullable().optional().describe("The default Vault address owners connect to (`https://vault.example.test`)."),
      clientId: z.string().trim().min(1).max(200).nullable().optional().describe('The OAuth client id Hexactra is registered as at that Vault.'),
      allowedHosts: z.array(hostName).max(20).optional().describe('Vault host names exempt from the private-address check (https is still required).'),
    })
    .optional(),
});
export type SecretsSystemSettings = z.infer<typeof secretsSystemSettingsSchema>;

export const secretsSystemSettingsPatchSchema = z.object({
  agentUse: z.object({ enabled: z.boolean() }).partial().optional(),
  store: z.object({ enabled: z.boolean() }).partial().optional(),
  vault: secretsSystemSettingsSchema.shape.vault.unwrap().partial().optional(),
});
export type SecretsSystemSettingsPatch = z.infer<typeof secretsSystemSettingsPatchSchema>;

export interface ResolvedSecretsSystemSettings {
  agentUse: { enabled: boolean };
  /** The built-in store's switch (#711): null when an administrator never set it (then the deprecated `SECRETS_STORE_ENABLED` decides). */
  store: { enabled: boolean | null };
  vault: { baseUrl: string | null; clientId: string | null; allowedHosts: string[] };
}

export const SECRETS_SYSTEM_DEFAULTS: ResolvedSecretsSystemSettings = { agentUse: { enabled: false }, store: { enabled: null }, vault: { baseUrl: null, clientId: null, allowedHosts: [] } };

/** A stored (or partial) namespace with every missing field at its default. */
export function resolveSecretsSystemSettings(v: Partial<SecretsSystemSettings> | null | undefined): ResolvedSecretsSystemSettings {
  return {
    agentUse: { enabled: v?.agentUse?.enabled === true },
    store: { enabled: typeof v?.store?.enabled === 'boolean' ? v.store.enabled : null },
    vault: {
      baseUrl: v?.vault?.baseUrl ?? null,
      clientId: v?.vault?.clientId ?? null,
      allowedHosts: [...(v?.vault?.allowedHosts ?? [])],
    },
  };
}

/** The stored shape of resolved settings: the store's switch is written only once an administrator set it. */
const storedOf = (r: ResolvedSecretsSystemSettings): SecretsSystemSettings => ({ agentUse: r.agentUse, ...(r.store.enabled !== null ? { store: { enabled: r.store.enabled } } : {}), vault: r.vault });

const mergeSystem = (current: SecretsSystemSettings | undefined, patch: SecretsSystemSettingsPatch | undefined): SecretsSystemSettings => {
  // The platform calls every namespace's merge on every settings write: no patch for this one is the current value.
  if (!patch) return storedOf(resolveSecretsSystemSettings(current));
  const base = resolveSecretsSystemSettings(current);
  return {
    agentUse: { enabled: patch.agentUse?.enabled ?? base.agentUse.enabled },
    ...(patch.store?.enabled !== undefined ? { store: { enabled: patch.store.enabled } } : base.store.enabled !== null ? { store: { enabled: base.store.enabled } } : {}),
    vault: {
      baseUrl: patch.vault && 'baseUrl' in patch.vault ? (patch.vault.baseUrl ?? null) : base.vault.baseUrl,
      clientId: patch.vault && 'clientId' in patch.vault ? (patch.vault.clientId ?? null) : base.vault.clientId,
      allowedHosts: patch.vault?.allowedHosts ?? base.vault.allowedHosts,
    },
  };
};

export const SECRETS_SYSTEM_SETTINGS = {
  key: 'secrets',
  description: 'Secrets the agent can use but never see: the deployment kill switch (off by default), the built-in store on or off (off by default), an optional default Vault address and OAuth client id, and Vault hosts exempt from the private-address check.',
  storedSchema: secretsSystemSettingsSchema,
  patchSchema: secretsSystemSettingsPatchSchema,
  putSchema: secretsSystemSettingsSchema,
  wirePatchSchema: secretsSystemSettingsPatchSchema,
  responseSchema: secretsSystemSettingsSchema,
  defaults: storedOf(SECRETS_SYSTEM_DEFAULTS),
  requiredOnPut: false,
  merge: (current, patch) => mergeSystem(current, patch as SecretsSystemSettingsPatch | undefined),
} satisfies SystemSettingsNamespace<'secrets', SecretsSystemSettings, SecretsSystemSettingsPatch>;

// ---- user ----

/** Which store the owner's agent uses: their Vault, or the console's built-in store (E37.5). One at a time. */
export const SECRETS_PROVIDER_IDS = ['vault', 'builtin'] as const;
export type SecretsProviderId = (typeof SECRETS_PROVIDER_IDS)[number];

export const secretsUserSettingsSchema = z.object({
  provider: z.enum(SECRETS_PROVIDER_IDS).optional().describe('Where the agent finds your saved logins: your Vault (the default) or the built-in store. Switching does not move data.'),
  agentUse: z.object({ enabled: z.boolean().describe('Let the agent use your saved logins and one-time codes on pages (it never sees them). Off by default.') }),
  defaultUseSavedLogins: z
    .boolean()
    .optional()
    .describe('New tasks and chats start with "Sign in with my saved logins" on (E37.3). Off by default. Each task and chat still has its own switch.'),
  neverSaveLoginSites: z
    .array(registrableDomainName)
    .max(MAX_NEVER_SAVE_SITES)
    .optional()
    .describe('Registrable domains the owner chose "Never for this site" for on a "Save this login?" card (E37.4b): the agent does not offer to save a sign-in there. Empty by default.'),
});
export type SecretsUserSettings = z.infer<typeof secretsUserSettingsSchema>;
export const secretsUserSettingsPatchSchema = z.object({
  provider: z.enum(SECRETS_PROVIDER_IDS).optional(),
  agentUse: z.object({ enabled: z.boolean() }).partial().optional(),
  defaultUseSavedLogins: z.boolean().optional(),
  neverSaveLoginSites: z.array(registrableDomainName).max(MAX_NEVER_SAVE_SITES).optional(),
});
type SecretsUserPatch = z.infer<typeof secretsUserSettingsPatchSchema>;

/** The owner's switch as stored in their settings document (off when never set). */
export function secretsAgentUseOf(doc: unknown): boolean {
  return (doc as { secrets?: { agentUse?: { enabled?: unknown } } } | null | undefined)?.secrets?.agentUse?.enabled === true;
}

/** The owner's chosen provider as stored (`vault` when never set). */
export function secretsProviderOf(doc: unknown): SecretsProviderId {
  const v = (doc as { secrets?: { provider?: unknown } } | null | undefined)?.secrets?.provider;
  return v === 'builtin' ? 'builtin' : 'vault';
}

/** Whether new tasks and chats start with saved logins on, as stored in the owner's settings document (off when never set). */
export function secretsDefaultUseSavedLoginsOf(doc: unknown): boolean {
  return (doc as { secrets?: { defaultUseSavedLogins?: unknown } } | null | undefined)?.secrets?.defaultUseSavedLogins === true;
}

/** The sites the owner chose "Never for this site" for (E37.4b), as stored in their settings document. */
export function neverSaveLoginSitesOf(doc: unknown): string[] {
  const v = (doc as { secrets?: { neverSaveLoginSites?: unknown } } | null | undefined)?.secrets?.neverSaveLoginSites;
  return Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : [];
}

export const SECRETS_USER_SETTINGS = {
  key: 'secrets',
  description: 'Secrets: whether the agent may use your saved logins and one-time codes (off by default), and whether new tasks and chats start with them on (off by default).',
  schema: secretsUserSettingsSchema,
  patchSchema: secretsUserSettingsPatchSchema,
  defaults: { agentUse: { enabled: false }, defaultUseSavedLogins: false },
  merge: (current: SecretsUserSettings | undefined, patch: SecretsUserPatch | null | undefined): SecretsUserSettings | undefined => {
    if (patch === null) return undefined;
    if (patch === undefined) return current;
    const enabled = patch.agentUse?.enabled ?? current?.agentUse?.enabled ?? false;
    const useByDefault = patch.defaultUseSavedLogins ?? current?.defaultUseSavedLogins ?? false;
    const provider = patch.provider ?? current?.provider;
    const never = [...new Set(patch.neverSaveLoginSites ?? current?.neverSaveLoginSites ?? [])];
    // Defaults are never stored: `vault`, "off", "off" and no site.
    if (!enabled && !useByDefault && provider !== 'builtin' && never.length === 0) return undefined;
    return { agentUse: { enabled }, ...(useByDefault ? { defaultUseSavedLogins: true } : {}), ...(provider === 'builtin' ? { provider } : {}), ...(never.length > 0 ? { neverSaveLoginSites: never } : {}) };
  },
} satisfies Omit<UserSettingsNamespace<'secrets', SecretsUserSettings, SecretsUserPatch>, never> & { defaults: SecretsUserSettings };

registerSystemSettingsNamespaces([SECRETS_SYSTEM_SETTINGS as unknown as SystemSettingsNamespace]);
registerUserSettingsNamespaces([SECRETS_USER_SETTINGS as unknown as UserSettingsNamespace]);

declare module '@marinoscar/platform-api/settings' {
  interface SystemSettingsNamespaces {
    secrets: SecretsSystemSettings;
  }
  interface UserSettingsNamespaces {
    secrets: SecretsUserSettings;
  }
}
