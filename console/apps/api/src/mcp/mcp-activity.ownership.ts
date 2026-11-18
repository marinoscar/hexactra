import type { ModelOwnershipDef, UserOwnedModelDef } from '@marinoscar/platform-api/core';

/** The audit trail of external AI apps (#465). */
export const MCP_ACTIVITY_USER_OWNED_MODELS: readonly UserOwnedModelDef<'McpActivity'>[] = [
  {
    model: 'McpActivity',
    ownerField: 'userId',
    purge: 'delete',
    export: 'include',
    rationale: "What external AI apps did with the user's account (sanitized: no typed text, no script, no result): deleted with the user, part of the export.",
  },
];

export const MCP_ACTIVITY_MODEL_OWNERSHIP: readonly ModelOwnershipDef<'McpActivity'>[] = [
  { model: 'McpActivity', kind: 'user', rationale: "One external AI app's call (or refusal) on one user's account." },
];
