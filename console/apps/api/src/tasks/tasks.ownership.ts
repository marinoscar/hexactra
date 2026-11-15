import type { ModelOwnershipDef, UserOwnedModelDef } from '@marinoscar/platform-api/core';

/** Tasks and runs belong to the user who created them (RunStep follows its Run). */
export const TASKS_USER_OWNED_MODELS: readonly UserOwnedModelDef<'Task' | 'Run' | 'TaskSchedule'>[] = [
  {
    model: 'TaskSchedule',
    ownerField: 'userId',
    purge: 'delete',
    export: 'include',
    rationale: "The user's task schedules: deleted with the user, part of the export.",
  },
  {
    model: 'Task',
    ownerField: 'userId',
    purge: 'delete',
    export: 'include',
    rationale: "The user's browser tasks: deleted with the user, part of the user's data export.",
  },
  {
    model: 'Run',
    ownerField: 'userId',
    purge: 'delete',
    export: 'include',
    rationale: "The user's runs and their steps (redacted): deleted with the user, part of the export.",
  },
];

export const TASKS_MODEL_OWNERSHIP: readonly ModelOwnershipDef<'Task' | 'Run' | 'RunStep' | 'TaskSchedule' | 'ActionToken'>[] = [
  { model: 'TaskSchedule', kind: 'user', rationale: 'A schedule belongs to the user who set it.' },
  { model: 'Task', kind: 'user', rationale: 'A task is the goal one user set; single organization deployment.' },
  { model: 'Run', kind: 'user', rationale: 'A run belongs to the user who started it.' },
  { model: 'RunStep', kind: 'user', rationale: 'A step belongs to its run, reached only through it.' },
  { model: 'ActionToken', kind: 'system', rationale: 'The sha256 of single-use notification and webhook answer tokens: deployment-wide, no owner column, purged after expiry.' },
];
