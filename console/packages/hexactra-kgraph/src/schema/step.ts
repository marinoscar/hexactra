// Steps, bindings and checks: what a procedure does, where each argument comes from, and how a step proves it worked.
import { z } from 'zod';
import { idSchema, labelSchema } from './core';

// ---------------------------------------------------------------- bindings

/** A literal value. It carries a value only when the value passed the sensitive-value check; the validator rejects one that does not. */
export const literalBindingSchema = z.object({ kind: z.literal('literal'), value: z.union([z.string().max(2000), z.number(), z.boolean(), z.null()]) }).strict();
/** A declared task parameter, filled by the run's own inputs. */
export const parameterBindingSchema = z.object({ kind: z.literal('parameter'), parameter: idSchema }).strict();
/** An earlier step's output; `path` selects a field of a structured result (`a.b.0.c`). */
export const outputBindingSchema = z.object({ kind: z.literal('output'), step: idSchema, path: z.string().max(200).optional() }).strict();
/** A field of an earlier judge step's fixed-schema result. */
export const judgeBindingSchema = z.object({ kind: z.literal('judge'), step: idSchema, field: z.string().min(1).max(100) }).strict();
/** A saved login, identity or card, by reference: the host's secret path types it; the graph never holds the value. */
export const secretBindingSchema = z.object({ kind: z.literal('secret'), ref: idSchema, field: z.string().min(1).max(64) }).strict();

export const bindingSchema = z.discriminatedUnion('kind', [literalBindingSchema, parameterBindingSchema, outputBindingSchema, judgeBindingSchema, secretBindingSchema]);
export type Binding = z.infer<typeof bindingSchema>;
export type BindingKind = Binding['kind'];

// ---------------------------------------------------------------- checks

/** How far an observation may drift and still pass: 0 is exact, 1 accepts anything. */
const tolerance = z.number().min(0).max(1).default(0);

/** The page is on this host (registrable domain or host) and its path matches the pattern (`*` matches one path segment, `**` any). */
export const locationCheckSchema = z.object({ kind: z.literal('location'), host: z.string().min(1).max(253), pathPattern: z.string().max(500).default('**'), tolerance }).strict();
/** The view digest (a hash of the page's structure, not its text) is within `tolerance` of the recorded one. */
export const viewDigestCheckSchema = z.object({ kind: z.literal('view_digest'), digest: z.string().min(1).max(200), tolerance }).strict();
/** An element is present: by surface-graph element id, by selector, or both. */
export const elementPresentCheckSchema = z
  .object({ kind: z.literal('element_present'), element: idSchema.optional(), selector: z.string().min(1).max(500).optional(), tolerance })
  .strict()
  .refine((c) => c.element !== undefined || c.selector !== undefined, 'an element_present check names an element or a selector');
/** A step's result has this shape: `ok` as given, and these field paths present. */
export const resultShapeCheckSchema = z
  .object({ kind: z.literal('result_shape'), step: idSchema, ok: z.boolean().default(true), fields: z.array(z.string().min(1).max(200)).max(50).default([]), tolerance })
  .strict();

export const checkSchema = z.union([locationCheckSchema, viewDigestCheckSchema, elementPresentCheckSchema, resultShapeCheckSchema]);
export type Check = z.infer<typeof checkSchema>;
export type CheckKind = Check['kind'];

// ---------------------------------------------------------------- steps

export const STEP_KINDS = ['call', 'extract', 'judge', 'ask', 'check', 'branch', 'foreach'] as const;
export type StepKind = (typeof STEP_KINDS)[number];

const stepBase = {
  id: idSchema,
  label: labelSchema,
  /** Sites (by `Site.id`) the step touches; every one must be declared on the version. */
  sites: z.array(idSchema).max(20).default([]),
  /** A commit-class step is intent-recorded and never repeated when its outcome is unknown. */
  commitClass: z.boolean().default(false),
  /** The segment the step belongs to: consecutive steps reused or invalidated together. */
  segment: idSchema.optional(),
  /** Postconditions run after the step. */
  checks: z.array(checkSchema).max(10).default([]),
  /** The screen and element the step acts on (browser steps). */
  screen: idSchema.optional(),
  element: idSchema.optional(),
};

/** A tool call with bound arguments. */
export const callStepSchema = z.object({ ...stepBase, kind: z.literal('call'), tool: z.string().min(1).max(64), args: z.record(z.string().max(100), bindingSchema).default({}) }).strict();
/** Read a value from an earlier step's result: a field path of a structured result, or the first match of a bounded pattern in its text. */
export const extractStepSchema = z
  .object({ ...stepBase, kind: z.literal('extract'), from: idSchema, path: z.string().max(200).optional(), pattern: z.string().max(200).optional(), sensitive: z.boolean().default(false) })
  .strict();

/** One field of a judge step's fixed output schema. */
export const judgeFieldSchema = z.object({ name: z.string().min(1).max(100), type: z.enum(['string', 'number', 'boolean', 'enum']), values: z.array(z.string().max(100)).max(50).optional() }).strict();
export type JudgeField = z.infer<typeof judgeFieldSchema>;
/**
 * One small model call with a fixed output schema. It holds no free-text instruction from a run: the host gives the judge the task's goal (the
 * owner's words), these declared inputs and this output schema, nothing else. The object is strict, so an `instruction` field is rejected.
 */
export const judgeStepSchema = z.object({ ...stepBase, kind: z.literal('judge'), inputs: z.record(z.string().max(100), bindingSchema).default({}), output: z.array(judgeFieldSchema).min(1).max(20) }).strict();
/** The owner is asked. The gates decide when; `reason` says why the procedure needs them. */
export const askStepSchema = z.object({ ...stepBase, kind: z.literal('ask'), reason: z.enum(['confirm', 'missing_input', 'choice']) }).strict();
/** A postcondition on its own (the checks in `checks` are the whole step). */
export const checkStepSchema = z.object({ ...stepBase, kind: z.literal('check') }).strict();
/** A guard on observed state: when `guard` passes, control goes to `then`, otherwise to `else`. */
export const branchStepSchema = z.object({ ...stepBase, kind: z.literal('branch'), guard: checkSchema, then: idSchema, else: idSchema }).strict();
/** Repeat `body` (step ids, in order) once per item of a list output; `as` names the item for the body's `output` bindings. */
export const foreachStepSchema = z.object({ ...stepBase, kind: z.literal('foreach'), over: bindingSchema, as: z.string().min(1).max(64), body: z.array(idSchema).min(1).max(100), maxItems: z.number().int().min(1).max(1000).default(100) }).strict();

export const stepSchema = z.discriminatedUnion('kind', [callStepSchema, extractStepSchema, judgeStepSchema, askStepSchema, checkStepSchema, branchStepSchema, foreachStepSchema]);
export type Step = z.infer<typeof stepSchema>;
export type CallStep = z.infer<typeof callStepSchema>;
export type ExtractStep = z.infer<typeof extractStepSchema>;
export type JudgeStep = z.infer<typeof judgeStepSchema>;
export type AskStep = z.infer<typeof askStepSchema>;
export type CheckStep = z.infer<typeof checkStepSchema>;
export type BranchStep = z.infer<typeof branchStepSchema>;
export type ForeachStep = z.infer<typeof foreachStepSchema>;
