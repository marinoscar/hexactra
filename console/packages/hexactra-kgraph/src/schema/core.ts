// The typed graph (the ontology) of the Knowledge Graph: every node, edge, step, binding, check, version and evidence record, as zod schemas
// with their inferred types. Stable string ids everywhere. Nothing here holds a secret value: a secret is a `SecretRef` (a label), a sensitive
// task input is a `Parameter` marked `sensitive`, and a `literal` binding carries a value only after it passed the sensitive-value check
// (`src/validate/`).
import { z } from 'zod';

/** A stable id: letters, digits and `._:-`, 1–200 characters. */
export const idSchema = z.string().min(1).max(200).regex(/^[A-Za-z0-9._:-]+$/, 'an id is letters, digits and ._:- only');
export type Id = z.infer<typeof idSchema>;

/** A short human label (a step's name in the map, a secret reference's label). Never a typed value. */
export const labelSchema = z.string().min(1).max(200);

/** An ISO-8601 timestamp. */
export const timestampSchema = z.string().datetime({ offset: true });

/** A registrable domain (`example.com`, `bank.co.uk`): lower case, no scheme, no path. */
export const registrableDomainSchema = z
  .string()
  .min(3)
  .max(253)
  .regex(/^(?=.{3,253}$)([a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/, 'a registrable domain is a lower-case host name such as example.com');

// ---------------------------------------------------------------- nodes

export const NODE_TYPES = ['Task', 'Procedure', 'ProcedureVersion', 'Step', 'Site', 'Screen', 'Element', 'Account', 'Tool', 'SecretRef', 'Parameter', 'Output'] as const;
export const nodeTypeSchema = z.enum(NODE_TYPES);
export type NodeType = z.infer<typeof nodeTypeSchema>;

/** A tool a procedure can call: its name, its family (`browser`, `desktop`, `accounts`, `mcp:<connectionId>`, ...) and whether a call commits. */
export const toolSchema = z.object({
  name: z.string().min(1).max(64),
  family: z.string().min(1).max(200),
  commits: z.boolean().default(false),
});
export type Tool = z.infer<typeof toolSchema>;

/** A site: one registrable domain a procedure touches. */
export const siteSchema = z.object({ id: idSchema, domain: registrableDomainSchema });
export type Site = z.infer<typeof siteSchema>;

/** A connected account, by reference only: its connection id and provider. Never a token. */
export const accountSchema = z.object({ id: idSchema, connectionId: idSchema, provider: z.string().min(1).max(64) }).strict();
export type Account = z.infer<typeof accountSchema>;

/** A saved login, identity or card, by label. Never the value. */
export const secretRefSchema = z.object({ id: idSchema, kind: z.enum(['login', 'identity', 'card']), label: labelSchema }).strict();
export type SecretRef = z.infer<typeof secretRefSchema>;

/** A declared task input. A `sensitive` parameter's value is never stored in the graph and never reaches a judge. */
export const parameterSchema = z.object({
  id: idSchema,
  name: z.string().min(1).max(100),
  type: z.enum(['string', 'number', 'boolean', 'date']).default('string'),
  sensitive: z.boolean().default(false),
  required: z.boolean().default(true),
});
export type Parameter = z.infer<typeof parameterSchema>;

/** A named value a procedure produces (an extract or a judge result the run's answer reads). */
export const outputSchema = z.object({ id: idSchema, name: z.string().min(1).max(100), step: idSchema, sensitive: z.boolean().default(false) });
export type Output = z.infer<typeof outputSchema>;

/** A screen of a site's surface graph (browser-specific detail lives with the browser toolset). */
export const screenSchema = z.object({ id: idSchema, site: idSchema, label: labelSchema, pathPattern: z.string().max(500).optional() });
export type Screen = z.infer<typeof screenSchema>;

/** An element on a screen: its role, accessible label and selector candidates in preference order. */
export const elementSchema = z.object({
  id: idSchema,
  screen: idSchema,
  role: z.string().max(64).optional(),
  label: z.string().max(200).optional(),
  selectors: z.array(z.string().min(1).max(500)).max(10).default([]),
});
export type Element = z.infer<typeof elementSchema>;

/** Every node of the plain graph a host stores or a view draws. `props` holds the typed record of the node. */
export const graphNodeSchema = z.object({ id: idSchema, type: nodeTypeSchema, label: z.string().max(200), props: z.record(z.string(), z.unknown()).default({}) });
export type GraphNode = z.infer<typeof graphNodeSchema>;

// ---------------------------------------------------------------- edges

export const EDGE_TYPES = ['uses', 'then', 'feeds', 'on', 'transition', 'version_of'] as const;
export const edgeTypeSchema = z.enum(EDGE_TYPES);
export type EdgeType = z.infer<typeof edgeTypeSchema>;

/**
 * An edge. `uses`: a step uses a tool, site, account or secret reference. `then`: control flow between steps. `feeds`: data flow from a step's
 * output to a later step's argument. `on`: a step acts on a screen or element. `transition`: one screen leads to another. `version_of`: a
 * version belongs to a procedure. `loop` marks the one edge allowed to go back: from the end of a `foreach` body to the `foreach` node.
 */
export const edgeSchema = z.object({
  type: edgeTypeSchema,
  from: idSchema,
  to: idSchema,
  loop: z.boolean().optional(),
  /** For a `feeds` edge: the argument (or judge input) it fills. */
  arg: z.string().max(100).optional(),
});
export type Edge = z.infer<typeof edgeSchema>;
