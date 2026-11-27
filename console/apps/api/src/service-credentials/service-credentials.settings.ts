// The owner's choice of where their own keys of outside services are kept (E50.3, #973; decision record
// `docs/decisions/web-search.md` §3).
//
//   user `serviceCredentials`
//     binding      `credential_store` (default): the console's encrypted credential store. `secrets_provider`: the owner's active
//                  secrets provider (`secrets.provider`: their Vault or the built-in store), next to their saved logins. Where a
//                  NEW key of theirs goes.
//     keys         where each of their keys IS, by reference (`web_search.brave`): written by the server when a key is set or
//                  moved, so changing `binding` later never strands a key that is already stored.
//
// Only the USER tier has a choice. The organization's and the deployment's keys always stay in the credential store. Registered
// before `SettingsModule.forRoot()` composes the request bodies (the import in src/platform/platform.ts).
import { registerUserSettingsNamespaces, type UserSettingsNamespace } from '@marinoscar/platform-api/settings';
import { z } from 'zod';

export const USER_BINDINGS = ['credential_store', 'secrets_provider'] as const;
export type UserBinding = (typeof USER_BINDINGS)[number];

/** `<service>.<name>`, both `SERVICE_CREDENTIAL_ID_PATTERN`. */
const storedNameKey = z.string().regex(/^[a-z][a-z0-9_]{0,39}\.[a-z][a-z0-9_]{0,39}$/, 'A key reference such as web_search.brave');

export const serviceCredentialsUserSettingsSchema = z.object({
  binding: z.enum(USER_BINDINGS).describe('Where a new key of yours for an outside service is kept: the console (`credential_store`, the default) or your secrets provider (`secrets_provider`: your Vault or the built-in store).'),
  keys: z.record(storedNameKey, z.enum(USER_BINDINGS)).optional().describe('Where each of your keys is kept, by reference (`web_search.brave`). Written when a key is set or moved.'),
});
export type ServiceCredentialsUserSettings = z.infer<typeof serviceCredentialsUserSettingsSchema>;
export const serviceCredentialsUserSettingsPatchSchema = z.object({
  binding: z.enum(USER_BINDINGS).optional(),
  keys: z.record(storedNameKey, z.enum(USER_BINDINGS)).optional(),
});
export type ServiceCredentialsUserSettingsPatch = z.infer<typeof serviceCredentialsUserSettingsPatchSchema>;

export const SERVICE_CREDENTIALS_USER_DEFAULTS: ServiceCredentialsUserSettings = { binding: 'credential_store' };

/** The owner's settings from their settings document; the defaults when never saved or not valid. */
export function serviceCredentialsUserOf(doc: unknown): ServiceCredentialsUserSettings {
  const raw = (doc as { serviceCredentials?: unknown } | null | undefined)?.serviceCredentials;
  const parsed = serviceCredentialsUserSettingsPatchSchema.safeParse(raw ?? {});
  return { ...SERVICE_CREDENTIALS_USER_DEFAULTS, ...(parsed.success ? parsed.data : {}) };
}

/** Where the owner's key `storedName` is kept: its own entry, else their default. */
export function userBindingOf(settings: ServiceCredentialsUserSettings, storedName: string): UserBinding {
  return settings.keys?.[storedName] ?? settings.binding;
}

export const SERVICE_CREDENTIALS_USER_SETTINGS = {
  key: 'serviceCredentials',
  description: 'Keys of outside services: whether your own keys are kept in the console or in your secrets provider.',
  schema: serviceCredentialsUserSettingsSchema,
  patchSchema: serviceCredentialsUserSettingsPatchSchema,
  merge: (current: ServiceCredentialsUserSettings | undefined, patch: ServiceCredentialsUserSettingsPatch | null | undefined): ServiceCredentialsUserSettings | undefined => {
    if (patch === null) return undefined;
    if (patch === undefined) return current;
    const keys = { ...(current?.keys ?? {}), ...(patch.keys ?? {}) };
    return { binding: patch.binding ?? current?.binding ?? 'credential_store', ...(Object.keys(keys).length > 0 ? { keys } : {}) };
  },
} satisfies UserSettingsNamespace<'serviceCredentials', ServiceCredentialsUserSettings, ServiceCredentialsUserSettingsPatch>;

registerUserSettingsNamespaces([SERVICE_CREDENTIALS_USER_SETTINGS as unknown as UserSettingsNamespace]);

declare module '@marinoscar/platform-api/settings' {
  interface UserSettingsNamespaces {
    serviceCredentials: ServiceCredentialsUserSettings;
  }
}
