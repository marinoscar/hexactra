import type { ModelOwnershipDef, UserOwnedModelDef } from '@marinoscar/platform-api/core';

const KG_MODELS = ['KgTaskSettings', 'KgRun', 'KgNode', 'KgEdge', 'KgProcedure', 'KgProcedureVersion', 'KgEvidence', 'KgReview'] as const;
type KgModel = (typeof KG_MODELS)[number];

/** The Knowledge Graph belongs to the user whose runs it learned from (E46.3, #777). */
export const KGRAPH_USER_OWNED_MODELS: readonly UserOwnedModelDef<KgModel>[] = KG_MODELS.map((model) => ({
  model,
  ownerField: 'userId',
  purge: 'delete' as const,
  export: 'include' as const,
  rationale: "What the agent learned from the user's own saved-task runs (procedures, their versions and evidence, the per-task and per-run settings): deleted with the user and part of the user's data export. Labels and references only, never a typed value or a secret.",
}));

export const KGRAPH_MODEL_OWNERSHIP: readonly ModelOwnershipDef<KgModel>[] = KG_MODELS.map((model) => ({
  model,
  kind: 'user' as const,
  rationale: "A user's Knowledge Graph is private: never shared between users or organizations.",
}));
