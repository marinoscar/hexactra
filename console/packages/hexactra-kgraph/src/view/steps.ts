// A version as a readable, ordered step list and a readable diff (E46.19): what the procedure page, the CLI and an export show. Pure. Every
// label and literal passes `mask`; a secret binding shows its reference's kind and label only; a parameter its name only.
import type { StepChange, StepChangeKind } from '../repair';
import type { Binding, Evidence, ProcedureVersion, Step } from '../schema';
import { bindingsOf, defaultMask, healthOf, type DrawnStep, type DrawnVersion, type ViewHealth } from './model';

export interface StepArgView {
  name: string;
  /** Where the value comes from (the binding kind): never the value of a parameter or a secret. */
  source: Binding['kind'];
  /** A masked literal, a parameter's name, the earlier step's id (and field), or a saved login's kind and label. */
  detail: string | null;
}
export interface StepView {
  id: string;
  kind: string;
  label: string;
  tool: string | null;
  /** What the step acts on: the element's or screen's label, else its site. Masked. */
  target: string | null;
  /** A `judge` (one small model call) or `agent` (the agent loop) step. */
  usesAi: boolean;
  commitClass: boolean;
  health: ViewHealth;
  counts: { successes: number; failures: number; repairs: number };
  args: StepArgView[];
}

type ReadableVersion = DrawnVersion & Partial<Pick<ProcedureVersion, 'screens' | 'elements'>>;

const clip = (s: string, n = 200) => (s.length > n ? `${s.slice(0, n - 1)}…` : s);

function argView(name: string, b: Binding, v: ReadableVersion, mask: (t: string) => string): StepArgView {
  if (b.kind === 'literal') return { name, source: 'literal', detail: b.value === null ? null : clip(mask(String(b.value))) };
  if (b.kind === 'parameter') return { name, source: 'parameter', detail: clip(mask(v.parameters?.find((p) => p.id === b.parameter)?.name ?? b.parameter)) };
  if (b.kind === 'secret') {
    const r = v.secretRefs?.find((x) => x.id === b.ref);
    return { name, source: 'secret', detail: r ? clip(`${r.kind} "${mask(r.label)}"`) : null };
  }
  if (b.kind === 'judge') return { name, source: 'judge', detail: `${b.step}.${b.field}` };
  return { name, source: 'output', detail: b.path ? `${b.step}.${b.path}` : b.step };
}

function targetOf(s: DrawnStep, v: ReadableVersion, mask: (t: string) => string): string | null {
  const el = s.element ? v.elements?.find((e) => e.id === s.element) : undefined;
  const screen = s.screen ? v.screens?.find((x) => x.id === s.screen) : undefined;
  const site = s.sites?.map((id) => v.sites?.find((x) => x.id === id)?.domain).find(Boolean);
  const t = el?.label ?? el?.anchor ?? screen?.label ?? site ?? null;
  return t ? clip(mask(t)) : null;
}

/** The version's steps in order, as the procedure page draws them. */
export function stepList(v: ReadableVersion, mask: (t: string) => string = defaultMask): StepView[] {
  return v.steps.map((s) => {
    const e: Evidence | undefined = v.stepEvidence?.[s.id];
    return {
      id: s.id,
      kind: s.kind,
      label: clip(mask(s.label)),
      tool: s.kind === 'call' && s.tool ? s.tool : null,
      target: targetOf(s, v, mask),
      usesAi: s.kind === 'judge' || s.kind === 'agent',
      commitClass: s.commitClass === true,
      health: healthOf(e),
      counts: { successes: e?.successes ?? 0, failures: e?.failures ?? 0, repairs: e?.repairs ?? 0 },
      args: Object.entries(bindingsOf(s))
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([name, b]) => argView(name, b, v, mask)),
    };
  });
}

export interface DiffStepView {
  id: string;
  kind: string;
  label: string;
  tool: string | null;
}
export interface DiffEntryView {
  change: StepChangeKind;
  before: DiffStepView | null;
  after: DiffStepView | null;
  /** For `rebound`: the arguments whose source changed. */
  args: string[];
  /** One plain sentence. */
  text: string;
}

const stepOf = (s: Step | undefined, mask: (t: string) => string): DiffStepView | null => (s ? { id: s.id, kind: s.kind, label: clip(mask(s.label)), tool: s.kind === 'call' ? s.tool : null } : null);
const name = (s: DiffStepView | null) => (s ? `"${s.label}"` : 'a step');

/** `diffVersions`' result in plain words, masked. */
export function readableDiff(changes: readonly StepChange[], mask: (t: string) => string = defaultMask): DiffEntryView[] {
  return changes.map((c) => {
    const before = stepOf(c.before, mask);
    const after = stepOf(c.after, mask);
    const args = c.args ?? [];
    const text =
      c.kind === 'unchanged'
        ? `${name(after)} is unchanged.`
        : c.kind === 'relocated'
          ? `${name(after)} finds its element another way.`
          : c.kind === 'inserted'
            ? `${name(after)} was added.`
            : c.kind === 'removed'
              ? `${name(before)} was removed.`
              : c.kind === 'rebound'
                ? `${name(after)} takes ${args.join(', ')} from somewhere else.`
                : `${name(before)} was replaced by ${name(after)}.`;
    return { change: c.kind, before, after, args, text };
  });
}
