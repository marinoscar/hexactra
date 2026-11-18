import type { ModelOwnershipDef, UserOwnedModelDef } from '@marinoscar/platform-api/core';

/** The limits a user set for each of their AI apps (#464). */
export const CONNECTED_APPS_USER_OWNED_MODELS: readonly UserOwnedModelDef<'ConnectedAppSettings'>[] = [
  {
    model: 'ConnectedAppSettings',
    ownerField: 'userId',
    purge: 'delete',
    export: 'include',
    rationale: "The user's limits for each connected AI app: deleted with the user, part of the export.",
  },
];

export const CONNECTED_APPS_MODEL_OWNERSHIP: readonly ModelOwnershipDef<'ConnectedAppSettings'>[] = [
  { model: 'ConnectedAppSettings', kind: 'user', rationale: 'The limits one user set for one OAuth client.' },
];
