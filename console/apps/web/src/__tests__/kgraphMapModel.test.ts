// The Map's pure mapping (E46.21, #795): clusters, expansion, the type filter, search, focus, "what uses this site", the node limit
// and the names screen readers read. The acceptance case: 3 tasks across 2 sites and 1 account.
import { describe, expect, it } from 'vitest';

import type { KgGraph } from '../kgraph/api';
import { buildMap, kindOf, tasksUsing, toggle, touchedBy, type MapProcedureInfo } from '../kgraph/map/mapModel';
import { threeTasks } from './kgraphMapFixture';

const ids = (r: { nodes: { id: string }[] }) => r.nodes.map((n) => n.id).sort();
const edgeKeys = (r: { edges: { style: string; source: string; target: string }[] }) => r.edges.map((e) => `${e.style} ${e.source} -> ${e.target}`).sort();
const CLUSTERED = ['account:acct1', 'procedure:p1', 'procedure:p2', 'procedure:p3', 'secret:login:old', 'secret:login:portal', 'site:a.test', 'site:b.test'];

describe('the Map model: 3 tasks across 2 sites and 1 account', () => {
  it('renders clustered by default: one node per task, site and account; steps and tools folded in', () => {
    const r = buildMap(threeTasks());
    expect(ids(r)).toEqual(CLUSTERED);
    expect(edgeKeys(r)).toEqual([
      'uses procedure:p1 -> account:acct1',
      'uses procedure:p1 -> site:a.test',
      'uses procedure:p2 -> secret:login:portal',
      'uses procedure:p2 -> site:a.test',
      'uses procedure:p2 -> site:b.test',
      'uses procedure:p3 -> site:b.test',
    ]);
    const byId = new Map(r.nodes.map((n) => [n.id, n]));
    expect(byId.get('procedure:p1')).toMatchObject({ kind: 'task', expandable: true, expanded: false, inside: 2 });
    expect(byId.get('procedure:p3')).toMatchObject({ inside: 3 });
    expect(byId.get('account:acct1')).toMatchObject({ kind: 'account', expandable: true, inside: 2 });
    expect(byId.get('site:a.test')).toMatchObject({ expandable: true, inside: 0 });
    expect(r.overLimit).toBe(false);
    expect(r.blocked).toBe(false);
  });

  it('expands a task into its steps, with then (and its entry) solid and feeds dashed', () => {
    const r = buildMap(threeTasks(), new Map(), { expanded: new Set(['procedure:p1']) });
    expect(ids(r)).toEqual([...CLUSTERED, 'step:p1:s1', 'step:p1:s2'].sort());
    expect(edgeKeys(r)).toEqual(
      expect.arrayContaining([
        'then procedure:p1 -> step:p1:s1',
        'then step:p1:s1 -> step:p1:s2',
        'feeds step:p1:s1 -> step:p1:s2',
        'uses step:p1:s1 -> site:a.test',
        // The tool stays in its account's cluster.
        'uses step:p1:s2 -> account:acct1',
      ]),
    );
    expect(r.nodes.find((n) => n.id === 'procedure:p1')).toMatchObject({ expanded: true, inside: 0 });
  });

  it('expands an account into its tools and a site into the steps done on it', () => {
    const account = buildMap(threeTasks(), new Map(), { expanded: new Set(['account:acct1']) });
    expect(ids(account)).toEqual([...CLUSTERED, 'tool:drive_list', 'tool:mail_send'].sort());
    expect(edgeKeys(account)).toEqual(expect.arrayContaining(['uses procedure:p1 -> tool:mail_send', 'uses account:acct1 -> tool:drive_list']));
    const site = buildMap(threeTasks(), new Map(), { expanded: new Set(['site:a.test']) });
    expect(ids(site)).toEqual([...CLUSTERED, 'step:p1:s1', 'step:p1:s2', 'step:p2:s2'].sort());
  });

  it('filters by node type', () => {
    const r = buildMap(threeTasks(), new Map(), { kinds: new Set(['task', 'site'] as const) });
    expect(ids(r)).toEqual(['procedure:p1', 'procedure:p2', 'procedure:p3', 'site:a.test', 'site:b.test']);
    expect(r.edges.every((e) => e.style === 'uses')).toBe(true);
    expect(r.edges).toHaveLength(4);
    const logins = buildMap(threeTasks(), new Map(), { kinds: new Set(['login'] as const) });
    expect(ids(logins)).toEqual(['secret:login:old', 'secret:login:portal']);
    expect(logins.edges).toEqual([]);
  });

  it('searches by name, marking the node a match is folded into', () => {
    const r = buildMap(threeTasks(), new Map(), { search: 'MAIL_send' });
    const matched = r.nodes.filter((n) => n.match).map((n) => n.id);
    expect(matched).toEqual(['account:acct1']);
    expect(r.nodes.filter((n) => !n.dim).map((n) => n.id)).toEqual(['account:acct1']);
  });

  it('focuses on a task: everything it does not touch is dimmed', () => {
    const r = buildMap(threeTasks(), new Map(), { focus: 'procedure:p3' });
    expect(r.nodes.filter((n) => !n.dim).map((n) => n.id).sort()).toEqual(['procedure:p3', 'site:b.test']);
    const lit = r.edges.filter((e) => !e.dim).map((e) => `${e.source} -> ${e.target}`);
    expect(lit).toEqual(['procedure:p3 -> site:b.test']);
    expect(touchedBy(threeTasks(), 'procedure:p1')).toEqual(new Set(['procedure:p1', 'step:p1:s1', 'step:p1:s2', 'account:acct1', 'site:a.test', 'tool:mail_send']));
    // Focused and expanded: its steps stay lit.
    const open = buildMap(threeTasks(), new Map(), { focus: 'procedure:p1', expanded: new Set(['procedure:p1']) });
    expect(open.nodes.filter((n) => !n.dim).map((n) => n.id).sort()).toEqual(['account:acct1', 'procedure:p1', 'site:a.test', 'step:p1:s1', 'step:p1:s2']);
  });

  it('"what uses this site" highlights exactly the tasks that use it', () => {
    const a = buildMap(threeTasks(), new Map(), { impactSite: 'site:a.test' });
    expect(a.affected).toEqual(['procedure:p1', 'procedure:p2']);
    expect(a.nodes.filter((n) => n.highlight).map((n) => n.id).sort()).toEqual(['procedure:p1', 'procedure:p2']);
    expect(a.nodes.filter((n) => !n.dim).map((n) => n.id).sort()).toEqual(['procedure:p1', 'procedure:p2', 'site:a.test']);
    const b = buildMap(threeTasks(), new Map(), { impactSite: 'site:b.test' });
    expect(b.affected).toEqual(['procedure:p2', 'procedure:p3']);
    expect(b.nodes.filter((n) => n.highlight).map((n) => n.id).sort()).toEqual(['procedure:p2', 'procedure:p3']);
    expect(tasksUsing(threeTasks(), 'account:acct1')).toEqual(['procedure:p1']);
    expect(tasksUsing(threeTasks(), 'secret:login:old')).toEqual([]);
  });

  it('draws unused capabilities, flagged so the canvas makes them faint', () => {
    const r = buildMap(threeTasks(), new Map(), { expanded: new Set(['account:acct1']) });
    expect(r.nodes.filter((n) => n.unused).map((n) => n.id).sort()).toEqual(['secret:login:old', 'tool:drive_list']);
    expect(r.nodes.find((n) => n.id === 'secret:login:old')?.name).toBe('Saved login or card: Old shop, not used by any task yet');
  });

  it('stays clustered above the limit, and draws nothing when even the clusters are too many', () => {
    const all = new Set(['procedure:p1', 'procedure:p2', 'procedure:p3', 'account:acct1']);
    const over = buildMap(threeTasks(), new Map(), { expanded: all, limit: 9 });
    expect(over.overLimit).toBe(true);
    expect(over.blocked).toBe(false);
    expect(ids(over)).toEqual(CLUSTERED);
    const blocked = buildMap(threeTasks(), new Map(), { limit: 3 });
    expect(blocked.blocked).toBe(true);
    expect(blocked.nodes).toEqual([]);
    expect(blocked.edges).toEqual([]);
  });

  it('names nodes for screen readers and marks a suspended task', () => {
    const info = new Map<string, MapProcedureInfo>([['p2', { procedureId: 'p2', taskId: 't2', taskName: 'Check the orders', state: 'suspended' }]]);
    const r = buildMap(threeTasks(), info);
    const p2 = r.nodes.find((n) => n.id === 'procedure:p2')!;
    expect(p2).toMatchObject({ suspended: true, info: { taskName: 'Check the orders' } });
    expect(p2.name).toBe('Task: Check the orders, suspended, 2 more inside');
    expect(r.nodes.find((n) => n.id === 'procedure:p1')!.name).toBe('Task: invoices, healthy, 2 more inside');
    expect(r.tasks).toEqual([
      { id: 'procedure:p1', label: 'invoices' },
      { id: 'procedure:p2', label: 'Check the orders' },
      { id: 'procedure:p3', label: 'report' },
    ]);
  });

  it('maps the view types to the kinds the owner filters by, and toggles expansion', () => {
    expect(kindOf({ type: 'SecretRef' })).toBe('login');
    expect(kindOf({ type: 'Parameter' })).toBe('step');
    expect(kindOf({ type: 'Procedure' })).toBe('task');
    expect([...toggle(toggle(new Set(), 'a'), 'b')]).toEqual(['a', 'b']);
    expect([...toggle(new Set(['a']), 'a')]).toEqual([]);
  });

  it('keeps a folded graph (procedures with a site cluster) as top-level tasks', () => {
    const g = threeTasks();
    const folded: KgGraph = {
      ...g,
      collapsed: true,
      nodes: g.nodes.filter((n) => !n.procedure).map((n) => (n.type === 'Procedure' ? { ...n, cluster: 'site:a.test' } : n)),
      edges: g.edges.filter((e) => !e.from.startsWith('step:') && !e.to.startsWith('step:') && !e.from.startsWith('param:')),
    };
    expect(ids(buildMap(folded))).toEqual(CLUSTERED);
  });
});
