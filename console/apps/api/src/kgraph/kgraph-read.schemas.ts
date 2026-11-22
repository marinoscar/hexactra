// The Knowledge Graph's read routes (E46.19, #793): queries and responses. Every label in a response is masked as the run trace is; a saved
// login is its label only; a sensitive parameter its name only. A read answers with the stored data and `enabled: false` while a switch is off.
import { VERSION_STATES, VIEW_EDGE_TYPES, VIEW_HEALTH, VIEW_NODE_TYPES } from '@marinoscar/hexactra-kgraph';
import { createZodDto } from 'nestjs-zod';
import { z } from 'zod';

import { kgraphSystemSettingsSchema } from './kgraph.settings';

const enabled = z.boolean().describe('Both the deployment and your own switch are on. While false the stored data is shown and nothing is learned or replayed.');
const health = z.enum(VIEW_HEALTH).describe('From the evidence: `failing` (suspended, or the last runs failed), `degraded`, `healthy`, or `unknown` (no runs yet).');
const state = z.enum(VERSION_STATES);
const counts = z.object({ successes: z.number().int(), failures: z.number().int(), repairs: z.number().int() });

export const proceduresQuerySchema = z
  .object({
    taskId: z.string().uuid().optional(),
    state: state.optional().describe('Only procedures whose shown version is in this state.'),
    q: z.string().trim().min(1).max(100).optional().describe('Words in the procedure or task name.'),
  })
  .strict();

const ledgerSummary = z.object({
  runs: z.number().int().describe('Ledger rows of the task.'),
  procedureRuns: z.number().int().describe('Runs that executed a procedure version.'),
  cleanReplayRate: z.number().nullable().describe('`replayed_clean` runs over procedure runs; null with none.'),
  everydayRuns: z.number().int().describe('Chats and one-off runs in which a version of this procedure ran (the everyday switch, E46.28): its `everyday` ledger rows. Outside `runs`.'),
});
export const procedureItemSchema = z.object({
  id: z.string(),
  taskId: z.string().uuid(),
  taskName: z.string(),
  name: z.string(),
  versionId: z.string().nullable().describe('The version shown: the active one, else the newest.'),
  versionNumber: z.number().int().nullable(),
  state: state.nullable(),
  health,
  steps: z.number().int(),
  updatedAt: z.string(),
  ledger: ledgerSummary,
});
export const proceduresSchema = z.object({ enabled, procedures: z.array(procedureItemSchema).describe('Newest first, at most 200.') });

const stepArg = z.object({
  name: z.string(),
  source: z.enum(['literal', 'parameter', 'output', 'judge', 'secret']),
  detail: z.string().nullable().describe('A masked literal, a parameter name, the earlier step, or a saved login by kind and label: never a typed value or a secret.'),
});
export const stepViewSchema = z.object({
  id: z.string(),
  kind: z.string(),
  label: z.string(),
  tool: z.string().nullable(),
  target: z.string().nullable().describe("The element's or screen's label, else the site."),
  usesAi: z.boolean().describe('A judge step (one small model call) or an agent step (the agent loop).'),
  commitClass: z.boolean().describe('Sends, pays or otherwise commits: intent-recorded and never repeated when its outcome is unknown.'),
  health,
  counts,
  args: z.array(stepArg),
});
export const versionDetailSchema = z.object({
  id: z.string(),
  number: z.number().int(),
  state,
  changeClass: z.enum(['initial', 'structural', 'sensitive']),
  parentId: z.string().nullable(),
  sourceRunId: z.string().nullable(),
  createdAt: z.string(),
  health,
  counts,
  steps: z.array(stepViewSchema),
  parameters: z.array(z.object({ name: z.string(), type: z.string(), sensitive: z.boolean().describe('Its value is never stored or shown.'), required: z.boolean() })),
  outputs: z.array(z.object({ name: z.string(), sensitive: z.boolean() })),
  sites: z.array(z.string()),
  accounts: z.array(z.object({ connectionId: z.string(), provider: z.string() })),
  savedLogins: z.array(z.object({ kind: z.enum(['login', 'identity', 'card']), label: z.string() })).describe('By label only.'),
});
export const procedureDetailSchema = procedureItemSchema.extend({ enabled, activeVersion: versionDetailSchema.nullable().describe('The version shown as an ordered step list; null when the procedure has none.'), versions: z.number().int() });

export const versionItemSchema = z.object({ id: z.string(), number: z.number().int(), state, changeClass: z.enum(['initial', 'structural', 'sensitive']), parentId: z.string().nullable(), sourceRunId: z.string().nullable(), createdAt: z.string(), health, counts, steps: z.number().int() });
export const versionsSchema = z.object({ enabled, procedureId: z.string(), versions: z.array(versionItemSchema).describe('Newest first.') });
export const versionSchema = versionDetailSchema.extend({ enabled, procedureId: z.string() });

export const diffQuerySchema = z.object({ against: z.coerce.number().int().min(1).optional().describe("The version number to compare with. Default: the version's parent, else the one before it.") }).strict();
const diffStep = z.object({ id: z.string(), kind: z.string(), label: z.string(), tool: z.string().nullable() }).nullable();
export const diffSchema = z.object({
  enabled,
  procedureId: z.string(),
  from: z.number().int().nullable().describe('The older version number; null when there is none to compare with.'),
  to: z.number().int(),
  changes: z.array(z.object({ change: z.enum(['unchanged', 'relocated', 'inserted', 'removed', 'rebound', 'retargeted']), before: diffStep, after: diffStep, args: z.array(z.string()), text: z.string() })),
});

export const graphQuerySchema = z
  .object({
    taskId: z.string().uuid().optional(),
    site: z.string().trim().toLowerCase().min(3).max(253).optional().describe('Only procedures on this registrable domain.'),
    types: z
      .string()
      .max(200)
      .optional()
      .transform((s) => (s ? s.split(',').map((t) => t.trim()).filter(Boolean) : undefined))
      .pipe(z.array(z.enum(VIEW_NODE_TYPES)).optional())
      .describe(`Comma-separated node types: ${VIEW_NODE_TYPES.join(', ')}.`),
    cursor: z.coerce.number().int().min(0).max(100_000).optional().describe('`nextCursor` of the previous page.'),
  })
  .strict();
export const graphSchema = z.object({
  enabled,
  nodes: z.array(
    z.object({
      id: z.string(),
      type: z.enum(VIEW_NODE_TYPES),
      label: z.string(),
      health,
      counts: counts.extend({ uses: z.number().int() }),
      unused: z.boolean().describe('A connected account, added tool or saved login of yours that no procedure uses yet.'),
      cluster: z.string().nullable(),
      procedure: z.string().nullable(),
    }),
  ),
  edges: z.array(z.object({ type: z.enum(VIEW_EDGE_TYPES), from: z.string(), to: z.string() })),
  clusters: z.array(z.object({ id: z.string(), kind: z.enum(['site', 'account']), label: z.string(), nodes: z.array(z.string()) })),
  collapsed: z.boolean().describe('Above the node limit, steps, parameters and outputs fold into their procedures.'),
  truncated: z.boolean().describe('Only part of the procedures is in this page.'),
  totalNodes: z.number().int(),
  nodeLimit: z.number().int(),
  nextCursor: z.number().int().nullable(),
});

const how = z.enum(['replayed', 'recovered', 'judged', 'agent', 'not_reached']);
export const kgRunSchema = z.object({
  enabled,
  runId: z.string().uuid(),
  taskId: z.string().uuid().nullable(),
  mode: z.enum(['off', 'learn', 'reuse', 'everyday']).describe('The effective mode the run had; `off` when the Knowledge Graph took no part.'),
  aiOnly: z.boolean(),
  outcome: z.string().nullable().describe('`replayed`, `fell_back`, `outcome_failed`, `ai_only`, ...: a short code, null while running.'),
  procedureId: z.string().nullable(),
  procedureName: z.string().nullable().describe("The procedure's name, masked; null when the run used none."),
  versionId: z.string().nullable(),
  versionNumber: z.number().int().nullable(),
  steps: z.array(z.object({ id: z.string(), kind: z.string(), label: z.string(), tool: z.string().nullable(), how })).describe("The version's steps and how each ran in this run."),
  ledger: z.object({ replayed: z.number().int(), recovered: z.number().int(), judge: z.number().int(), agent: z.number().int() }).nullable().describe('Step counts from the savings ledger, once written.'),
  kgFactIds: z.array(z.string()).describe('The site facts the run used: read through `site_facts`, or given in its "About these sites" block and named by its steps.'),
  siteFacts: z
    .array(z.object({ id: z.string(), site: z.string(), kind: z.string(), text: z.string() }))
    .describe('Those of `kgFactIds` the owner still has, as text. A fact is data the owner approved; it is never an instruction or a permission.'),
});

export const adminSettingsSchema = kgraphSystemSettingsSchema;
export const putAdminSettingsSchema = kgraphSystemSettingsSchema.partial().strict();

export class ProceduresQueryDto extends createZodDto(proceduresQuerySchema) {}
export class ProceduresResponseDto extends createZodDto(proceduresSchema) {}
export class ProcedureDetailResponseDto extends createZodDto(procedureDetailSchema) {}
export class VersionsResponseDto extends createZodDto(versionsSchema) {}
export class VersionResponseDto extends createZodDto(versionSchema) {}
export class DiffQueryDto extends createZodDto(diffQuerySchema) {}
export class DiffResponseDto extends createZodDto(diffSchema) {}
export class GraphQueryDto extends createZodDto(graphQuerySchema) {}
export class GraphResponseDto extends createZodDto(graphSchema) {}
export class KgRunResponseDto extends createZodDto(kgRunSchema) {}
export class AdminSettingsResponseDto extends createZodDto(adminSettingsSchema) {}
export class PutAdminSettingsDto extends createZodDto(putAdminSettingsSchema) {}
