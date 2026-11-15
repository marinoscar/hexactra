import type { ModelOwnershipDef, UserOwnedModelDef } from '@marinoscar/platform-api/core';

/** A question belongs to the person it was asked of. */
export const QUESTIONS_USER_OWNED_MODELS: readonly UserOwnedModelDef<'Question'>[] = [
  {
    model: 'Question',
    ownerField: 'ownerUserId',
    ownerRelation: 'owner',
    purge: 'delete',
    export: 'include',
    rationale: "Questions agents asked the user and the answers (never a secret value): deleted with the user, part of the export.",
  },
];

export const QUESTIONS_MODEL_OWNERSHIP: readonly ModelOwnershipDef<'Question'>[] = [
  { model: 'Question', kind: 'user', rationale: 'A question is asked of one user; single organization deployment.' },
];
