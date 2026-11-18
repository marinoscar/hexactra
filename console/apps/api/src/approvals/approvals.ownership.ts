import type { ModelOwnershipDef, UserOwnedModelDef } from '@marinoscar/platform-api/core';

/** Saved approvals belong to the owner who ticked them (#554); their uses follow the rule. */
export const APPROVALS_USER_OWNED_MODELS: readonly UserOwnedModelDef<'ApprovalRule'>[] = [
  {
    model: 'ApprovalRule',
    ownerField: 'userId',
    purge: 'delete',
    export: 'include',
    rationale: "The user's saved approvals (host, category, normalised label, limits, use counts) and, by cascade, their recent uses: deleted with the user, part of the export. No secret material.",
  },
];

export const APPROVALS_MODEL_OWNERSHIP: readonly ModelOwnershipDef<'ApprovalRule' | 'ApprovalRuleUse'>[] = [
  { model: 'ApprovalRule', kind: 'user', rationale: "A saved approval is one owner's standing decision." },
  { model: 'ApprovalRuleUse', kind: 'user', rationale: 'A use belongs to its rule, reached only through it.' },
];
