// The service credentials port (E50.2, #972; epic E50 Design §3, decision record `docs/decisions/web-search.md` §3).
//
// One place that keeps the key of an outside service the console itself calls (a search provider today), in three tiers like AI
// keys: the user's own, the organization's, the deployment's. A caller asks for a key by reference and never knows where it is
// stored. The first binding is the platform's encrypted credential store (`credential-store.binding.ts`); E50.3 may bind the user
// tier to the owner's Vault or the built-in store. The organization and deployment tiers stay in the credential store.
//
// A value is `SecretBytes`: the caller wipes it after the request. It never reaches an API response, a log line, a span, an audit
// row, an export or a model's context.
import type { SecretBytes } from '../secrets/secrets-provider.port';

export interface ServiceCredentialRef {
  /** `web_search`. Permanent once a key exists. */
  service: string;
  /** `brave`. Permanent once a key exists. */
  name: string;
}

export type CredentialTier = 'user' | 'organization' | 'system';

/** Where a tier's key is kept. */
export type Binding = 'credential_store' | 'vault' | 'builtin';

/** Whose request this is. `orgId` is the principal's active organization (never request input); without it the organization tier is skipped. */
export interface Who {
  userId: string;
  orgId: string | null;
}

export interface ServiceCredentialResolveOptions {
  /**
   * Narrows the tiers consulted (the order stays user, organization, system). E50.5 leaves out `system` when the administrator did
   * not share the deployment's key. Absent: every tier.
   */
  allowTiers?: readonly CredentialTier[];
}

export interface ServiceCredentialStatus {
  /** The tier `resolve` would answer from, or `null` when no allowed tier holds a key. */
  tier: CredentialTier | null;
  /** Where that tier's key is kept (the user tier's binding when no key is set). */
  binding: Binding;
  /** When the answering key was stored, from the store's row time. Never a part of the value: no last characters, no length. */
  setAt: string | null;
  /** Which tiers hold a key, whether allowed or not. */
  tiers: Record<CredentialTier, boolean>;
}

export interface ServiceCredentialPort {
  /** SERVER-SIDE ONLY: the value of the first tier, in order user, organization, system, that holds a key; `null` when none. */
  resolve(ref: ServiceCredentialRef, who: Who, opts?: ServiceCredentialResolveOptions): Promise<{ tier: CredentialTier; value: SecretBytes } | null>;
  /** Which tiers hold a key and which one answers. Never a value. */
  status(ref: ServiceCredentialRef, who: Who, opts?: ServiceCredentialResolveOptions): Promise<ServiceCredentialStatus>;
  /** Stores `value` in `tier` (the user's own, their active organization's, or the deployment's). Refused for an unregistered reference. */
  set(ref: ServiceCredentialRef, tier: CredentialTier, who: Who, value: SecretBytes): Promise<void>;
  /** Removes the key in `tier`. Idempotent. */
  delete(ref: ServiceCredentialRef, tier: CredentialTier, who: Who): Promise<void>;
}

/** DI token of the port. */
export const SERVICE_CREDENTIAL_PORT = Symbol('SERVICE_CREDENTIAL_PORT');

/** The tiers in resolution order. */
export const CREDENTIAL_TIERS: readonly CredentialTier[] = ['user', 'organization', 'system'];

/** `service` and `name`: lower-case identifiers, permanent once a key exists. */
export const SERVICE_CREDENTIAL_ID_PATTERN = /^[a-z][a-z0-9_]{0,39}$/;

export const isServiceCredentialRef = (ref: ServiceCredentialRef): boolean => SERVICE_CREDENTIAL_ID_PATTERN.test(ref.service) && SERVICE_CREDENTIAL_ID_PATTERN.test(ref.name);

/** The stored name of a reference: `<service>.<name>`. */
export const storedName = (ref: ServiceCredentialRef): string => `${ref.service}.${ref.name}`;
