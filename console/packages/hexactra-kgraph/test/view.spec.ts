// E46.19 (#793): the Map's view model, the step list and the readable diff. Pure.
import { diffVersions } from '../src/repair';
import { aVersion, call, lit, out, param, secret, sensitiveParam } from '../src/testing';
import { buildGraphView, healthOf, readableDiff, stepList, type ViewProcedure } from '../src/view';
import type { ProcedureVersion } from '../src/schema';

const CARD = '4111 1111 1111 1111';
const at = (d: string) => `2026-01-0${d}T00:00:00.000Z`;

function version(over: Partial<Parameters<typeof aVersion>[1]> = {}): ProcedureVersion {
  return aVersion(
    [
      call('s1', 'navigate', { url: lit('https://shop.example.com/') }, { sites: ['s1'] }),
      call('s2', 'type', { text: param('who'), card: lit(CARD) }, { sites: ['s1'], element: 'el1', label: `Type ${CARD}` }),
      call('s3', 'type_secret', { secret: secret('r1') }, { sites: ['s1'] }),
      { id: 's4', kind: 'judge', label: 'Is it paid?', inputs: { page: out('s1') }, output: [{ name: 'paid', type: 'boolean' }] },
      call('s5', 'mail_send', { body: out('s4') }, { commitClass: true }),
    ],
    {
      accounts: [{ id: 'a1', connectionId: 'conn-1', provider: 'google' }],
      secretRefs: [{ id: 'r1', kind: 'login', label: 'Shop login' }],
      parameters: [sensitiveParam('pin'), { id: 'who', name: 'Customer', type: 'string', sensitive: false, required: true }],
      outputs: [{ id: 'o1', name: 'paid', step: 's4', sensitive: false }],
      screens: [{ id: 'sc', site: 's1', label: 'Checkout' }],
      elements: [{ id: 'el1', screen: 'sc', label: 'Card number', selectors: ['#cc'] }],
      evidence: { successes: 4, failures: 0, repairs: 0, lastSuccessAt: at('4'), lastFailureAt: null },
      stepEvidence: { s2: { successes: 1, failures: 1, repairs: 0, lastSuccessAt: at('1'), lastFailureAt: at('2') } },
      ...over,
    },
  );
}
const proc = (id: string, v: ProcedureVersion | null = version()): ViewProcedure => ({ id, name: `Pay ${id}`, version: v });

describe('healthOf', () => {
  it('reads evidence and the suspended state', () => {
    expect(healthOf(undefined)).toBe('unknown');
    expect(healthOf({ successes: 3, failures: 0, repairs: 0, lastSuccessAt: at('3'), lastFailureAt: null })).toBe('healthy');
    expect(healthOf({ successes: 3, failures: 1, repairs: 0, lastSuccessAt: at('1'), lastFailureAt: at('2') })).toBe('degraded');
    expect(healthOf({ successes: 0, failures: 2, repairs: 0, lastSuccessAt: null, lastFailureAt: at('2') })).toBe('failing');
    expect(healthOf({ successes: 9, failures: 0, repairs: 0, lastSuccessAt: at('3'), lastFailureAt: null }, 'suspended')).toBe('failing');
  });
});

describe('buildGraphView', () => {
  it('draws procedures, steps and the capabilities they use, with edges and clusters', () => {
    const g = buildGraphView({ procedures: [proc('p1')] });
    const ids = g.nodes.map((n) => n.id);
    expect(ids).toEqual(expect.arrayContaining(['procedure:p1', 'step:p1:s1', 'tool:navigate', 'site:example.com', 'account:conn-1', 'secret:login:shop login', 'param:p1:who', 'output:p1:o1']));
    expect(g.nodes.find((n) => n.id === 'procedure:p1')).toMatchObject({ type: 'Procedure', health: 'healthy', counts: { successes: 4, uses: 5 }, unused: false });
    expect(g.nodes.find((n) => n.id === 'step:p1:s2')).toMatchObject({ health: 'degraded', cluster: 'site:example.com', procedure: 'procedure:p1' });
    expect(g.edges).toEqual(
      expect.arrayContaining([
        { type: 'has', from: 'procedure:p1', to: 'step:p1:s1' },
        { type: 'then', from: 'step:p1:s1', to: 'step:p1:s2' },
        { type: 'feeds', from: 'step:p1:s1', to: 'step:p1:s4' },
        { type: 'feeds', from: 'param:p1:who', to: 'step:p1:s2' },
        { type: 'uses', from: 'step:p1:s3', to: 'secret:login:shop login' },
        { type: 'uses', from: 'procedure:p1', to: 'account:conn-1' },
        { type: 'feeds', from: 'step:p1:s4', to: 'output:p1:o1' },
      ]),
    );
    expect(g.clusters.find((c) => c.id === 'site:example.com')?.nodes).toEqual(expect.arrayContaining(['site:example.com', 'step:p1:s1']));
    expect(g).toMatchObject({ collapsed: false, truncated: false, nextCursor: null });
  });

  it('never draws a typed value: a literal is not a node and a sensitive label is masked', () => {
    const g = buildGraphView({ procedures: [proc('p1')] });
    expect(JSON.stringify(g)).not.toContain(CARD);
    expect(g.nodes.find((n) => n.id === 'step:p1:s2')?.label).toBe('[masked]');
    // A sensitive parameter that no step uses is not drawn; one that is drawn shows its name only.
    expect(g.nodes.some((n) => n.id === 'param:p1:pin')).toBe(false);
    const masked = buildGraphView({ procedures: [proc('p1')], mask: (t) => t.replace(/Shop/g, '••••') });
    expect(masked.nodes.find((n) => n.type === 'SecretRef')?.label).toBe('•••• login');
  });

  it('adds the host capabilities no procedure uses, flagged unused, and merges the ones it does', () => {
    const g = buildGraphView({
      procedures: [proc('p1')],
      extras: [
        { type: 'Account', key: 'conn-1', label: 'Work Gmail' },
        { type: 'Account', key: 'conn-2', label: 'Personal Outlook' },
        { type: 'Tool', key: 'crm_lookup', label: 'CRM lookup', account: 'conn-3' },
        { type: 'Account', key: 'conn-3', label: 'CRM server' },
        { type: 'SecretRef', key: 'login:Bank login', label: 'Bank login' },
        { type: 'SecretRef', key: 'login:shop login', label: 'Shop login' },
      ],
    });
    const n = (id: string) => g.nodes.find((x) => x.id === id);
    expect(n('account:conn-1')).toMatchObject({ label: 'Work Gmail', unused: false });
    expect(n('account:conn-2')).toMatchObject({ unused: true, cluster: 'account:conn-2' });
    expect(n('tool:crm_lookup')).toMatchObject({ unused: true, cluster: 'account:conn-3' });
    expect(n('secret:login:bank login')?.unused).toBe(true);
    expect(n('secret:login:shop login')?.unused).toBe(false);
    expect(g.edges).toContainEqual({ type: 'uses', from: 'account:conn-3', to: 'tool:crm_lookup' });
    expect(g.clusters.find((c) => c.id === 'account:conn-3')).toMatchObject({ kind: 'account', label: 'CRM server' });
    expect(buildGraphView({ procedures: [proc('p1')], extras: [{ type: 'Account', key: 'conn-2', label: 'x' }], includeUnused: false }).nodes.some((x) => x.id === 'account:conn-2')).toBe(false);
  });

  it('filters by node type and by site', () => {
    const other = version({ sites: [{ id: 's1', domain: 'other.org' }] });
    const g = buildGraphView({ procedures: [proc('p1'), proc('p2', other)], types: ['Procedure', 'Site'] });
    expect(new Set(g.nodes.map((n) => n.type))).toEqual(new Set(['Procedure', 'Site']));
    expect(g.edges.every((e) => e.type === 'uses')).toBe(true);
    const bySite = buildGraphView({ procedures: [proc('p1'), proc('p2', other)], site: 'example.com', extras: [{ type: 'Account', key: 'x', label: 'x' }] });
    expect(bySite.nodes.some((n) => n.id === 'procedure:p2')).toBe(false);
    expect(bySite.nodes.some((n) => n.id === 'account:x')).toBe(false);
  });

  it('folds steps into procedures above the node limit, then pages over procedures', () => {
    const many = Array.from({ length: 30 }, (_, i) => proc(`p${i}`));
    const folded = buildGraphView({ procedures: many, nodeLimit: 100 });
    expect(folded).toMatchObject({ collapsed: true, truncated: false });
    expect(folded.nodes.some((n) => n.type === 'Step')).toBe(false);
    expect(folded.totalNodes).toBeGreaterThan(100);
    expect(folded.edges).toContainEqual({ type: 'uses', from: 'procedure:p0', to: 'tool:navigate' });
    expect(folded.nodes.find((n) => n.id === 'procedure:p0')?.cluster).toBe('site:example.com');

    const first = buildGraphView({ procedures: many, nodeLimit: 20 });
    expect(first).toMatchObject({ collapsed: true, truncated: true });
    expect(first.nodes.length).toBeLessThanOrEqual(20);
    expect(first.nextCursor).toBeGreaterThan(0);
    const seen = new Set(first.nodes.filter((n) => n.type === 'Procedure').map((n) => n.id));
    let cursor = first.nextCursor;
    while (cursor !== null) {
      const page = buildGraphView({ procedures: many, nodeLimit: 20, cursor });
      expect(page.nodes.length).toBeLessThanOrEqual(20);
      for (const n of page.nodes) if (n.type === 'Procedure') seen.add(n.id);
      cursor = page.nextCursor;
    }
    expect(seen.size).toBe(30);
  });

  it('draws a procedure without a version as a lone node', () => {
    expect(buildGraphView({ procedures: [proc('p9', null)] }).nodes).toEqual([expect.objectContaining({ id: 'procedure:p9', health: 'unknown', counts: expect.objectContaining({ uses: 0 }) })]);
  });
});

describe('stepList and readableDiff', () => {
  it('lists steps in order with tool, target, AI use and health; arguments by source, never a value', () => {
    const steps = stepList(version(), (t) => t.replace(CARD, '•••• •••• •••• 1111'));
    expect(steps.map((s) => [s.id, s.kind, s.tool, s.usesAi, s.commitClass])).toEqual([
      ['s1', 'call', 'navigate', false, false],
      ['s2', 'call', 'type', false, false],
      ['s3', 'call', 'type_secret', false, false],
      ['s4', 'judge', null, true, false],
      ['s5', 'call', 'mail_send', false, true],
    ]);
    expect(steps[1]).toMatchObject({ target: 'Card number', health: 'degraded', counts: { successes: 1, failures: 1 } });
    expect(steps[1]!.args).toEqual([
      { name: 'card', source: 'literal', detail: '•••• •••• •••• 1111' },
      { name: 'text', source: 'parameter', detail: 'Customer' },
    ]);
    expect(steps[2]!.args).toEqual([{ name: 'secret', source: 'secret', detail: 'login "Shop login"' }]);
    expect(steps[0]!.target).toBe('example.com');
    expect(JSON.stringify(stepList(version()))).not.toContain(CARD);
  });

  it('says what changed in plain words', () => {
    const prev = version();
    const next = aVersion([call('t1', 'navigate', { url: lit('https://shop.example.com/') }), call('t9', 'click', { selector: lit('#go') }), call('t5', 'mail_send', { body: param('who') })], {
      parameters: [{ id: 'who', name: 'Customer', type: 'string', sensitive: false, required: true }],
    });
    const d = readableDiff(diffVersions(prev, next));
    expect(d.map((x) => x.change)).toEqual(expect.arrayContaining(['unchanged', 'rebound']));
    expect(d.find((x) => x.change === 'rebound')).toMatchObject({ args: ['body'], text: expect.stringContaining('takes body from somewhere else') });
    expect(JSON.stringify(d)).not.toContain(CARD);
  });
});
