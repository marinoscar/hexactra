import type { ModelOwnershipDef, UserOwnedModelDef } from '@marinoscar/platform-api/core';

/** "Improve this task" (E52.8): a proposal belongs to the owner of its task, and goes with the task and the user. */
export const TASK_IMPROVER_USER_OWNED_MODELS: readonly UserOwnedModelDef<'TaskImprovement'>[] = [
  {
    model: 'TaskImprovement',
    ownerField: 'userId',
    purge: 'delete',
    export: 'include',
    rationale: "The user's proposals for better task goals: deleted with the user (and with the task), part of the user's data export.",
  },
];

export const TASK_IMPROVER_MODEL_OWNERSHIP: readonly ModelOwnershipDef<'TaskImprovement'>[] = [
  { model: 'TaskImprovement', kind: 'user', rationale: 'A proposal belongs to the user who asked for it, about their own task.' },
];
