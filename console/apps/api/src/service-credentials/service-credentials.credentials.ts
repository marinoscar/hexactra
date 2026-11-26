// The credential purpose of service credentials (E50.2, #972). A purpose is the cipher's sub-key domain, so it is PERMANENT once a
// row exists: add one, never rename one.
//
//   service_credential   user, org and system tiers. Name `<service>.<name>` (`web_search.brave`): the key of an outside service
//                        the console itself calls. The user tier is the owner's own key, the org tier their organization's, the
//                        system tier the deployment's. Stored as a small JSON envelope (see `credential-store.binding.ts`), so the
//                        store's masked hint never holds a character of the key.
import type { CredentialPurposeDef, UserCredentialPurposeDef } from '@marinoscar/platform-api/credentials';

export const SERVICE_CREDENTIAL_PURPOSE = 'service_credential';

/** The organization and deployment tiers, for `APP_CREDENTIAL_PURPOSES`. */
export const SERVICE_CREDENTIAL_SYSTEM_PURPOSE: CredentialPurposeDef = {
  purpose: SERVICE_CREDENTIAL_PURPOSE,
  owner: 'service_credentials',
  label: 'Keys of outside services (organization and deployment)',
  tiers: ['system', 'org'],
};

/**
 * The user tier, for `registerUserCredentialPurpose`. No `system` or `org` address: the fallback order (and the narrowing by
 * `allowTiers`) is the service credentials port's, not the platform resolver's, because a purpose holds one key per reference.
 */
export const SERVICE_CREDENTIAL_USER_PURPOSES: readonly UserCredentialPurposeDef[] = [
  {
    purpose: SERVICE_CREDENTIAL_PURPOSE,
    label: 'Keys of outside services',
    description: 'Your own key for a service the console calls for you (a web search provider). Never shown again, never sent anywhere but to that service.',
    system: null,
  },
];
