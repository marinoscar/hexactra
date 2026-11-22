// The rules a procedure version must satisfy before it can run. `validateVersion` returns typed violations (empty: valid); it never throws on bad
// input. A host stores or executes a version only when the list is empty.
import { type Binding, procedureVersionSchema, type ProcedureVersion, type Step, type Tool } from '../schema';
import { defaultIsSensitive, type SensitivePredicate } from './sensitive';

export const VIOLATION_RULES = [
  'schema',
  'duplicate_step',
  'unknown_step',
  'unknown_reference',
  'feeds_backward',
  'cycle',
  'commit_class',
  'sensitive_literal',
  'sensitive_flow',
  'unknown_tool',
  'undeclared_site',
  'judge_instruction',
  'unobservable_guard',
  'unbounded_loop',
] as const;
export type ViolationRule = (typeof VIOLATION_RULES)[number];

export interface Violation {
  rule: ViolationRule;
  /** The step the violation is on, when it is on one. */
  step?: string;
  message: string;
}

export interface ValidateOptions {
  /** The tools the host offers: a step's tool must be one, and a `commits` tool's step must be commit-class. */
  tools: readonly Tool[];
  /** Whether a value is secret material. Default: `defaultIsSensitive`. The console binds its sensitive-pattern table. */
  isSensitive?: SensitivePredicate;
}

/** Families whose arguments leave the owner's browser for a third party's API: no secret or sensitive value is ever sent to one by a procedure. */
export function isApiFamily(family: string): boolean {
  return family === 'accounts' || family.startsWith('mcp:');
}

/** Keys a judge step must never carry: a judge gets the owner's goal, its declared inputs and a fixed schema, never a run-written instruction. */
const JUDGE_INSTRUCTION_KEYS = ['instruction', 'instructions', 'prompt', 'system', 'message', 'text', 'question', 'description'];

/** Validate an unknown value as a procedure version, then apply every rule. */
export function validateVersion(input: unknown, options: ValidateOptions): Violation[] {
  const out: Violation[] = [];
  // A judge instruction is reported by name even though the strict schema also rejects it.
  const rawSteps = (input as { steps?: unknown })?.steps;
  if (Array.isArray(rawSteps)) {
    for (const s of rawSteps) {
      if (s && typeof s === 'object' && (s as { kind?: unknown }).kind === 'judge') {
        for (const k of JUDGE_INSTRUCTION_KEYS) if (k in s) out.push({ rule: 'judge_instruction', step: String((s as { id?: unknown }).id ?? ''), message: `a judge step carries no free-text '${k}': it gets the task's goal, its declared inputs and a fixed output schema` });
      }
    }
  }
  const parsed = procedureVersionSchema.safeParse(input);
  if (!parsed.success) {
    for (const issue of parsed.error.issues.slice(0, 50)) out.push({ rule: 'schema', message: `${issue.path.join('.') || '(root)'}: ${issue.message}` });
    return out;
  }
  out.push(...rules(parsed.data, options));
  return out;
}

/** The rules over an already-parsed version. */
export function rules(v: ProcedureVersion, options: ValidateOptions): Violation[] {
  const out: Violation[] = [];
  const isSensitive = options.isSensitive ?? defaultIsSensitive;
  const tools = new Map(options.tools.map((t) => [t.name, t]));
  const order = new Map<string, number>();
  const byId = new Map<string, Step>();
  v.steps.forEach((s, i) => {
    if (order.has(s.id)) out.push({ rule: 'duplicate_step', step: s.id, message: `step id '${s.id}' is used twice` });
    else {
      order.set(s.id, i);
      byId.set(s.id, s);
    }
  });
  if (!order.has(v.entry)) out.push({ rule: 'unknown_step', message: `the entry '${v.entry}' is not a step` });

  const params = new Map(v.parameters.map((p) => [p.id, p]));
  const secrets = new Set(v.secretRefs.map((r) => r.id));
  const sites = new Map(v.sites.map((s) => [s.id, s.domain]));
  const sensitiveOutputs = new Set(v.outputs.filter((o) => o.sensitive).map((o) => o.step));
  const foreachOf = new Map<string, string>(); // body step -> its foreach
  for (const s of v.steps) if (s.kind === 'foreach') for (const b of s.body) foreachOf.set(b, s.id);

  const sensitiveStep = (id: string, seen = new Set<string>()): boolean => {
    if (sensitiveOutputs.has(id)) return true;
    const s = byId.get(id);
    if (!s || seen.has(id)) return false;
    seen.add(id);
    return s.kind === 'extract' && (s.sensitive || sensitiveStep(s.from, seen));
  };
  /** Whether a binding carries secret material into the step that reads it. */
  const sensitiveBinding = (b: Binding): boolean => {
    switch (b.kind) {
      case 'secret':
        return true;
      case 'parameter':
        return params.get(b.parameter)?.sensitive === true;
      case 'output':
        return sensitiveStep(b.step);
      case 'judge':
        return false;
      case 'literal':
        return typeof b.value === 'string' && isSensitive(b.value);
    }
  };
  const refStep = (step: Step, target: string, what: string, mustBeEarlier: boolean) => {
    const at = order.get(target);
    if (at === undefined) out.push({ rule: 'unknown_step', step: step.id, message: `${what} names '${target}', which is not a step` });
    else if (mustBeEarlier && at >= order.get(step.id)!) out.push({ rule: 'feeds_backward', step: step.id, message: `${what} reads '${target}', which does not run before it` });
  };
  const checkBinding = (step: Step, arg: string, b: Binding) => {
    if (b.kind === 'output' || b.kind === 'judge') refStep(step, b.step, `argument '${arg}'`, true);
    if (b.kind === 'judge' && byId.get(b.step) && byId.get(b.step)!.kind !== 'judge') out.push({ rule: 'unknown_reference', step: step.id, message: `argument '${arg}' reads a judge result of '${b.step}', which is not a judge step` });
    if (b.kind === 'parameter' && !params.has(b.parameter)) out.push({ rule: 'unknown_reference', step: step.id, message: `argument '${arg}' names parameter '${b.parameter}', which is not declared` });
    if (b.kind === 'secret' && !secrets.has(b.ref)) out.push({ rule: 'unknown_reference', step: step.id, message: `argument '${arg}' names secret reference '${b.ref}', which is not declared` });
    if (b.kind === 'literal' && typeof b.value === 'string' && isSensitive(b.value)) out.push({ rule: 'sensitive_literal', step: step.id, message: `argument '${arg}' is a literal that looks like secret material: bind it to a task parameter or a saved reference` });
  };

  for (const s of v.steps) {
    for (const id of s.sites) if (!sites.has(id)) out.push({ rule: 'undeclared_site', step: s.id, message: `the step touches site '${id}', which the procedure does not declare` });
    for (const c of s.checks) {
      if (c.kind === 'location' && !hostDeclared(c.host, [...sites.values()])) out.push({ rule: 'undeclared_site', step: s.id, message: `a location check expects host '${c.host}', which is not on a declared site` });
      if (c.kind === 'result_shape') refStep(s, c.step, 'a result check', false);
    }
    switch (s.kind) {
      case 'call': {
        const tool = tools.get(s.tool);
        if (!tool) out.push({ rule: 'unknown_tool', step: s.id, message: `tool '${s.tool}' is not in the host's tool catalogue` });
        if (tool?.commits && !s.commitClass) out.push({ rule: 'commit_class', step: s.id, message: `tool '${s.tool}' commits: its step must be commit-class` });
        for (const [arg, b] of Object.entries(s.args)) {
          checkBinding(s, arg, b);
          if (tool && isApiFamily(tool.family) && b.kind !== 'literal' && sensitiveBinding(b)) out.push({ rule: 'sensitive_flow', step: s.id, message: `argument '${arg}' of '${s.tool}' (family ${tool.family}) would carry secret material to a third-party API` });
        }
        break;
      }
      case 'extract':
        refStep(s, s.from, 'the extract', true);
        break;
      case 'judge':
        for (const [arg, b] of Object.entries(s.inputs)) {
          checkBinding(s, arg, b);
          if (b.kind !== 'literal' && sensitiveBinding(b)) out.push({ rule: 'sensitive_flow', step: s.id, message: `judge input '${arg}' would carry secret material to a model` });
        }
        break;
      case 'branch':
        // A guard reads only observable state (a screen, an element, a result's shape), never a view digest.
        if (s.guard.kind === 'view_digest') out.push({ rule: 'unobservable_guard', step: s.id, message: 'a branch guard reads a screen, an element or a result, never a view digest' });
        refStep(s, s.then, 'the branch', false);
        refStep(s, s.else, 'the branch', false);
        break;
      case 'foreach':
        if (!(s.maxItems >= 1 && s.maxItems <= 1000)) out.push({ rule: 'unbounded_loop', step: s.id, message: 'a loop has a bound' });
        checkBinding(s, 'over', s.over);
        for (const b of s.body) refStep(s, b, 'the loop body', false);
        break;
    }
  }

  for (const e of v.edges) {
    const known = (id: string) => order.has(id) || params.has(id) || secrets.has(id) || sites.has(id) || v.accounts.some((a) => a.id === id) || v.screens.some((x) => x.id === id) || v.elements.some((x) => x.id === id) || tools.has(id) || id === v.id || id === v.procedure;
    if (!known(e.from) || !known(e.to)) {
      out.push({ rule: 'unknown_reference', message: `a '${e.type}' edge ${e.from} → ${e.to} names a node the version does not hold` });
      continue;
    }
    if (e.type === 'feeds' && order.has(e.from) && order.has(e.to) && order.get(e.from)! >= order.get(e.to)!) out.push({ rule: 'feeds_backward', step: e.to, message: `a feeds edge ${e.from} → ${e.to} points to a step that runs before its source` });
    if (e.type === 'then' && e.loop && !(byId.get(e.to)?.kind === 'foreach' && foreachOf.get(e.from) === e.to)) out.push({ rule: 'cycle', step: e.from, message: `a loop edge goes back only from a foreach body to its foreach node` });
  }
  const cyc = cycleIn(v.edges.filter((e) => e.type === 'then' && !e.loop && order.has(e.from) && order.has(e.to)));
  if (cyc) out.push({ rule: 'cycle', step: cyc, message: `control flow has a cycle through '${cyc}' outside a foreach` });
  return out;
}

function hostDeclared(host: string, domains: string[]): boolean {
  const h = host.toLowerCase();
  return domains.some((d) => h === d || h.endsWith(`.${d}`));
}

/** A node on a cycle of the directed graph, or null. */
function cycleIn(edges: readonly { from: string; to: string }[]): string | null {
  const next = new Map<string, string[]>();
  for (const e of edges) next.set(e.from, [...(next.get(e.from) ?? []), e.to]);
  const state = new Map<string, 1 | 2>();
  const visit = (n: string): string | null => {
    state.set(n, 1);
    for (const m of next.get(n) ?? []) {
      if (state.get(m) === 1) return m;
      if (!state.has(m)) {
        const c = visit(m);
        if (c) return c;
      }
    }
    state.set(n, 2);
    return null;
  };
  for (const n of next.keys()) if (!state.has(n)) {
    const c = visit(n);
    if (c) return c;
  }
  return null;
}
