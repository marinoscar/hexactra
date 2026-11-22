// E46.16 (#790): the host's rungs through the ladder, against the fake browser.
import { FakeBrowser } from '@marinoscar/hexactra-browser-agent/testing';
import { procedureVersionSchema, RecoveryLadder, type JudgePort, type LocateRequest } from '@marinoscar/hexactra-kgraph';

import { hostRungs, type Proposal } from '../src/runner/host/kgraph/recovery';

const version = (commitClass = false) =>
  procedureVersionSchema.parse({
    id: 'v1', procedure: 'p1', number: 1, state: 'active', changeClass: 'initial', sourceRun: null, parent: null, createdAt: '2026-01-01T00:00:00.000Z', entry: 's1',
    steps: [{ id: 's1', kind: 'call', label: 'search', tool: 'click', element: 'el:1', commitClass, args: { selector: { kind: 'literal', value: '#go' } } }],
    screens: [{ id: 'sc:1', site: 'site:example.com', label: 'x' }],
    elements: [{ id: 'el:1', screen: 'sc:1', role: 'button', label: 'Search pens', tag: 'button', anchor: 'Find pens', selectors: ['#go'] }],
  });

function virtualClock() {
  let t = 0;
  return { now: () => t, sleep: async (ms: number) => ((t += ms), true) };
}

function setup(surface: Record<string, unknown>[], answer: (r: LocateRequest) => number | null = () => null, commitClass = false) {
  const browser = new FakeBrowser();
  browser.surface = surface;
  const v = version(commitClass);
  const overrides = new Map<string, string>();
  const proposals: Proposal[] = [];
  const locates: LocateRequest[] = [];
  const judge: JudgePort = { judge: async () => ({ ok: false }), locate: async (r) => (locates.push(r), { mark: answer(r) }) };
  const ladder = new RecoveryLadder(hostRungs({ browser, version: v, overrides, judge, propose: async (p) => void proposals.push(p), ...virtualClock() }));
  return { ladder, overrides, proposals, locates, step: v.steps[0]! };
}

describe('the recovery rungs (E46.16)', () => {
  it('a moved button (new id, new place, new container) is recovered at rung 3 with no model call', async () => {
    const t = setup([{ selector: '#search-v2', selectors: ['#search-v2'], role: 'button', name: 'Search', tag: 'a', inputType: null, anchor: 'Header' }]);
    expect(await t.ladder.recover({ step: t.step, kind: 'precondition' })).toEqual({ recovered: true, rung: 'reresolve' });
    expect(t.locates).toHaveLength(0);
    expect(t.overrides.get('s1')).toBe('#search-v2');
    expect(t.proposals).toEqual([{ step: 's1', element: 'el:1', rung: 'reresolve', selector: '#search-v2' }]);
  });
  it('a relabelled button is recovered at rung 4 with exactly one locate call', async () => {
    const t = setup(
      [
        { selector: '#home', selectors: ['#home'], role: 'link', name: 'Home', tag: 'a', inputType: null, anchor: null },
        { selector: '#find', selectors: ['#find'], role: 'button', name: 'Go', tag: 'button', inputType: null, anchor: null },
      ],
      () => 2,
    );
    expect(await t.ladder.recover({ step: t.step, kind: 'precondition' })).toEqual({ recovered: true, rung: 'locate' });
    expect(t.locates).toHaveLength(1);
    expect(t.locates[0]).toMatchObject({ tool: 'click', role: 'button', label: 'Search pens', elements: [{ n: 1 }, { n: 2 }] });
    expect(t.overrides.get('s1')).toBe('#find');
  });
  it('a locate answer naming a mark that does not exist, or an incompatible role, is rejected', async () => {
    const page = [{ selector: '#home', selectors: ['#home'], role: 'link', name: 'Home', tag: 'a', inputType: null, anchor: null }];
    expect((await setup(page, () => 7).ladder.recover({ step: setup(page).step, kind: 'precondition' })).recovered).toBe(false);
    const wrongRole = setup(page, () => 1);
    expect((await wrongRole.ladder.recover({ step: wrongRole.step, kind: 'precondition' })).recovered).toBe(false);
    expect(wrongRole.overrides.size).toBe(0);
  });
  it('a commit-class step skips rung 4 and hands over', async () => {
    const t = setup([{ selector: '#find', selectors: ['#find'], role: 'button', name: 'Go', tag: 'button', inputType: null, anchor: null }], () => 1, true);
    expect(await t.ladder.recover({ step: t.step, kind: 'precondition' })).toEqual({ recovered: false });
    expect(t.locates).toHaveLength(0);
  });
});
