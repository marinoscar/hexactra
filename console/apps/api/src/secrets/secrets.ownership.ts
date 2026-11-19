import type { ModelOwnershipDef, UserOwnedModelDef } from '@marinoscar/platform-api/core';

/**
 * A secrets connection belongs to the owner who connected it (E37.2, #591). Its tokens are the credential
 * store's own `UserCredential` rows (purpose `secrets_vault_grant`), removed with the user by that registry.
 */
export const SECRETS_USER_OWNED_MODELS: readonly UserOwnedModelDef<'SecretsConnection' | 'SecretsActivity'>[] = [
  {
    model: 'SecretsConnection',
    ownerField: 'userId',
    purge: 'delete',
    export: 'include',
    rationale: "The user's connection to their Vault: address, client id, granted scopes, status and times. No token, client secret or password (those are encrypted credential rows). Deleted with the user, part of the export.",
  },
  {
    model: 'SecretsActivity',
    ownerField: 'userId',
    purge: 'delete',
    export: 'include',
    rationale: 'What the agent did with the user\'s saved secrets (E37.4): when, the run, the site, which field kind was typed and the outcome code. Value-free by construction (no username, password or code). Deleted with the user, part of the export.',
  },
];

export const SECRETS_MODEL_OWNERSHIP: readonly ModelOwnershipDef<'SecretsConnection' | 'SecretsActivity'>[] = [
  { model: 'SecretsConnection', kind: 'user', rationale: "A connection is one owner's grant to their own Vault." },
  { model: 'SecretsActivity', kind: 'user', rationale: "One provider action of the agent on one owner's saved secrets." },
];
