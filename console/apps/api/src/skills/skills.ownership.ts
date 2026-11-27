import type { ModelOwnershipDef, UserOwnedModelDef } from '@marinoscar/platform-api/core';

/** Skills belong to the user who wrote them (#1008). */
export const SKILLS_USER_OWNED_MODELS: readonly UserOwnedModelDef<'Skill'>[] = [
  {
    model: 'Skill',
    ownerField: 'userId',
    purge: 'delete',
    export: 'include',
    rationale: "The playbooks the user wrote for the agent (how they want a kind of job done): the user's own writing, deleted with the user and part of the user's data export. No Secret Material (refused on write).",
  },
];

export const SKILLS_MODEL_OWNERSHIP: readonly ModelOwnershipDef<'Skill'>[] = [
  { model: 'Skill', kind: 'user', rationale: 'A skill is personal: never shared between users or organizations in this version.' },
];
