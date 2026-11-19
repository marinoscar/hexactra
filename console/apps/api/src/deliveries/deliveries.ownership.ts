import type { ModelOwnershipDef, UserOwnedModelDef } from '@marinoscar/platform-api/core';

/** What the owner set up to be sent after a run, the log of what was sent, and the recipients the owner confirmed (E39.6, #603). */
export const DELIVERIES_USER_OWNED_MODELS: readonly UserOwnedModelDef<'TaskDelivery' | 'RunDelivery' | 'DeliveryRecipient'>[] = [
  {
    model: 'TaskDelivery',
    ownerField: 'userId',
    purge: 'delete',
    export: 'include',
    rationale: "The user's delivery settings on their tasks (recipients, destinations, file names; never a secret): deleted with the user, part of the export.",
  },
  {
    model: 'RunDelivery',
    ownerField: 'userId',
    purge: 'delete',
    export: 'include',
    rationale: 'The log of what was sent for each run (status, attempts, a safe code; never content): deleted with the user, part of the export.',
  },
  {
    model: 'DeliveryRecipient',
    ownerField: 'userId',
    purge: 'delete',
    export: 'include',
    rationale: 'The addresses the user confirmed as recipients of their run reports: deleted with the user, part of the export.',
  },
];

export const DELIVERIES_MODEL_OWNERSHIP: readonly ModelOwnershipDef<'TaskDelivery' | 'RunDelivery' | 'DeliveryRecipient'>[] = [
  { model: 'TaskDelivery', kind: 'user', rationale: 'A delivery belongs to the user who configured it on their task.' },
  { model: 'RunDelivery', kind: 'user', rationale: 'A delivery log row belongs to the owner of the run it is about.' },
  { model: 'DeliveryRecipient', kind: 'user', rationale: 'A confirmed recipient belongs to the user who confirmed it.' },
];
