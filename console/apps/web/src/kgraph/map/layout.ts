// The Map's automatic layout (E46.21, #795): dagre, left to right. The only graph computation the client does.
import { graphlib, layout } from '@dagrejs/dagre';

import type { MapEdge, MapNode } from './mapModel';

export const NODE_WIDTH = 220;
export const NODE_HEIGHT = 64;

/** The top-left position of every node. Unused capabilities with no edge end up in their own rank, at the right. */
export function layoutMap(nodes: readonly MapNode[], edges: readonly MapEdge[]): Map<string, { x: number; y: number }> {
  const g = new graphlib.Graph();
  g.setGraph({ rankdir: 'LR', nodesep: 24, ranksep: 72, marginx: 16, marginy: 16 });
  g.setDefaultEdgeLabel(() => ({}));
  for (const n of nodes) g.setNode(n.id, { width: NODE_WIDTH, height: NODE_HEIGHT });
  for (const e of edges) g.setEdge(e.source, e.target);
  layout(g);
  const out = new Map<string, { x: number; y: number }>();
  for (const n of nodes) {
    const p = g.node(n.id) as { x: number; y: number } | undefined;
    out.set(n.id, { x: (p?.x ?? 0) - NODE_WIDTH / 2, y: (p?.y ?? 0) - NODE_HEIGHT / 2 });
  }
  return out;
}
