// Settings of the secrets providers (E37.2, #591).
//
//   system `secrets`  (Administrator, `system_settings:write`)
//     agentUse.enabled     the DEPLOYMENT's kill switch, default OFF: while it is off, `secrets_lookup` answers
//                          "not enabled" and nothing is released, whatever a Vault allows.
//     vault.baseUrl/clientId   an optional deployment-wide default Vault and OAuth client, so owners only press
//                          Connect (the client secret is a system credential, purpose `secrets_vault_client`).
//     vault.allowedHosts   exact host names exempt from the private-address check (an on-premises Vault);
//                          `https` is still required.
//   user `secrets`    the OWNER's switch (default OFF): `agentUse.enabled`.
//
// Both switches must be on for anything to be looked up or released. Registered before
// `SettingsModule.forRoot()` composes the request bodies (the import in src/platform/platform.ts).
import { registerSystemSettingsNamespaces, registerUserSettingsNamespaces, type SystemSettingsNamespace, type UserSettingsNamespace } from '@marinoscar/platform-api/settings';
import { z } from 'zod';

const hostName = z.string().trim().toLowerCase().min(1).max(253).regex(/^[a-z0-9.-]+$/, 'A host name, such as vault.example.test');
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
  vault: secretsSystemSettingsSchema.shape.vault.unwrap().partial().optional(),
});
export type SecretsSystemSettingsPatch = z.infer<typeof secretsSystemSettingsPatchSchema>;

export interface ResolvedSecretsSystemSettings {
  agentUse: { enabled: boolean };
  vault: { baseUrl: string | null; clientId: string | null; allowedHosts: string[] };
}

export const SECRETS_SYSTEM_DEFAULTS: ResolvedSecretsSystemSettings = { agentUse: { enabled: false }, vault: { baseUrl: null, clientId: null, allowedHosts: [] } };

/** A stored (or partial) namespace with every missing field at its default. */
export function resolveSecretsSystemSettings(v: Partial<SecretsSystemSettings> | null | undefined): ResolvedSecretsSystemSettings {
  return {
    agentUse: { enabled: v?.agentUse?.enabled === true },
    vault: {
      baseUrl: v?.vault?.baseUrl ?? null,
      clientId: v?.vault?.clientId ?? null,
      allowedHosts: [...(v?.vault?.allowedHosts ?? [])],
    },
  };
}

const mergeSystem = (current: SecretsSystemSettings | undefined, patch: SecretsSystemSettingsPatch | undefined): SecretsSystemSettings => {
  // The platform calls every namespace's merge on every settings write: no patch for this one is the current value.
  if (!patch) return resolveSecretsSystemSettings(current);
  const base = resolveSecretsSystemSettings(current);
  return {
    agentUse: { enabled: patch.agentUse?.enabled ?? base.agentUse.enabled },
    vault: {
      baseUrl: patch.vault && 'baseUrl' in patch.vault ? (patch.vault.baseUrl ?? null) : base.vault.baseUrl,
      clientId: patch.vault && 'clientId' in patch.vault ? (patch.vault.clientId ?? null) : base.vault.clientId,
      allowedHosts: patch.vault?.allowedHosts ?? base.vault.allowedHosts,
    },
  };
};

export const SECRETS_SYSTEM_SETTINGS = {
  key: 'secrets',
  description: 'Secrets the agent can use but never see: the deployment kill switch (off by default), an optional default Vault address and OAuth client id, and Vault hosts exempt from the private-address check.',
  storedSchema: secretsSystemSettingsSchema,
  patchSchema: secretsSystemSettingsPatchSchema,
  putSchema: secretsSystemSettingsSchema,
  wirePatchSchema: secretsSystemSettingsPatchSchema,
  responseSchema: secretsSystemSettingsSchema,
  defaults: SECRETS_SYSTEM_DEFAULTS,
  requiredOnPut: false,
  merge: (current, patch) => mergeSystem(current, patch as SecretsSystemSettingsPatch | undefined),
} satisfies SystemSettingsNamespace<'secrets', SecretsSystemSettings, SecretsSystemSettingsPatch>;

// ---- user ----

export const secretsUserSettingsSchema = z.object({
  agentUse: z.object({ enabled: z.boolean().describe('Let the agent use your saved logins and one-time codes on pages (it never sees them). Off by default.') }),
});
export type SecretsUserSettings = z.infer<typeof secretsUserSettingsSchema>;
export const secretsUserSettingsPatchSchema = z.object({ agentUse: z.object({ enabled: z.boolean() }).partial().optional() });
type SecretsUserPatch = z.infer<typeof secretsUserSettingsPatchSchema>;

/** The owner's switch as stored in their settings document (off when never set). */
export function secretsAgentUseOf(doc: unknown): boolean {
  return (doc as { secrets?: { agentUse?: { enabled?: unknown } } } | null | undefined)?.secrets?.agentUse?.enabled === true;
}

export const SECRETS_USER_SETTINGS = {
  key: 'secrets',
  description: 'Secrets: whether the agent may use your saved logins and one-time codes (off by default).',
  schema: secretsUserSettingsSchema,
  patchSchema: secretsUserSettingsPatchSchema,
  defaults: { agentUse: { enabled: false } },
  merge: (current: SecretsUserSettings | undefined, patch: SecretsUserPatch | null | undefined): SecretsUserSettings | undefined => {
    if (patch === null) return undefined;
    if (patch === undefined) return current;
    const enabled = patch.agentUse?.enabled ?? current?.agentUse.enabled ?? false;
    // The default is never stored.
    return enabled ? { agentUse: { enabled } } : undefined;
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
