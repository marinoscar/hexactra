// E46.18 (#792): a branch only from two diverging successful runs, and each path replays when its guard holds.
import { compileTrace, mergeBranches, type TraceEvent } from '../src/compile';
import { executeProcedure } from '../src/execute';
import { fakePorts, replies } from '../src/testing';
import { validateVersion } from '../src/validate';
import type { Tool } from '../src/schema';

const TOOLS: Tool[] = [
  { name: 'navigate', family: 'browser', commits: false },
  { name: 'click', family: 'browser', commits: false },
  { name: 'read_text', family: 'browser', commits: false },
];
const ev = (seq: number, tool: string, bindings: TraceEvent['bindings'], post: TraceEvent['post'] = {}): TraceEvent => ({ seq, tool, family: 'browser', commits: false, ok: true, outcome: 'ran', bindings, post });
const nav = ev(1, 'navigate', { url: { kind: 'literal', value: 'https://shop.example.com/account' } }, { host: 'shop.example.com', path: '/account' });
const read = (seq: number) => ev(seq, 'click', { selector: { kind: 'literal', value: '#download' } }, { host: 'shop.example.com', path: '/account' });
// Run A: straight to the balance. Run B: a "what's new" interstitial first, dismissed with a click.
const runA = [nav, read(2)];
const runB = [{ ...nav, post: { host: 'shop.example.com', path: '/whats-new' } }, ev(2, 'click', { selector: { kind: 'literal', value: '#continue' } }, { host: 'shop.example.com', path: '/account' }), read(3)];
const compile = (trace: TraceEvent[], id: string) => {
  const r = compileTrace({ procedure: 'p', version: id, number: 1, createdAt: '2026-11-22T00:00:00.000Z', sourceRun: id, trace, tools: TOOLS, parameters: [] });
  if (r.status !== 'candidate') throw new Error(r.status);
  return r.version;
};
const ids = { id: 'm1', number: 2, createdAt: '2026-11-22T01:00:00.000Z', sourceRun: 'rB' };

describe('mergeBranches', () => {
  it('is null for a single run (no divergence)', () => {
    expect(mergeBranches(compile(runA, 'a'), compile(runA, 'a2'), ids)).toBeNull();
  });
  it('two diverging runs with an observable guard give one valid version with a branch', () => {
    const m = mergeBranches(compile(runA, 'a'), compile(runB, 'b'), ids)!;
    expect(m.steps.map((s) => s.kind)).toEqual(['call', 'branch', 'call', 'call']);
    const br = m.steps[1]!;
    expect(br).toMatchObject({ kind: 'branch', guard: { kind: 'location', pathPattern: '/whats-new' } });
    expect(validateVersion(m, { tools: TOOLS })).toEqual([]);
  });
  it('is null when no observable state tells the paths apart', () => {
    const blind = (t: TraceEvent[]) => t.map((e) => ({ ...e, post: {} }));
    expect(mergeBranches(compile(blind(runA), 'a'), compile(blind(runB), 'b'), ids)).toBeNull();
  });
  it('each path replays when its guard holds', async () => {
    const m = mergeBranches(compile(runA, 'a'), compile(runB, 'b'), ids)!;
    for (const [page, clicks] of [['https://shop.example.com/whats-new', 1], ['https://shop.example.com/account', 0]] as const) {
      const ports = fakePorts();
      ports.tools.on('navigate', () => (ports.probe.at(page), replies.ok())).on('click', () => (ports.probe.at('https://shop.example.com/account'), replies.ok()));
      const r = await executeProcedure(m, {}, ports, { goal: 'g' });
      expect(r.status).toBe('completed');
      expect(ports.tools.calls.filter((c) => c.tool === 'click' && c.args.selector === '#continue')).toHaveLength(clicks);
      expect(ports.tools.calls.filter((c) => c.tool === 'click' && c.args.selector === '#download')).toHaveLength(1);
    }
  });
  it('the validator refuses a guard on a view digest and an unbounded loop', () => {
    const m = mergeBranches(compile(runA, 'a'), compile(runB, 'b'), ids)!;
    const bad = { ...m, steps: m.steps.map((s) => (s.kind === 'branch' ? { ...s, guard: { kind: 'view_digest' as const, digest: 'x', tolerance: 0 } } : s)) };
    expect(validateVersion(bad, { tools: TOOLS }).map((v) => v.rule)).toContain('unobservable_guard');
  });
});
