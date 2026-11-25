import type { ModelOwnershipDef, UserOwnedModelDef } from '@marinoscar/platform-api/core';

/**
 * A guided profile sign-in (E48.4) belongs to the person who started it. It holds the host, the profile name and the outcome, never
 * an email: deleted with the user, and part of the user's data export.
 */
export const PROFILE_SIGNIN_USER_OWNED_MODELS: readonly UserOwnedModelDef<'ProfileSigninSession'>[] = [
  {
    model: 'ProfileSigninSession',
    ownerField: 'userId',
    purge: 'delete',
    export: 'include',
    rationale: 'The guided Google sign-ins a person started on a node (host, profile, outcome; no email): deleted with the user, part of their export.',
  },
];

export const PROFILE_SIGNIN_MODEL_OWNERSHIP: readonly ModelOwnershipDef<'ProfileSigninSession'>[] = [
  { model: 'ProfileSigninSession', kind: 'user', rationale: 'A guided sign-in is the act of the person who started it.' },
];
