// The compiler (E46.7): the trace of one clean, successful run becomes a `candidate` procedure version. Deterministic and model-free: the same
// trace, catalogue and task give the same bytes. It reads only server-recorded facts (`TraceEvent`s: tool names, argument provenance, post-state)
// — never the model's reasoning, never page text — so a poisoned page cannot write itself into a procedure. What it cannot express safely
// stays with the agent as an `agent` step. The first version is linear: branches and loops are not inferred (E46.18).
import { createHash } from 'node:crypto';

import { type Binding, type Check, type Parameter, procedureVersionSchema, type ProcedureVersion, type Step, type Tool } from '../schema';
import type { SensitivePredicate } from '../validate/sensitive';
import { validateVersion, type Violation } from '../validate/validate';
import type { TraceBinding, TraceEvent } from './trace';

/** Tools that only read: kept only when a later argument (or the run's result) consumes what they returned. */
export const OBSERVE_TOOLS = new Set(['look', 'observe_elements', 'read_text', 'tabs', 'screenshot', 'wait_for']);
/** Raw-coordinate tools: not compilable without element facts. */
const COORDINATE_TOOLS = new Set(['click_at', 'hover_at', 'drag', 'scroll_at', 'click_mark']);
/** The pointer clicks that replay as a click on the element found again, when the page described it. */
const POINTER_CLICKS = new Set(['click_at', 'click_mark']);
/** Tools whose arguments are model-written code. */
const CODE_TOOLS = new Set(['run_javascript']);
/** The tool that ends a run: its arguments feed the outputs, it is not a step. */
const FINISH_TOOLS = new Set(['finish']);
/** The tool that asks the owner: an `ask` step (its kind kept, never its answer). */
const ASK_TOOLS = new Set(['request_human']);
const UNDO_TOOLS = new Set(['go_back']);

export interface CompileInput {
  procedure: string;
  version: string;
  number: number;
  createdAt: string;
  sourceRun: string;
  parent?: string | null;
  /** The run's tool calls, oldest first. */
  trace: readonly TraceEvent[];
  /** The host's tool catalogue. */
  tools: readonly Tool[];
  /** The task's declared parameters (`key` as bound by the trace). */
  parameters: readonly { key: string; name: string; sensitive: boolean }[];
  /** The task's declared outputs, when it has any. */
  outputs?: readonly { name: string }[];
  isSensitive?: SensitivePredicate;
}

export type CompileResult =
  | { status: 'candidate'; version: ProcedureVersion; violations: [] ; notCompilable: number }
  | { status: 'rejected'; version: null; violations: Violation[]; notCompilable: number }
  | { status: 'empty'; version: null; violations: []; notCompilable: number };

/** 1. Clean: failed calls, undone navigations and unconsumed observations go. */
export function cleanTrace(trace: readonly TraceEvent[]): TraceEvent[] {
  let events = trace.filter((e) => e.ok && e.outcome === 'ran');
  // A navigation undone by go_back: both go.
  const out: TraceEvent[] = [];
  for (const e of events) {
    if (UNDO_TOOLS.has(e.tool)) {
      const prev = out[out.length - 1];
      if (prev && (prev.tool === 'navigate' || prev.tool === 'click')) {
        out.pop();
        continue;
      }
    }
    out.push(e);
  }
  events = out;
  const consumed = new Set<number>();
  for (const e of events) for (const b of Object.values(e.bindings)) if (b.kind === 'output') consumed.add(b.seq);
  return events.filter((e) => !OBSERVE_TOOLS.has(e.tool) || consumed.has(e.seq));
}

/** Why an event cannot be compiled, or null. */
export function notCompilableReason(e: TraceEvent, tool: Tool | undefined): string | null {
  if (!tool) return 'unknown tool';
  if (Object.values(e.bindings).some((b) => b.kind === 'withheld')) return 'a withheld value';
  if (tool.family === 'desktop') return 'a desktop action';
  // A pointer action is compilable only with element facts from the page (E46.13): it replays as a click on the element found again.
  if (COORDINATE_TOOLS.has(e.tool) && !(POINTER_CLICKS.has(e.tool) && hasElement(e))) return 'raw coordinates';
  if (CODE_TOOLS.has(e.tool)) return 'model-written code';
  return null;
}

const hasElement = (e: TraceEvent) => Boolean(e.post.element && (e.post.element.selectors.length > 0 || (e.post.element.role && e.post.element.name)));

/** A stable element id from its fingerprint (the same element on the same site gets the same id in every procedure of the owner). */
export function elementId(site: string, fp: NonNullable<TraceEvent['post']['element']>): string {
  return `el:${createHash('sha256').update(JSON.stringify([site, fp.selectors[0] ?? null, fp.role, fp.name, fp.tag, fp.anchor])).digest('hex').slice(0, 16)}`;
}

/** The registrable domain of a host (a best-effort public-suffix rule: `a.b.co.uk` → `b.co.uk`). */
export function registrableDomain(host: string): string {
  const labels = host.toLowerCase().replace(/\.$/, '').split('.');
  if (labels.length <= 2) return labels.join('.');
  const last = labels[labels.length - 1]!;
  const second = labels[labels.length - 2]!;
  const take = last.length === 2 && second.length <= 3 && ['co', 'com', 'org', 'net', 'ac', 'gov', 'edu', 'ne', 'or'].includes(second) ? 3 : 2;
  return labels.slice(-take).join('.');
}

const hostOfUrl = (v: unknown): string | null => {
  if (typeof v !== 'string') return null;
  try {
    const u = new URL(v);
    return u.protocol === 'http:' || u.protocol === 'https:' ? u.hostname.toLowerCase() : null;
  } catch {
    return null;
  }
};

/** A path as a pattern: numeric and long opaque segments become `*`. */
export function pathPattern(path: string): string {
  return (
    path
      .split('/')
      .map((seg) => (/^\d+$/.test(seg) || /^[A-Za-z0-9_-]{16,}$/.test(seg) ? '*' : seg))
      .join('/') || '/'
  );
}

/** Top-level keys of a result-shape string (`{a:..,b:..}`). */
export function shapeKeys(shape: string): string[] {
  if (!shape.startsWith('{')) return [];
  const keys: string[] = [];
  let depth = 0;
  let token = '';
  for (const ch of shape.slice(1, -1)) {
    if (ch === '{' || ch === '[') depth++;
    else if (ch === '}' || ch === ']') depth--;
    if (depth === 0 && ch === ':' && token) {
      keys.push(token);
      token = '';
    } else if (depth === 0 && ch === ',') token = '';
    else if (depth === 0 && /[A-Za-z0-9_$-]/.test(ch)) token += ch;
    else if (depth !== 0) token = '';
  }
  return keys.slice(0, 20);
}

/** The whole compiler. Pure. */
export function compileTrace(input: CompileInput): CompileResult {
  const tools = new Map(input.tools.map((t) => [t.name, t]));
  const events = cleanTrace(input.trace);
  const finish = events.find((e) => FINISH_TOOLS.has(e.tool));
  const work = events.filter((e) => !FINISH_TOOLS.has(e.tool));
  const steps: Step[] = [];
  const stepOfSeq = new Map<number, string>();
  const sites = new Map<string, string>(); // domain -> id
  const siteId = (host: string) => {
    const d = registrableDomain(host);
    if (!sites.has(d)) sites.set(d, `site:${d}`);
    return sites.get(d)!;
  };
  const usedParams = new Set<string>();
  const screens = new Map<string, ProcedureVersion['screens'][number]>();
  const elements = new Map<string, ProcedureVersion['elements'][number]>();
  let segment = 1;
  let inAgent = false;
  let notCompilable = 0;
  let judges = 0;
  const reads: string[] = []; // steps whose results a judge may read (calls that were consumed, extracts)

  const toBinding = (b: TraceBinding, consumer: string, arg: string, pre: Step[]): Binding | null => {
    switch (b.kind) {
      case 'literal':
        return { kind: 'literal', value: b.value };
      case 'parameter':
        usedParams.add(b.parameter);
        return { kind: 'parameter', parameter: paramId(b.parameter) };
      case 'output': {
        const src = stepOfSeq.get(b.seq);
        if (!src) return null;
        if (b.path !== undefined) return { kind: 'output', step: src, path: b.path };
        if (b.pattern !== undefined) {
          const x = `x${b.seq}-${consumer}-${arg.replace(/[^A-Za-z0-9._:-]/g, '_')}`.slice(0, 200);
          pre.push({ id: x, kind: 'extract', label: `read a value for ${arg}`, from: src, pattern: b.pattern, sensitive: false, sites: [], commitClass: false, checks: [], segment: `seg${segment}` });
          reads.push(x);
          return { kind: 'output', step: x };
        }
        return { kind: 'output', step: src };
      }
      default:
        return null;
    }
  };

  /** A judge over what the run read so far (never a sensitive input; the validator checks). */
  const judgeFor = (fields: string[], label: string, pre: Step[]): string | null => {
    const inputs: Record<string, Binding> = {};
    for (const r of reads.slice(-3)) inputs[r] = { kind: 'output', step: r };
    if (Object.keys(inputs).length === 0) return null;
    const id = `j${++judges}`;
    pre.push({ id, kind: 'judge', label, inputs, output: fields.map((name) => ({ name, type: 'string' as const })), sites: [], commitClass: false, checks: [], segment: `seg${segment}` });
    return id;
  };

  const pushAgent = (e: TraceEvent) => {
    notCompilable++;
    if (inAgent) {
      const a = steps[steps.length - 1]!;
      if (a.kind === 'agent' && !a.tools.includes(e.tool)) a.tools.push(e.tool);
      return;
    }
    if (steps.length > 0) segment++;
    inAgent = true;
    steps.push({ id: `a${e.seq}`, kind: 'agent', label: 'the agent continues from here', until: [], tools: [e.tool], sites: [], commitClass: false, checks: [], segment: `seg${segment}` });
  };

  for (const e of work) {
    const tool = tools.get(e.tool);
    const reason = notCompilableReason(e, tool);
    if (reason || !tool) {
      pushAgent(e);
      continue;
    }
    if (inAgent) {
      inAgent = false;
      segment++;
    }
    const id = `s${e.seq}`;
    const pre: Step[] = [];
    const checks = checksOf(e, id, siteId);
    const stepSites = new Set<string>();
    for (const c of checks) if (c.kind === 'location') stepSites.add(siteId(c.host));
    if (ASK_TOOLS.has(e.tool)) {
      steps.push({ id, kind: 'ask', label: 'ask the owner', reason: 'missing_input', sites: [...stepSites].sort(), commitClass: false, checks: [], segment: `seg${segment}` });
      stepOfSeq.set(e.seq, id);
      continue;
    }
    const args: Record<string, Binding> = {};
    let ok = true;
    const modelArgs: string[] = [];
    for (const [arg, b] of Object.entries(e.bindings).sort(([a], [z]) => (a < z ? -1 : a > z ? 1 : 0))) {
      if (b.kind === 'model') {
        modelArgs.push(arg);
        continue;
      }
      const bound = toBinding(b, id, arg, pre);
      if (!bound) {
        ok = false;
        break;
      }
      args[arg] = bound;
      const host = b.kind === 'literal' ? hostOfUrl(b.value) : null;
      if (host) stepSites.add(siteId(host));
    }
    if (ok && modelArgs.length > 0) {
      const j = judgeFor(modelArgs, `decide ${modelArgs.join(', ')} for ${e.tool}`, pre);
      if (!j) ok = false;
      else for (const arg of modelArgs) args[arg] = { kind: 'judge', step: j, field: arg };
    }
    if (!ok) {
      pushAgent(e);
      continue;
    }
    // The element acted on (E46.13): a screen and an element of the surface graph; a pointer action replays as a click on it.
    let callTool = e.tool;
    let on: { screen?: string; element?: string } = {};
    const fp = e.post.element;
    if (fp && e.post.host && hasElement(e)) {
      const site = siteId(e.post.host);
      const screenId = `sc:${createHash('sha256').update(`${site}|${pathPattern(e.post.path ?? '/')}`).digest('hex').slice(0, 16)}`;
      if (!screens.has(screenId)) screens.set(screenId, { id: screenId, site, label: `${e.post.host}${pathPattern(e.post.path ?? '/')}`.slice(0, 200), pathPattern: pathPattern(e.post.path ?? '/') });
      const elId = elementId(site, fp);
      elements.set(elId, { id: elId, screen: screenId, ...(fp.role ? { role: fp.role.slice(0, 64) } : {}), ...(fp.name ? { label: fp.name.slice(0, 200) } : {}), ...(fp.tag ? { tag: fp.tag.slice(0, 40) } : {}), ...(fp.inputType ? { inputType: fp.inputType.slice(0, 40) } : {}), ...(fp.anchor ? { anchor: fp.anchor.slice(0, 200) } : {}), selectors: fp.selectors.slice(0, 3) });
      on = { screen: screenId, element: elId };
      if (POINTER_CLICKS.has(e.tool)) {
        if (!tools.has('click')) {
          pushAgent(e);
          continue;
        }
        callTool = 'click';
        for (const k of Object.keys(args)) delete args[k];
        args.selector = { kind: 'literal', value: fp.selectors[0] ?? '' };
        args.reason = { kind: 'literal', value: 'the saved procedure' };
      }
    }
    steps.push(...pre);
    steps.push({ id, kind: 'call', label: `${callTool}`, tool: callTool, args, sites: [...stepSites].sort(), commitClass: tool.commits === true || e.commits, checks, segment: `seg${segment}`, ...on });
    stepOfSeq.set(e.seq, id);
    if (events.some((x) => Object.values(x.bindings).some((b) => b.kind === 'output' && b.seq === e.seq))) reads.push(id);
  }

  // An agent step runs until the next step's location (its precondition), when there is one.
  for (let i = 0; i < steps.length; i++) {
    const s = steps[i]!;
    if (s.kind !== 'agent') continue;
    const next = steps.slice(i + 1).find((x) => x.checks.length > 0);
    if (next) s.until = next.checks.filter((c) => c.kind === 'location').slice(0, 1);
  }

  // 7. Outputs.
  const outputs: ProcedureVersion['outputs'] = [];
  if (finish && input.outputs?.length) {
    for (const o of input.outputs) {
      const key = Object.keys(finish.bindings).find((k) => k === `outputs.${o.name}` || k === `outputs.${o.name}.value`);
      const b = key ? finish.bindings[key] : undefined;
      if (!b) continue;
      if (b.kind === 'output' && stepOfSeq.has(b.seq)) {
        const pre: Step[] = [];
        const bound = toBinding(b, `out-${o.name}`, o.name, pre);
        steps.push(...pre);
        if (bound && bound.kind === 'output') outputs.push({ id: `o:${o.name}`.slice(0, 200).replace(/[^A-Za-z0-9._:-]/g, '_'), name: o.name, step: bound.step, sensitive: false });
      } else if (b.kind === 'model') {
        const pre: Step[] = [];
        const j = judgeFor([o.name], `the output ${o.name}`, pre);
        steps.push(...pre);
        if (j) outputs.push({ id: `o:${o.name}`.replace(/[^A-Za-z0-9._:-]/g, '_'), name: o.name, step: j, sensitive: false });
      }
    }
  }

  if (steps.length === 0 || steps.every((s) => s.kind === 'agent')) return { status: 'empty', version: null, violations: [], notCompilable };

  const parameters: Parameter[] = input.parameters
    .filter((p) => usedParams.has(p.key))
    .map((p) => ({ id: paramId(p.key), name: p.name.slice(0, 100), type: 'string', sensitive: p.sensitive, required: true }));
  const edges = [
    ...steps.slice(1).map((s, i) => ({ type: 'then' as const, from: steps[i]!.id, to: s.id })),
    ...steps.flatMap((s) => feedsOf(s)),
  ];
  const raw = {
    id: input.version,
    procedure: input.procedure,
    number: input.number,
    state: 'candidate',
    changeClass: 'initial',
    sourceRun: input.sourceRun,
    parent: input.parent ?? null,
    createdAt: input.createdAt,
    entry: steps[0]!.id,
    steps,
    edges,
    sites: [...sites.entries()].sort(([a], [b]) => (a < b ? -1 : 1)).map(([domain, id]) => ({ id, domain })),
    parameters,
    outputs,
    screens: [...screens.values()],
    elements: [...elements.values()],
  };
  // 8. Validate.
  const violations = validateVersion(raw, { tools: input.tools, isSensitive: input.isSensitive });
  if (violations.length > 0) return { status: 'rejected', version: null, violations, notCompilable };
  return { status: 'candidate', version: procedureVersionSchema.parse(raw), violations: [], notCompilable };
}

const paramId = (key: string) => `p:${key}`.slice(0, 200).replace(/[^A-Za-z0-9._:-]/g, '_');

function feedsOf(s: Step): { type: 'feeds'; from: string; to: string; arg: string }[] {
  const bindings: [string, Binding][] = s.kind === 'call' ? Object.entries(s.args) : s.kind === 'judge' ? Object.entries(s.inputs) : [];
  const out = bindings.filter(([, b]) => b.kind === 'output' || b.kind === 'judge').map(([arg, b]) => ({ type: 'feeds' as const, from: (b as { step: string }).step, to: s.id, arg: arg.slice(0, 100) }));
  if (s.kind === 'extract') out.push({ type: 'feeds', from: s.from, to: s.id, arg: 'source' });
  return out;
}

/** 5. Checks from the post-state. */
function checksOf(e: TraceEvent, id: string, siteId: (host: string) => string): Check[] {
  const checks: Check[] = [];
  if (e.post.host) siteId(e.post.host);
  if (e.post.host && e.post.path !== undefined) {
    checks.push({ kind: 'location', host: e.post.host, pathPattern: pathPattern(e.post.path ?? '/'), tolerance: 0 });
  }
  if (e.post.viewDigest) checks.push({ kind: 'view_digest', digest: e.post.viewDigest.slice(0, 200), tolerance: 0.3 });
  if (e.post.resultShape) checks.push({ kind: 'result_shape', step: id, ok: true, fields: shapeKeys(e.post.resultShape), tolerance: 0 });
  return checks;
}
