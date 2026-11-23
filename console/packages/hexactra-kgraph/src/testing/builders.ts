// Builders for procedures and versions, so a test states only what it is about.
import { type Binding, type Parameter, type Procedure, type ProcedureVersion, procedureVersionSchema, type ProcedureVersionInput, type Step, type Tool } from '../schema';

export const T0 = '2026-01-01T00:00:00.000Z';

export function aProcedure(over: Partial<Procedure> = {}): Procedure {
  return { id: 'proc1', owner: 'owner1', task: 'task1', name: 'Daily report', activeVersion: null, createdAt: T0, updatedAt: T0, ...over };
}

type StepInput = ProcedureVersionInput['steps'][number];

/** A `call` step. */
export function call(id: string, tool: string, args: Record<string, Binding> = {}, over: Partial<StepInput> = {}): StepInput {
  return { id, kind: 'call', label: `${tool} ${id}`, tool, args, ...over } as StepInput;
}

export const lit = (value: string | number | boolean | null): Binding => ({ kind: 'literal', value });
export const param = (parameter: string): Binding => ({ kind: 'parameter', parameter });
export const out = (step: string, path?: string): Binding => (path === undefined ? { kind: 'output', step } : { kind: 'output', step, path });
export const secret = (ref: string, field = 'password'): Binding => ({ kind: 'secret', ref, field });

/** A version input with sensible defaults: one site `s1` = example.com, the steps chained by `then` edges in order. Not parsed. */
export function aVersionInput(steps: StepInput[], over: Partial<ProcedureVersionInput> = {}): ProcedureVersionInput {
  const edges = steps.slice(1).map((s, i) => ({ type: 'then' as const, from: steps[i]!.id, to: s.id }));
  return {
    id: 'v1',
    procedure: 'proc1',
    number: 1,
    state: 'candidate',
    changeClass: 'initial',
    sourceRun: 'run1',
    parent: null,
    createdAt: T0,
    entry: steps[0]!.id,
    steps,
    edges,
    sites: [{ id: 's1', domain: 'example.com' }],
    ...over,
  };
}

/** A parsed version (throws when the input does not match the schema). */
export function aVersion(steps: StepInput[], over: Partial<ProcedureVersionInput> = {}): ProcedureVersion {
  return procedureVersionSchema.parse(aVersionInput(steps, over));
}

export const sensitiveParam = (id: string): Parameter => ({ id, name: id, type: 'string', sensitive: true, required: true });

/** A small tool catalogue covering each family. */
export const TOOLS: Tool[] = [
  { name: 'navigate', family: 'browser', commits: false },
  { name: 'click', family: 'browser', commits: false },
  { name: 'type', family: 'browser', commits: false },
  { name: 'type_secret', family: 'secrets', commits: true },
  { name: 'mail_search', family: 'accounts', commits: false },
  { name: 'mail_send', family: 'accounts', commits: true },
  { name: 'crm_lookup', family: 'mcp:c1', commits: false },
];

export type { Step };
