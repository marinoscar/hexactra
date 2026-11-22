// The diff of a repair (E46.17): the version compiled from the run the agent finished, aligned with the version that handed over. Pure.
import type { Binding, ProcedureVersion, Step } from '../schema';

export type StepChangeKind = 'unchanged' | 'relocated' | 'inserted' | 'removed' | 'rebound' | 'retargeted';

export interface StepChange {
  kind: StepChangeKind;
  /** The step in the old version (absent for an insert). */
  before?: Step;
  /** The step in the new version (absent for a removal). */
  after?: Step;
  /** For `rebound`: the arguments whose binding changed. */
  args?: string[];
}

const calls = (v: ProcedureVersion) => v.steps.filter((s) => s.kind === 'call' || s.kind === 'judge' || s.kind === 'ask' || s.kind === 'foreach' || s.kind === 'branch');
const keyOf = (s: Step) => (s.kind === 'call' ? `call:${s.tool}` : s.kind);
const bindingsOf = (s: Step): Record<string, Binding> => (s.kind === 'call' ? s.args : s.kind === 'judge' ? s.inputs : {});
/** A binding compared by what it means, not by step ids (which differ between compiles). */
const sig = (b: Binding | undefined, v: ProcedureVersion): string => {
  if (!b) return '-';
  if (b.kind === 'literal') return `lit:${JSON.stringify(b.value)}`;
  if (b.kind === 'parameter') return `param:${b.parameter}`;
  if (b.kind === 'secret') return `secret:${v.secretRefs.find((r) => r.id === b.ref)?.label ?? b.ref}:${b.field}`;
  const src = v.steps.find((s) => s.id === b.step);
  return `${b.kind}:${src ? keyOf(src) : '?'}:${b.kind === 'output' ? (b.path ?? '') : b.field}`;
};
const elementOf = (s: Step, v: ProcedureVersion) => (s.element ? v.elements.find((e) => e.id === s.element) : undefined);

/** Longest common subsequence alignment of the two versions' acting steps by kind and tool. */
export function diffVersions(prev: ProcedureVersion, next: ProcedureVersion): StepChange[] {
  const a = calls(prev);
  const b = calls(next);
  const L = Array.from({ length: a.length + 1 }, () => new Array<number>(b.length + 1).fill(0));
  for (let i = a.length - 1; i >= 0; i--) for (let j = b.length - 1; j >= 0; j--) L[i]![j] = keyOf(a[i]!) === keyOf(b[j]!) ? L[i + 1]![j + 1]! + 1 : Math.max(L[i + 1]![j]!, L[i]![j + 1]!);
  const out: StepChange[] = [];
  let i = 0;
  let j = 0;
  while (i < a.length || j < b.length) {
    if (i < a.length && j < b.length && keyOf(a[i]!) === keyOf(b[j]!)) {
      out.push(compare(a[i]!, b[j]!, prev, next));
      i++;
      j++;
    } else if (j < b.length && (i >= a.length || L[i]![j + 1]! >= L[i + 1]![j]!)) {
      // An insert next to a removal of a different tool at the same place is a retarget.
      const last = out[out.length - 1];
      if (last?.kind === 'removed' && !last.after) {
        last.kind = 'retargeted';
        last.after = b[j]!;
      } else out.push({ kind: 'inserted', after: b[j]! });
      j++;
    } else {
      const last = out[out.length - 1];
      if (last?.kind === 'inserted' && !last.before) {
        last.kind = 'retargeted';
        last.before = a[i]!;
      } else out.push({ kind: 'removed', before: a[i]! });
      i++;
    }
  }
  return out;
}

function compare(before: Step, after: Step, prev: ProcedureVersion, next: ProcedureVersion): StepChange {
  const ba = bindingsOf(before);
  const aa = bindingsOf(after);
  const names = [...new Set([...Object.keys(ba), ...Object.keys(aa)])].sort();
  const elBefore = elementOf(before, prev);
  const elAfter = elementOf(after, next);
  const moved = (elBefore?.selectors.join('|') ?? '') !== (elAfter?.selectors.join('|') ?? '') || (before.element ?? null) !== (after.element ?? null);
  // A selector argument that follows the element is part of the relocation, not a rebinding.
  const changed = names.filter((n) => !(n === 'selector' && moved) && sig(ba[n], prev) !== sig(aa[n], next));
  if (changed.length > 0) return { kind: 'rebound', before, after, args: changed };
  if (moved) return { kind: 'relocated', before, after };
  return { kind: 'unchanged', before, after };
}
