// The Map's pure mapping (E46.21, #795): the API's view model (`GET /api/kgraph/graph`) to what the canvas and its list draw. No React,
// no React Flow, no I/O: clustering, expansion, the type filter, search, "focus on a task", "what uses this site" and the 500-node limit.
// The graph itself (nodes, edges, clusters, health, unused) is the API's; this module only decides what is visible and how it is drawn.
import type { KgGraph, KgHealth, KgVersionState, KgViewNode } from '../api';

/** The node kinds the owner filters by. A procedure is the learned form of a task, so the Map calls it a task. */
export const MAP_KINDS = ['task', 'site', 'account', 'tool', 'login', 'step'] as const;
export type MapKind = (typeof MAP_KINDS)[number];
export const MAP_KIND_LABEL: Record<MapKind, string> = { task: 'Task', site: 'Site', account: 'Account', tool: 'Tool', login: 'Saved login or card', step: 'Step' };

/** The three edge styles: `uses` (faint), `then` (solid; a procedure's entry `has` too) and `feeds` (dashed, coloured). */
export type MapEdgeStyle = 'uses' | 'then' | 'feeds';

/** Above this many visible nodes the canvas stays clustered and asks the owner to filter. */
export const MAP_NODE_LIMIT = 500;

export function kindOf(n: Pick<KgViewNode, 'type'>): MapKind {
  switch (n.type) {
    case 'Procedure':
      return 'task';
    case 'Site':
      return 'site';
    case 'Account':
      return 'account';
    case 'Tool':
      return 'tool';
    case 'SecretRef':
      return 'login';
    default:
      return 'step';
  }
}

/** What the procedures list adds to a procedure node: the task it belongs to and its version's state. */
export interface MapProcedureInfo {
  procedureId: string;
  taskId: string;
  taskName: string;
  state: KgVersionState | null;
}

export interface MapOptions {
  /** Expanded procedure nodes (`procedure:<id>`) and clusters (`site:<domain>`, `account:<id>`). */
  expanded?: ReadonlySet<string>;
  /** The kinds shown; empty or absent shows every kind. */
  kinds?: ReadonlySet<MapKind>;
  search?: string;
  /** A procedure node: everything it does not touch is dimmed. */
  focus?: string | null;
  /** A site node: the tasks a change to that site would affect are highlighted. */
  impactSite?: string | null;
  limit?: number;
}

export interface MapNode {
  id: string;
  kind: MapKind;
  type: KgViewNode['type'];
  label: string;
  /** The name screen readers and the list read: kind, label, and what is hidden inside. */
  name: string;
  health: KgHealth;
  counts: KgViewNode['counts'];
  unused: boolean;
  suspended: boolean;
  /** The procedure's task, for a task node. */
  info: MapProcedureInfo | null;
  expandable: boolean;
  expanded: boolean;
  /** How many nodes are folded into this one. */
  inside: number;
  dim: boolean;
  highlight: boolean;
  match: boolean;
}

export interface MapEdge {
  id: string;
  style: MapEdgeStyle;
  source: string;
  target: string;
  dim: boolean;
  highlight: boolean;
}

export interface MapResult {
  nodes: MapNode[];
  edges: MapEdge[];
  /** Expansions were dropped because they would show more than the limit. */
  overLimit: boolean;
  /** Even clustered, more than the limit is visible: the canvas draws nothing and asks the owner to filter. */
  blocked: boolean;
  limit: number;
  /** "What uses this site": the procedure nodes that use it, sorted. */
  affected: string[];
  /** The procedure nodes, for "focus on a task". */
  tasks: { id: string; label: string }[];
}

const EMPTY = new Set<string>();

/** Procedure node id to procedure id. */
export const procedureIdOf = (nodeId: string) => (nodeId.startsWith('procedure:') ? nodeId.slice('procedure:'.length) : null);

/**
 * Where a raw node is drawn: itself, or the node it is folded into. A task (procedure) and a cluster's anchor (the site or account node)
 * are always drawn. A step, parameter or output is drawn when its task is expanded (a step also when its site is expanded), otherwise
 * inside its task. A tool or saved login in an account's cluster is drawn when that account is expanded, otherwise inside it.
 */
function representative(n: KgViewNode, byId: ReadonlyMap<string, KgViewNode>, expanded: ReadonlySet<string>): string {
  if (n.type === 'Procedure' || n.type === 'Site' || n.type === 'Account') return n.id;
  if (n.type === 'Step' || n.type === 'Parameter' || n.type === 'Output') {
    if (n.procedure && expanded.has(n.procedure)) return n.id;
    if (n.type === 'Step' && n.cluster && byId.has(n.cluster) && expanded.has(n.cluster)) return n.id;
    if (n.procedure && byId.has(n.procedure)) return n.procedure;
    return n.id;
  }
  if (n.cluster && n.cluster !== n.id && byId.has(n.cluster) && !expanded.has(n.cluster)) return n.cluster;
  return n.id;
}

/** Whether a node has anything folded into it at the clustered default (so it can be expanded). */
function expandableIds(graph: KgGraph, byId: ReadonlyMap<string, KgViewNode>): Set<string> {
  const out = new Set<string>();
  for (const n of graph.nodes) {
    const rep = representative(n, byId, EMPTY);
    if (rep !== n.id) out.add(rep);
    // A site expands into the steps done on it.
    if (n.type === 'Step' && n.cluster && byId.has(n.cluster)) out.add(n.cluster);
  }
  return out;
}

/** The tasks that use a node (a site, account, tool or saved login): a task, or one of its steps, has a `uses` edge to it. A step drawn in a site's cluster uses that site. "What uses this site" is this for a site. */
export function tasksUsing(graph: KgGraph, nodeId: string): string[] {
  const byId = new Map(graph.nodes.map((n) => [n.id, n]));
  const out = new Set<string>();
  const add = (id: string) => {
    const n = byId.get(id);
    if (!n) return;
    if (n.type === 'Procedure') out.add(n.id);
    else if (n.procedure && byId.has(n.procedure)) out.add(n.procedure);
  };
  for (const e of graph.edges) if (e.type === 'uses' && e.to === nodeId) add(e.from);
  for (const n of graph.nodes) if (n.type === 'Step' && n.cluster === nodeId) add(n.id);
  return [...out].sort();
}

/** "Focus on a task": the task, its steps, parameters and outputs, and every node they connect to. */
export function touchedBy(graph: KgGraph, procedureNode: string): Set<string> {
  const base = new Set<string>([procedureNode]);
  for (const n of graph.nodes) if (n.procedure === procedureNode) base.add(n.id);
  const out = new Set(base);
  for (const e of graph.edges) {
    if (base.has(e.from)) out.add(e.to);
    if (base.has(e.to)) out.add(e.from);
  }
  return out;
}

function nameOf(kind: MapKind, label: string, inside: number, unused: boolean, suspended: boolean, health: KgHealth): string {
  const parts = [`${MAP_KIND_LABEL[kind]}: ${label}`];
  if (unused) parts.push('not used by any task yet');
  if (suspended) parts.push('suspended');
  else if (kind === 'task' || kind === 'step') parts.push(health === 'unknown' ? 'no runs yet' : health);
  if (inside > 0) parts.push(`${inside} more inside`);
  return parts.join(', ');
}

function layoutOnce(graph: KgGraph, byId: ReadonlyMap<string, KgViewNode>, expanded: ReadonlySet<string>, kinds: ReadonlySet<MapKind> | null) {
  const rep = new Map<string, string>();
  for (const n of graph.nodes) rep.set(n.id, representative(n, byId, expanded));
  const shown = (id: string) => {
    const n = byId.get(id);
    return !!n && (!kinds || kinds.has(kindOf(n)));
  };
  const inside = new Map<string, number>();
  for (const [id, r] of rep) if (r !== id) inside.set(r, (inside.get(r) ?? 0) + 1);
  const visible = graph.nodes.filter((n) => rep.get(n.id) === n.id && shown(n.id));
  const visibleIds = new Set(visible.map((n) => n.id));
  const edges = new Map<string, { style: MapEdgeStyle; source: string; target: string; from: string; to: string }[]>();
  for (const e of graph.edges) {
    const s = rep.get(e.from);
    const t = rep.get(e.to);
    if (!s || !t || s === t || !visibleIds.has(s) || !visibleIds.has(t)) continue;
    const style: MapEdgeStyle = e.type === 'has' ? 'then' : e.type;
    const key = `${style}|${s}|${t}`;
    const list = edges.get(key) ?? [];
    list.push({ style, source: s, target: t, from: e.from, to: e.to });
    edges.set(key, list);
  }
  return { rep, inside, visible, edges };
}

/** The visible map for the given options. Pure: the same inputs give the same nodes and edges, in the API's order. */
export function buildMap(graph: KgGraph, info: ReadonlyMap<string, MapProcedureInfo> = new Map(), opts: MapOptions = {}): MapResult {
  const limit = opts.limit ?? MAP_NODE_LIMIT;
  const byId = new Map(graph.nodes.map((n) => [n.id, n]));
  const kinds = opts.kinds && opts.kinds.size > 0 ? opts.kinds : null;
  let expanded = opts.expanded ?? EMPTY;
  let pass = layoutOnce(graph, byId, expanded, kinds);
  let overLimit = false;
  if (pass.visible.length > limit && expanded.size > 0) {
    overLimit = true;
    expanded = EMPTY;
    pass = layoutOnce(graph, byId, expanded, kinds);
  }
  const blocked = pass.visible.length > limit;
  const expandable = expandableIds(graph, byId);

  const q = (opts.search ?? '').trim().toLowerCase();
  const matches = new Set<string>();
  if (q) for (const n of graph.nodes) if (n.label.toLowerCase().includes(q)) matches.add(pass.rep.get(n.id) ?? n.id);

  const affected = opts.impactSite && byId.has(opts.impactSite) ? tasksUsing(graph, opts.impactSite) : [];
  let emphasis: Set<string> | null = null;
  let emphasisRaw: Set<string> | null = null;
  if (opts.impactSite && byId.has(opts.impactSite)) {
    emphasisRaw = new Set([opts.impactSite, ...affected]);
  } else if (opts.focus && byId.has(opts.focus)) {
    emphasisRaw = touchedBy(graph, opts.focus);
  }
  if (emphasisRaw) {
    emphasis = new Set();
    for (const id of emphasisRaw) emphasis.add(pass.rep.get(id) ?? id);
  }
  const highlightIds = new Set<string>(opts.impactSite ? affected : []);

  const nodes: MapNode[] = pass.visible.map((n) => {
    const kind = kindOf(n);
    const pid = n.type === 'Procedure' ? procedureIdOf(n.id) : null;
    const pinfo = pid ? (info.get(pid) ?? null) : null;
    const suspended = pinfo?.state === 'suspended';
    const count = pass.inside.get(n.id) ?? 0;
    const isExpanded = expanded.has(n.id);
    const match = q ? matches.has(n.id) : false;
    const dim = (emphasis !== null && !emphasis.has(n.id)) || (q !== '' && !match);
    return {
      id: n.id,
      kind,
      type: n.type,
      label: n.label,
      name: nameOf(kind, pinfo?.taskName ?? n.label, count, n.unused, suspended, n.health),
      health: n.health,
      counts: n.counts,
      unused: n.unused,
      suspended,
      info: pinfo,
      expandable: expandable.has(n.id),
      expanded: isExpanded,
      inside: count,
      dim,
      highlight: highlightIds.has(n.id),
      match,
    };
  });
  const dimmed = new Set(nodes.filter((n) => n.dim).map((n) => n.id));
  const edges: MapEdge[] = [];
  for (const [key, list] of pass.edges) {
    const { style, source, target } = list[0]!;
    const touches = emphasisRaw ? list.some((e) => emphasisRaw!.has(e.from) && emphasisRaw!.has(e.to)) : true;
    edges.push({ id: key, style, source, target, dim: dimmed.has(source) || dimmed.has(target) || !touches, highlight: highlightIds.has(source) || highlightIds.has(target) });
  }
  const tasks = graph.nodes.filter((n) => n.type === 'Procedure').map((n) => ({ id: n.id, label: info.get(procedureIdOf(n.id) ?? '')?.taskName ?? n.label }));
  return { nodes: blocked ? [] : nodes, edges: blocked ? [] : edges, overLimit, blocked, limit, affected, tasks };
}

/** Toggles one id in a set of expanded nodes (a new set). */
export function toggle(set: ReadonlySet<string>, id: string): Set<string> {
  const next = new Set(set);
  if (next.has(id)) next.delete(id);
  else next.add(id);
  return next;
}
