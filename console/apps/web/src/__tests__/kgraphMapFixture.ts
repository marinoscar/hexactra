// The Map's test graph (E46.21, #795): shaped as `buildGraphView` answers `GET /api/kgraph/graph`.
import type { KgGraph, KgViewNode } from '../kgraph/api';

const node = (id: string, type: KgViewNode['type'], label: string, over: Partial<KgViewNode> = {}): KgViewNode => ({
  id,
  type,
  label,
  health: 'unknown',
  counts: { successes: 0, failures: 0, repairs: 0, uses: 0 },
  unused: false,
  cluster: null,
  procedure: null,
  ...over,
});

/** Shaped as `buildGraphView` answers: 3 tasks, sites a.test and b.test, one account with two tools (one unused), two saved logins (one unused). */
export function threeTasks(): KgGraph {
  const nodes: KgViewNode[] = [
    node('procedure:p1', 'Procedure', 'invoices', { health: 'healthy', counts: { successes: 5, failures: 0, repairs: 1, uses: 2 } }),
    node('step:p1:s1', 'Step', 'open the portal', { cluster: 'site:a.test', procedure: 'procedure:p1' }),
    node('step:p1:s2', 'Step', 'mail the invoice', { cluster: 'site:a.test', procedure: 'procedure:p1' }),
    node('procedure:p2', 'Procedure', 'orders', { health: 'degraded' }),
    node('step:p2:s1', 'Step', 'sign in', { cluster: 'site:b.test', procedure: 'procedure:p2' }),
    node('step:p2:s2', 'Step', 'compare prices', { cluster: 'site:a.test', procedure: 'procedure:p2' }),
    node('procedure:p3', 'Procedure', 'report', { health: 'failing' }),
    node('step:p3:s1', 'Step', 'read the report', { cluster: 'site:b.test', procedure: 'procedure:p3' }),
    node('param:p3:week', 'Parameter', 'week', { procedure: 'procedure:p3' }),
    node('output:p3:o1', 'Output', 'total', { procedure: 'procedure:p3' }),
    node('site:a.test', 'Site', 'a.test', { cluster: 'site:a.test' }),
    node('site:b.test', 'Site', 'b.test', { cluster: 'site:b.test' }),
    node('account:acct1', 'Account', 'Work mail', { cluster: 'account:acct1' }),
    node('tool:mail_send', 'Tool', 'mail_send', { cluster: 'account:acct1' }),
    node('tool:drive_list', 'Tool', 'drive_list', { cluster: 'account:acct1', unused: true }),
    node('secret:login:portal', 'SecretRef', 'Portal'),
    node('secret:login:old', 'SecretRef', 'Old shop', { unused: true }),
  ];
  const edges: KgGraph['edges'] = [
    { type: 'uses', from: 'procedure:p1', to: 'account:acct1' },
    { type: 'uses', from: 'step:p1:s1', to: 'site:a.test' },
    { type: 'uses', from: 'step:p1:s2', to: 'site:a.test' },
    { type: 'uses', from: 'step:p1:s2', to: 'tool:mail_send' },
    { type: 'feeds', from: 'step:p1:s1', to: 'step:p1:s2' },
    { type: 'has', from: 'procedure:p1', to: 'step:p1:s1' },
    { type: 'then', from: 'step:p1:s1', to: 'step:p1:s2' },
    { type: 'uses', from: 'step:p2:s1', to: 'site:b.test' },
    { type: 'uses', from: 'step:p2:s1', to: 'secret:login:portal' },
    { type: 'uses', from: 'step:p2:s2', to: 'site:a.test' },
    { type: 'has', from: 'procedure:p2', to: 'step:p2:s1' },
    { type: 'then', from: 'step:p2:s1', to: 'step:p2:s2' },
    { type: 'uses', from: 'step:p3:s1', to: 'site:b.test' },
    { type: 'feeds', from: 'param:p3:week', to: 'step:p3:s1' },
    { type: 'feeds', from: 'step:p3:s1', to: 'output:p3:o1' },
    { type: 'has', from: 'procedure:p3', to: 'step:p3:s1' },
    { type: 'uses', from: 'account:acct1', to: 'tool:drive_list' },
  ];
  return {
    enabled: true,
    nodes,
    edges,
    clusters: [
      { id: 'site:a.test', kind: 'site', label: 'a.test', nodes: ['step:p1:s1', 'step:p1:s2', 'step:p2:s2', 'site:a.test'] },
      { id: 'site:b.test', kind: 'site', label: 'b.test', nodes: ['step:p2:s1', 'step:p3:s1', 'site:b.test'] },
      { id: 'account:acct1', kind: 'account', label: 'Work mail', nodes: ['account:acct1', 'tool:mail_send', 'tool:drive_list'] },
    ],
    collapsed: false,
    truncated: false,
    totalNodes: nodes.length,
    nodeLimit: 2000,
    nextCursor: null,
  };
}
