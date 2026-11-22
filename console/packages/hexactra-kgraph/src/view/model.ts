// The plain view model the visualizer (the Map), the API and exports read (E46.19). Pure: no I/O, no clock. It reads only what a map draws
// (step kinds, labels, tools, sites, bindings by kind, evidence counts); a version's screens, elements, selectors and checks are never needed,
// so a host can leave them out of the read. Every label passes the host's `mask` (default: a label the sensitive predicate flags is hidden);
// a secret reference is its label only; a parameter is its name only (a sensitive one too); a literal value is never a node.
import type { Binding, Evidence, VersionState } from '../schema';
import { defaultIsSensitive } from '../validate';

export const VIEW_NODE_TYPES = ['Procedure', 'Step', 'Site', 'Account', 'Tool', 'SecretRef', 'Parameter', 'Output'] as const;
export type ViewNodeType = (typeof VIEW_NODE_TYPES)[number];
/** `has`: a procedure's entry step. `then`: control flow. `feeds`: data flow (an output into a later step, a step into an output). `uses`: a step or procedure uses a capability. */
export const VIEW_EDGE_TYPES = ['has', 'then', 'feeds', 'uses'] as const;
export type ViewEdgeType = (typeof VIEW_EDGE_TYPES)[number];
export const VIEW_HEALTH = ['healthy', 'degraded', 'failing', 'unknown'] as const;
export type ViewHealth = (typeof VIEW_HEALTH)[number];

/** Above this many nodes the view collapses steps into their procedures, then pages over procedures. */
export const DEFAULT_NODE_LIMIT = 2000;

export interface ViewCounts {
  successes: number;
  failures: number;
  repairs: number;
  /** Steps (or procedures, for an account) that use the node. */
  uses: number;
}
export interface ViewNode {
  id: string;
  type: ViewNodeType;
  label: string;
  health: ViewHealth;
  counts: ViewCounts;
  /** A capability (account, tool, saved login, site) of the owner's that no procedure uses yet. */
  unused: boolean;
  /** The cluster (per site, per account) the node is drawn in. */
  cluster: string | null;
  /** The procedure a step, parameter or output belongs to. */
  procedure: string | null;
}
export interface ViewEdge {
  type: ViewEdgeType;
  from: string;
  to: string;
}
export interface ViewCluster {
  id: string;
  kind: 'site' | 'account';
  label: string;
  nodes: string[];
}
export interface GraphView {
  nodes: ViewNode[];
  edges: ViewEdge[];
  clusters: ViewCluster[];
  /** Steps, parameters and outputs were folded into their procedures (the graph was over the node limit). */
  collapsed: boolean;
  /** Only part of the procedures is in this page; `nextCursor` reads the next. */
  truncated: boolean;
  /** Nodes before collapsing and paging. */
  totalNodes: number;
  nodeLimit: number;
  nextCursor: number | null;
}

/** A step as the map reads it: no checks, guards, selectors or element fingerprints. */
export interface DrawnStep {
  id: string;
  kind: string;
  label: string;
  tool?: string;
  sites?: string[];
  commitClass?: boolean;
  args?: Record<string, Binding>;
  inputs?: Record<string, Binding>;
  from?: string;
  screen?: string;
  element?: string;
}
/** The parts of a stored version the map draws. */
export interface DrawnVersion {
  id: string;
  state: VersionState;
  entry?: string;
  steps: DrawnStep[];
  edges?: { type: string; from: string; to: string }[];
  sites?: { id: string; domain: string }[];
  accounts?: { id: string; connectionId: string; provider: string }[];
  secretRefs?: { id: string; kind: string; label: string }[];
  parameters?: { id: string; name: string; sensitive?: boolean }[];
  outputs?: { id: string; name: string; step: string; sensitive?: boolean }[];
  evidence?: Evidence;
  stepEvidence?: Record<string, Evidence>;
}
export interface ViewProcedure {
  id: string;
  name: string;
  /** The version drawn (the active one, else the newest); null when it has none. */
  version: DrawnVersion | null;
}
/**
 * A capability of the owner's a host lists so the map shows the whole set, used or not. `key` is what a version refers to it by: a connection id
 * (Account), a registrable domain (Site), `kind:label` (SecretRef) or a tool name (Tool). `account` puts a Tool in its server's cluster.
 */
export interface ExtraNode {
  type: 'Account' | 'Tool' | 'SecretRef' | 'Site';
  key: string;
  label: string;
  account?: string;
}
export interface GraphViewInput {
  procedures: readonly ViewProcedure[];
  extras?: readonly ExtraNode[];
  /** Only these node types (edges whose ends are both kept). */
  types?: readonly ViewNodeType[];
  /** Only procedures that touch this registrable domain (and no unused capability). */
  site?: string;
  /** Include the host's capabilities no procedure uses. Default true. */
  includeUnused?: boolean;
  nodeLimit?: number;
  /** The procedure offset of the page (from `nextCursor`). */
  cursor?: number;
  mask?: (text: string) => string;
}

export const defaultMask = (text: string): string => (defaultIsSensitive(text) ? '[masked]' : text);

/** Health from evidence: a suspended version fails; no runs is unknown; a last failure, or more than one in five failing, is degraded. */
export function healthOf(e: Evidence | undefined | null, state?: VersionState | null): ViewHealth {
  if (state === 'suspended') return 'failing';
  if (!e || e.successes + e.failures === 0) return 'unknown';
  const lastFailed = e.lastFailureAt !== null && (e.lastSuccessAt === null || e.lastFailureAt > e.lastSuccessAt);
  if (lastFailed) return e.successes === 0 ? 'failing' : 'degraded';
  return e.failures / (e.successes + e.failures) > 0.2 ? 'degraded' : 'healthy';
}

const clip = (s: string, n = 200) => (s.length > n ? `${s.slice(0, n - 1)}…` : s);
const counts = (e?: Evidence | null, uses = 0): ViewCounts => ({ successes: e?.successes ?? 0, failures: e?.failures ?? 0, repairs: e?.repairs ?? 0, uses });
const secretKey = (kind: string, label: string) => `${kind}:${label.toLowerCase()}`;
export const bindingsOf = (s: DrawnStep): Record<string, Binding> => ({ ...(s.args ?? {}), ...(s.inputs ?? {}) });

/** A domain or one of its subdomains. */
const onSite = (domain: string, site: string) => domain === site || domain.endsWith(`.${site}`);

class Builder {
  readonly nodes = new Map<string, ViewNode>();
  readonly edges = new Map<string, ViewEdge>();
  constructor(readonly mask: (t: string) => string) {}
  node(id: string, type: ViewNodeType, label: string, over: Partial<ViewNode> = {}): ViewNode {
    let n = this.nodes.get(id);
    if (!n) {
      n = { id, type, label: clip(this.mask(label)), health: 'unknown', counts: counts(), unused: false, cluster: null, procedure: null, ...over };
      this.nodes.set(id, n);
    }
    return n;
  }
  edge(type: ViewEdgeType, from: string, to: string): void {
    if (from !== to) this.edges.set(`${type}|${from}|${to}`, { type, from, to });
  }
}

/** One procedure's nodes and edges: its steps (or, folded, the procedure alone) and the capabilities they use. */
function addProcedure(b: Builder, p: ViewProcedure, withSteps: boolean): void {
  const v = p.version;
  const pid = `procedure:${p.id}`;
  const domains = new Map((v?.sites ?? []).map((s) => [s.id, s.domain]));
  const firstSite = v?.steps.flatMap((s) => s.sites ?? []).map((id) => domains.get(id)).find(Boolean) ?? v?.sites?.[0]?.domain;
  b.node(pid, 'Procedure', p.name, { health: v ? healthOf(v.evidence, v.state) : 'unknown', counts: counts(v?.evidence, v?.steps.length ?? 0), cluster: !withSteps && firstSite ? `site:${firstSite}` : null });
  if (!v) return;
  const use = (from: string, id: string, type: ViewNodeType, label: string, over: Partial<ViewNode> = {}) => {
    const n = b.node(id, type, label, over);
    n.counts.uses++;
    b.edge('uses', from, id);
  };
  for (const a of v.accounts ?? []) use(pid, `account:${a.connectionId}`, 'Account', a.provider, { cluster: `account:${a.connectionId}` });
  const refs = new Map((v.secretRefs ?? []).map((r) => [r.id, r]));
  const params = new Map((v.parameters ?? []).map((x) => [x.id, x]));
  const stepIds = new Set(v.steps.map((s) => s.id));
  const sid = (id: string) => (withSteps ? `step:${p.id}:${id}` : pid);
  for (const s of v.steps) {
    const from = sid(s.id);
    if (withSteps) {
      const site = (s.sites ?? []).map((id) => domains.get(id)).find(Boolean);
      b.node(from, 'Step', s.label, { health: healthOf(v.stepEvidence?.[s.id]), counts: counts(v.stepEvidence?.[s.id], 1), cluster: site ? `site:${site}` : null, procedure: pid });
    }
    if (s.kind === 'call' && s.tool) use(from, `tool:${s.tool}`, 'Tool', s.tool);
    for (const siteId of s.sites ?? []) {
      const d = domains.get(siteId);
      if (d) use(from, `site:${d}`, 'Site', d, { cluster: `site:${d}` });
    }
    for (const bnd of Object.values(bindingsOf(s))) {
      if (bnd.kind === 'secret') {
        const r = refs.get(bnd.ref);
        if (r) use(from, `secret:${secretKey(r.kind, r.label)}`, 'SecretRef', r.label);
      } else if (bnd.kind === 'parameter' && withSteps) {
        const x = params.get(bnd.parameter);
        if (x) {
          b.node(`param:${p.id}:${x.id}`, 'Parameter', x.name, { procedure: pid }).counts.uses++;
          b.edge('feeds', `param:${p.id}:${x.id}`, from);
        }
      } else if ((bnd.kind === 'output' || bnd.kind === 'judge') && withSteps && stepIds.has(bnd.step)) b.edge('feeds', sid(bnd.step), from);
    }
    if (s.kind === 'extract' && s.from && withSteps && stepIds.has(s.from)) b.edge('feeds', sid(s.from), from);
  }
  for (const s of v.sites ?? []) if (!v.steps.some((st) => st.sites?.includes(s.id))) use(pid, `site:${s.domain}`, 'Site', s.domain, { cluster: `site:${s.domain}` });
  if (!withSteps) return;
  const entry = v.entry && stepIds.has(v.entry) ? v.entry : v.steps[0]?.id;
  if (entry) b.edge('has', pid, sid(entry));
  const then = (v.edges ?? []).filter((e) => e.type === 'then' && stepIds.has(e.from) && stepIds.has(e.to));
  if (then.length) for (const e of then) b.edge('then', sid(e.from), sid(e.to));
  else for (let i = 1; i < v.steps.length; i++) b.edge('then', sid(v.steps[i - 1]!.id), sid(v.steps[i]!.id));
  for (const o of v.outputs ?? []) {
    b.node(`output:${p.id}:${o.id}`, 'Output', o.name, { procedure: pid });
    if (stepIds.has(o.step)) b.edge('feeds', sid(o.step), `output:${p.id}:${o.id}`);
  }
}

function extraId(x: ExtraNode): string {
  if (x.type === 'Account') return `account:${x.key}`;
  if (x.type === 'Site') return `site:${x.key}`;
  if (x.type === 'Tool') return `tool:${x.key}`;
  const at = x.key.indexOf(':');
  return `secret:${secretKey(at > 0 ? x.key.slice(0, at) : 'login', at > 0 ? x.key.slice(at + 1) : x.key)}`;
}

function addExtras(b: Builder, extras: readonly ExtraNode[], includeUnused: boolean): void {
  for (const x of extras) {
    const id = extraId(x);
    const existing = b.nodes.get(id);
    const cluster = x.type === 'Account' ? `account:${x.key}` : x.type === 'Site' ? `site:${x.key}` : x.account ? `account:${x.account}` : null;
    if (existing) {
      // The host's label (the owner's name for an account) is better than the provider; the cluster of a known server's tool too.
      existing.label = clip(b.mask(x.label));
      if (cluster && !existing.cluster) existing.cluster = cluster;
      continue;
    }
    if (!includeUnused) continue;
    b.node(id, x.type, x.label, { unused: true, cluster });
    if (x.type === 'Tool' && x.account) b.edge('uses', `account:${x.account}`, id);
  }
}

function finish(b: Builder, types: readonly ViewNodeType[] | undefined): { nodes: ViewNode[]; edges: ViewEdge[]; clusters: ViewCluster[] } {
  const keep = types?.length ? new Set(types) : null;
  const nodes = [...b.nodes.values()].filter((n) => !keep || keep.has(n.type));
  const ids = new Set(nodes.map((n) => n.id));
  const edges = [...b.edges.values()].filter((e) => ids.has(e.from) && ids.has(e.to));
  const byCluster = new Map<string, string[]>();
  for (const n of nodes) if (n.cluster) byCluster.set(n.cluster, [...(byCluster.get(n.cluster) ?? []), n.id]);
  const clusters: ViewCluster[] = [...byCluster.entries()].map(([id, members]) => {
    const kind = id.startsWith('site:') ? ('site' as const) : ('account' as const);
    const anchor = b.nodes.get(id);
    return { id, kind, label: anchor?.label ?? id.slice(id.indexOf(':') + 1), nodes: members };
  });
  return { nodes, edges, clusters };
}

/**
 * The Map's view model: procedures, their steps, parameters and outputs, and the capabilities they use (tools, sites, accounts, saved logins),
 * plus the host's capabilities no procedure uses yet (flagged `unused`). Above `nodeLimit` nodes, steps fold into their procedures; if still
 * above, the view pages over procedures (`nextCursor`).
 */
export function buildGraphView(input: GraphViewInput): GraphView {
  const mask = input.mask ?? defaultMask;
  const nodeLimit = Math.max(1, input.nodeLimit ?? DEFAULT_NODE_LIMIT);
  const site = input.site?.toLowerCase();
  const procedures = site ? input.procedures.filter((p) => (p.version?.sites ?? []).some((s) => onSite(s.domain, site))) : [...input.procedures];
  const includeUnused = input.includeUnused !== false && !site;
  const extras = input.extras ?? [];
  const build = (list: readonly ViewProcedure[], withSteps: boolean, unused: boolean) => {
    const b = new Builder(mask);
    for (const p of list) addProcedure(b, p, withSteps);
    addExtras(b, extras, unused);
    return b;
  };
  const full = build(procedures, true, includeUnused);
  const totalNodes = full.nodes.size;
  const page = { collapsed: false, truncated: false, totalNodes, nodeLimit, nextCursor: null as number | null };
  if (totalNodes <= nodeLimit && !input.cursor) return { ...finish(full, input.types), ...page };
  const folded = build(procedures, false, includeUnused);
  if (folded.nodes.size <= nodeLimit && !input.cursor) return { ...finish(folded, input.types), ...page, collapsed: true };
  // Page over procedures: each page holds whole procedures with their capabilities; the first page also the unused capabilities that fit.
  const start = Math.max(0, input.cursor ?? 0);
  const b = new Builder(mask);
  let i = start;
  for (; i < procedures.length; i++) {
    const trial = new Builder(mask);
    for (const [k, n] of b.nodes) trial.nodes.set(k, { ...n, counts: { ...n.counts } });
    for (const [k, e] of b.edges) trial.edges.set(k, e);
    addProcedure(trial, procedures[i]!, false);
    if (trial.nodes.size > nodeLimit && i > start) break;
    b.nodes.clear();
    b.edges.clear();
    for (const [k, n] of trial.nodes) b.nodes.set(k, n);
    for (const [k, e] of trial.edges) b.edges.set(k, e);
    if (b.nodes.size >= nodeLimit) {
      i++;
      break;
    }
  }
  addExtras(b, includeUnused && start === 0 ? extras.slice(0, Math.max(0, nodeLimit - b.nodes.size)) : extras.filter((x) => b.nodes.has(extraId(x))), includeUnused && start === 0);
  const nextCursor = i < procedures.length ? i : null;
  return { ...finish(b, input.types), ...page, collapsed: true, truncated: nextCursor !== null || start > 0, nextCursor };
}
