// Branches (E46.18): created only from TWO successful runs of the same task that diverge at a point where each path's precondition is
// observable (a screen, an element present, a result shape) — never from a single run, never on a view digest. Pure.
import type { Check, ProcedureVersion, Step } from '../schema';

const act = (s: Step) => s.kind !== 'extract';
const sig = (s: Step) => JSON.stringify(s.kind === 'call' ? [s.tool, s.args, s.element ?? null] : [s.kind, s.label]);
const observable = (c: Check) => c.kind === 'location' || c.kind === 'element_present';

/** The guard that tells path B from path A: B's first step's observable precondition, when A's first step does not share it. */
function guardFor(a: Step | undefined, b: Step | undefined): Check | null {
  const bc = b?.checks.find(observable);
  if (!bc) return null;
  const same = a?.checks.some((c) => JSON.stringify(c) === JSON.stringify(bc));
  return same ? null : bc;
}

/**
 * Merge two linear versions that share a prefix and a suffix and differ in between into one version with a `branch`: when the guard
 * (B's observable precondition) holds the walk takes B's path, otherwise A's; both rejoin the common suffix. Null when they do not diverge,
 * when nothing is shared, or when no observable guard tells the paths apart.
 */
export function mergeBranches(a: ProcedureVersion, b: ProcedureVersion, ids: { id: string; number: number; createdAt: string; sourceRun: string }): ProcedureVersion | null {
  const sa = a.steps.filter(act);
  const sb = b.steps.filter(act);
  let p = 0;
  while (p < sa.length && p < sb.length && sig(sa[p]!) === sig(sb[p]!)) p++;
  let q = 0;
  while (q < sa.length - p && q < sb.length - p && sig(sa[sa.length - 1 - q]!) === sig(sb[sb.length - 1 - q]!)) q++;
  const midA = sa.slice(p, sa.length - q);
  const midB = sb.slice(p, sb.length - q);
  if ((midA.length === 0 && midB.length === 0) || p === 0) return null;
  // The guard is the page each run was on at the divergence point: what the last shared step observed after it, in each run.
  const guard = guardFor(sa[p - 1], sb[p - 1]);
  const swapped = !guard ? guardFor(sb[p - 1], sa[p - 1]) : null;
  const g = guard ?? swapped;
  if (!g) return null;
  const [thenPath, elsePath] = guard ? [midB, midA] : [midA, midB];
  // The last shared step leads to either path: its page checks cannot hold for both, so the branch guard decides instead.
  const prefix = sa.slice(0, p).map((s, i) => (i === p - 1 ? { ...s, checks: s.checks.filter((c) => c.kind !== 'location' && c.kind !== 'view_digest' && c.kind !== 'element_present') } : s));
  const suffix = sa.slice(sa.length - q);
  const rename = (tag: string, steps: Step[]) => steps.map((s) => ({ ...s, id: `${tag}${s.id}`.slice(0, 200) }));
  const T = rename('t-', thenPath);
  const E = rename('e-', elsePath);
  const join = suffix[0]?.id ?? null;
  if (T.length === 0 && E.length === 0) return null;
  const branch: Step = { id: `br-${prefix[prefix.length - 1]!.id}`.slice(0, 200), kind: 'branch', label: 'which path the page is on', guard: g, then: T[0]?.id ?? join!, else: E[0]?.id ?? join!, sites: [], commitClass: false, checks: [], segment: prefix[prefix.length - 1]!.segment };
  if (!branch.then || !branch.else) return null;
  // Bindings inside a renamed path that point at a step of the same path follow the rename.
  const fix = (tag: string, path: Step[]) => {
    const own = new Set(path.map((s) => s.id.slice(tag.length)));
    for (const s of path) if (s.kind === 'call') for (const [k, v] of Object.entries(s.args)) if ((v.kind === 'output' || v.kind === 'judge') && own.has(v.step)) s.args[k] = { ...v, step: `${tag}${v.step}` };
  };
  fix('t-', T);
  fix('e-', E);
  const steps = [...prefix, branch, ...T, ...E, ...suffix];
  const chain = (xs: Step[]) => xs.slice(1).map((s, i) => ({ type: 'then' as const, from: xs[i]!.id, to: s.id }));
  const edges = [
    ...chain(prefix),
    { type: 'then' as const, from: prefix[prefix.length - 1]!.id, to: branch.id },
    ...chain(T),
    ...chain(E),
    ...(join && T.length ? [{ type: 'then' as const, from: T[T.length - 1]!.id, to: join }] : []),
    ...(join && E.length ? [{ type: 'then' as const, from: E[E.length - 1]!.id, to: join }] : []),
    ...chain(suffix),
  ];
  const sites = [...new Map([...a.sites, ...b.sites].map((x) => [x.id, x])).values()];
  return {
    ...a,
    id: ids.id,
    number: ids.number,
    createdAt: ids.createdAt,
    sourceRun: ids.sourceRun,
    state: 'candidate',
    changeClass: 'structural',
    parent: a.id,
    entry: steps[0]!.id,
    steps,
    edges,
    sites,
    screens: [...new Map([...a.screens, ...b.screens].map((x) => [x.id, x])).values()],
    elements: [...new Map([...a.elements, ...b.elements].map((x) => [x.id, x])).values()],
    parameters: [...new Map([...a.parameters, ...b.parameters].map((x) => [x.id, x])).values()],
    evidence: { successes: 0, failures: 0, repairs: 0, lastSuccessAt: null, lastFailureAt: null },
    stepEvidence: {},
  };
}
