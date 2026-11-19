import type { ModelOwnershipDef, UserOwnedModelDef } from '@marinoscar/platform-api/core';

/**
 * A connection belongs to the owner who connected it (E39.2, #599). Its tokens are the credential store's own `UserCredential`
 * rows (purpose `connection_token`), removed with the user by that registry.
 */
export const CONNECTIONS_USER_OWNED_MODELS: readonly UserOwnedModelDef<'Connection' | 'ConnectionFlow'>[] = [
  {
    model: 'Connection',
    ownerField: 'userId',
    purge: 'delete',
    export: 'include',
    rationale: "The user's connected accounts: provider, the account's id and email, the label, which capabilities are on, the granted permissions, defaults, status and times. No token (those are encrypted credential rows). Deleted with the user, part of the export.",
  },
  {
    model: 'ConnectionFlow',
    ownerField: 'userId',
    purge: 'delete',
    export: 'exclude',
    rationale: 'A connection in progress: hashes of the state and the browser binding, valid for ten minutes. Transient and secret-adjacent: deleted with the user, never exported.',
  },
];

export const CONNECTIONS_MODEL_OWNERSHIP: readonly ModelOwnershipDef<'Connection' | 'ConnectionFlow'>[] = [
  { model: 'Connection', kind: 'user', rationale: "A connection is one owner's account at a provider; never shared between users." },
  { model: 'ConnectionFlow', kind: 'user', rationale: "One owner's Connect in progress." },
];
