import type { ModelOwnershipDef, UserOwnedModelDef } from '@marinoscar/platform-api/core';

/** The AI usage rollups (#732): the user's hours, detached on delete like the ledger they sum. */
export const USAGE_USER_OWNED_MODELS: readonly UserOwnedModelDef<'AiUsageHourly'>[] = [
  {
    model: 'AiUsageHourly',
    ownerField: 'userId',
    purge: 'detach',
    export: 'include',
    rationale: "The user's AI usage summed per hour (counts only). Kept, unlinked, so deployment totals stay correct, as the ledger (`AiUsageEvent`).",
  },
];

export const USAGE_MODEL_OWNERSHIP: readonly ModelOwnershipDef<'AiUsageHourly' | 'AiUsageRollupState'>[] = [
  {
    model: 'AiUsageHourly',
    kind: 'system',
    orgReference: 'orgId',
    rationale: 'Deployment-wide AI usage sums, written by one system job and read through the system client; a user sees only rows filtered to their own id, an administrator all.',
  },
  { model: 'AiUsageRollupState', kind: 'system', rationale: 'One row: how far the AI usage rollups go.' },
];
