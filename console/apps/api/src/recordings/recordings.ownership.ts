import type { ModelOwnershipDef, UserOwnedModelDef } from '@marinoscar/platform-api/core';

/**
 * A run recording (epic #755) belongs to the user whose run it is. It is NOT masked: deleted with the user and never part of a data
 * export (the export is a file the user may share; the recording is played only on the run page).
 */
export const RECORDINGS_USER_OWNED_MODELS: readonly UserOwnedModelDef<'RunRecording'>[] = [
  {
    model: 'RunRecording',
    ownerField: 'userId',
    purge: 'delete',
    export: 'exclude',
    rationale: "The video of a run the owner chose to record: unmasked, so deleted with the user and never in an export. Its objects go with the user's run-recordings/ prefix.",
  },
];

export const RECORDINGS_MODEL_OWNERSHIP: readonly ModelOwnershipDef<'RunRecording'>[] = [
  { model: 'RunRecording', kind: 'user', rationale: 'A recording belongs to the user who owns its run.' },
];
