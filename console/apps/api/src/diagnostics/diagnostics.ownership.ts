import type { ModelOwnershipDef, UserOwnedModelDef } from '@marinoscar/platform-api/core';

/** A diagnostic report of a connection belongs to the connection's owner (E50.10, #980). A deployment's target has none (`userId` null). */
export const DIAGNOSTICS_USER_OWNED_MODELS: readonly UserOwnedModelDef<'ConnectionDiagnostic'>[] = [
  {
    model: 'ConnectionDiagnostic',
    ownerField: 'userId',
    purge: 'delete',
    export: 'include',
    rationale: "The last diagnostic reports of the user's connections: the target, the overall status, the stages' codes, counts and timings, the trigger and the time. No content, provider message, address or token. Deleted with the user (and with the connection), part of the export.",
  },
];

export const DIAGNOSTICS_MODEL_OWNERSHIP: readonly ModelOwnershipDef<'ConnectionDiagnostic'>[] = [
  { model: 'ConnectionDiagnostic', kind: 'user', rationale: "A report of one owner's connection; a deployment's target (no owner) is read only by the administrator's routes." },
];
