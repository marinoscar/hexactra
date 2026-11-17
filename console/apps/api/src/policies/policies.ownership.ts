import type { ModelOwnershipDef, UserOwnedModelDef } from '@marinoscar/platform-api/core';

/** Agent policies belong to the user who made them. */
export const POLICIES_USER_OWNED_MODELS: readonly UserOwnedModelDef<'AgentPolicy'>[] = [
  {
    model: 'AgentPolicy',
    ownerField: 'userId',
    purge: 'delete',
    export: 'include',
    rationale: "The user's agent policies (model tiers, budgets, stall and context settings): deleted with the user, part of the user's data export. No secret material.",
  },
];

export const POLICIES_MODEL_OWNERSHIP: readonly ModelOwnershipDef<'AgentPolicy'>[] = [
  { model: 'AgentPolicy', kind: 'user', rationale: 'A policy is personal: it belongs to the user who made it.' },
];
