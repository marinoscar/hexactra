import type { ModelOwnershipDef, UserOwnedModelDef } from '@marinoscar/platform-api/core';

/** Memories belong to the user who saved them (#551). */
export const MEMORIES_USER_OWNED_MODELS: readonly UserOwnedModelDef<'Memory'>[] = [
  {
    model: 'Memory',
    ownerField: 'userId',
    purge: 'delete',
    export: 'include',
    rationale: "The facts the user let the agent use (people, accounts, preferences): personal data, deleted with the user and part of the user's data export. No Secret Material (refused on write).",
  },
];

export const MEMORIES_MODEL_OWNERSHIP: readonly ModelOwnershipDef<'Memory'>[] = [
  { model: 'Memory', kind: 'user', rationale: 'A memory is personal: never shared between users or organizations.' },
];
