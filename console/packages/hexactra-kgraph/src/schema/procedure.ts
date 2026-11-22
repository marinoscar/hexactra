// Procedures, versions, their states and their evidence.
import { z } from 'zod';
import { accountSchema, edgeSchema, elementSchema, idSchema, outputSchema, parameterSchema, screenSchema, secretRefSchema, siteSchema, timestampSchema } from './core';
import { stepSchema } from './step';

export { VERSION_STATES, versionStateSchema, VERSION_TRANSITIONS, canTransition, assertTransition, IllegalTransition, type VersionState } from './version-state';
import { versionStateSchema } from './version-state';

/** Why a version differs from its parent. `initial`: the first compile. `structural`: promotes after a clean run. `sensitive`: waits for the owner. */
export const changeClassSchema = z.enum(['initial', 'structural', 'sensitive']);
export type ChangeClass = z.infer<typeof changeClassSchema>;

/** Per task: `off` (AI only, nothing captured), `learn` (compile, never execute), `reuse` (execute; the AI repairs). */
export const modeSchema = z.enum(['off', 'learn', 'reuse']);
export type Mode = z.infer<typeof modeSchema>;

/** Counts of what happened to a version or a step. */
export const evidenceSchema = z.object({
  successes: z.number().int().min(0).default(0),
  failures: z.number().int().min(0).default(0),
  repairs: z.number().int().min(0).default(0),
  lastSuccessAt: timestampSchema.nullable().default(null),
  lastFailureAt: timestampSchema.nullable().default(null),
});
export type Evidence = z.infer<typeof evidenceSchema>;

export function emptyEvidence(): Evidence {
  return { successes: 0, failures: 0, repairs: 0, lastSuccessAt: null, lastFailureAt: null };
}

/** One version of a procedure: the whole runnable graph. Immutable once stored, except its `state` and `evidence`. */
export const procedureVersionSchema = z.object({
  id: idSchema,
  procedure: idSchema,
  number: z.number().int().min(1),
  state: versionStateSchema,
  changeClass: changeClassSchema,
  /** The run the version was compiled or repaired from. */
  sourceRun: idSchema.nullable(),
  parent: idSchema.nullable(),
  createdAt: timestampSchema,
  /** The first step to run. */
  entry: idSchema,
  steps: z.array(stepSchema).min(1).max(500),
  edges: z.array(edgeSchema).max(5000).default([]),
  sites: z.array(siteSchema).max(50).default([]),
  accounts: z.array(accountSchema).max(50).default([]),
  secretRefs: z.array(secretRefSchema).max(50).default([]),
  parameters: z.array(parameterSchema).max(50).default([]),
  outputs: z.array(outputSchema).max(50).default([]),
  screens: z.array(screenSchema).max(500).default([]),
  elements: z.array(elementSchema).max(2000).default([]),
  evidence: evidenceSchema.default(emptyEvidence),
  stepEvidence: z.record(idSchema, evidenceSchema).default({}),
});
export type ProcedureVersion = z.infer<typeof procedureVersionSchema>;
export type ProcedureVersionInput = z.input<typeof procedureVersionSchema>;

/** A procedure: one task's learned way of doing its job, across versions. */
export const procedureSchema = z.object({
  id: idSchema,
  owner: idSchema,
  task: idSchema,
  name: z.string().min(1).max(200),
  activeVersion: idSchema.nullable(),
  createdAt: timestampSchema,
  updatedAt: timestampSchema,
});
export type Procedure = z.infer<typeof procedureSchema>;
