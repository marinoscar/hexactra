// The Map's canvas (E46.21, #795): its own lazily loaded chunk with React Flow (MIT) and dagre (MIT). It draws the API's view model
// (`GET /api/kgraph/graph`); what is visible (clusters, expansion, filters, focus, "what uses this site", the 500-node limit) comes
// from the pure `mapModel`. Every string is rendered as text. The list under the canvas and the side panel reach every node by keyboard.
import '@xyflow/react/dist/style.css';

import {
  Alert,
  Box,
  Button,
  List,
  ListItemButton,
  ListItemText,
  MenuItem,
  Paper,
  Stack,
  TextField,
  ToggleButton,
  ToggleButtonGroup,
  Typography,
} from '@mui/material';
import { useTheme } from '@mui/material/styles';
import { usePlatformHost } from '@marinoscar/platform-web/core';
import { Background, Controls, MarkerType, MiniMap, ReactFlow, useReactFlow, type Edge } from '@xyflow/react';
import { useCallback, useEffect, useMemo, useState } from 'react';

import { getKgGraph, type KgGraph, type KgProcedureItem, type KgReview } from '../api';
import { EmptyState, ErrorBanner, ListSkeleton, useBreakpoint } from '../../ui';
import { healthColor, NODE_TYPES, subline, type KgFlowNode } from './KgNode';
import { layoutMap, NODE_HEIGHT, NODE_WIDTH } from './layout';
import { edgeColors, MapLegend } from './MapLegend';
import { buildMap, MAP_KIND_LABEL, MAP_KINDS, toggle, type MapKind, type MapNode, type MapProcedureInfo, type MapResult } from './mapModel';
import { MapSidePanel } from './MapSidePanel';

export interface KgraphMapProps {
  procedures: readonly KgProcedureItem[];
  reviews: readonly KgReview[];
}

/** Fits the view when the set of visible nodes changes (an expansion, a filter, another page). */
function FitOnChange({ signature }: { signature: string }) {
  const flow = useReactFlow();
  useEffect(() => {
    const t = setTimeout(() => void flow.fitView({ padding: 0.15, duration: 200 }), 30);
    return () => clearTimeout(t);
  }, [flow, signature]);
  return null;
}

function Canvas({ result, selected, onSelect }: { result: MapResult; selected: string | null; onSelect: (id: string) => void }) {
  const theme = useTheme();
  const colors = edgeColors(theme);
  const minimapColor = (n: MapNode) => (n.health === 'unknown' ? theme.palette.text.disabled : healthColor(theme, n.health));
  const signature = useMemo(() => `${result.nodes.map((n) => n.id).join(',')}|${result.edges.map((e) => e.id).join(',')}`, [result]);
  // The layout depends only on which nodes and edges are visible, not on dimming or selection.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  const positions = useMemo(() => layoutMap(result.nodes, result.edges), [signature]);
  const nodes: KgFlowNode[] = result.nodes.map((n) => ({
    id: n.id,
    type: 'kg',
    position: positions.get(n.id) ?? { x: 0, y: 0 },
    data: { node: n },
    ariaLabel: n.name,
    selected: n.id === selected,
    // A known size lets the minimap and fit work before the nodes are measured.
    width: NODE_WIDTH,
    height: NODE_HEIGHT,
    draggable: false,
    connectable: false,
  }));
  const edges: Edge[] = result.edges.map((e) => {
    const color = e.highlight ? colors.highlight : colors[e.style];
    return {
      id: e.id,
      source: e.source,
      target: e.target,
      focusable: false,
      selectable: false,
      ...(e.style === 'uses' ? {} : { markerEnd: { type: MarkerType.ArrowClosed, color, width: 16, height: 16 } }),
      style: {
        stroke: color,
        strokeWidth: e.highlight ? 3 : e.style === 'uses' ? 1 : 1.75,
        strokeDasharray: e.style === 'feeds' ? '6 4' : undefined,
        opacity: e.dim ? 0.12 : e.style === 'uses' ? 0.6 : 1,
      },
    };
  });
  return (
    <Box sx={{ height: { xs: 520, lg: 620 }, border: 1, borderColor: 'divider', borderRadius: 1, overflow: 'hidden', bgcolor: 'background.default' }}>
      <ReactFlow
        nodes={nodes}
        edges={edges}
        nodeTypes={NODE_TYPES}
        onNodeClick={(_, node) => onSelect(node.id)}
        nodesDraggable={false}
        nodesConnectable={false}
        fitView
        minZoom={0.1}
        maxZoom={2}
        colorMode={theme.palette.mode}
        aria-label="Knowledge Graph map"
      >
        <FitOnChange signature={signature} />
        <Background />
        <Controls showInteractive={false} aria-label="Zoom and fit" />
        <MiniMap pannable zoomable ariaLabel="Overview of the map" nodeColor={(n) => minimapColor((n as KgFlowNode).data.node)} />
      </ReactFlow>
    </Box>
  );
}

/** The keyboard-reachable list of everything on the canvas. */
function NodeList({ result, selected, onSelect }: { result: MapResult; selected: string | null; onSelect: (id: string) => void }) {
  return (
    <Paper variant="outlined" component="section" aria-label="Everything on the map" sx={{ minWidth: 0 }}>
      <Typography variant="subtitle2" component="h2" sx={{ px: 2, pt: 1.5 }}>
        Everything on the map ({result.nodes.length})
      </Typography>
      <List dense aria-label="Nodes on the map" sx={{ maxHeight: 320, overflow: 'auto' }}>
        {result.nodes.map((n) => (
          <ListItemButton key={n.id} selected={n.id === selected} onClick={() => onSelect(n.id)} aria-label={n.name} sx={{ opacity: n.dim ? 0.6 : 1 }}>
            <ListItemText
              primary={n.info?.taskName ?? n.label}
              secondary={subline(n)}
              slotProps={{ primary: { sx: { overflowWrap: 'anywhere', fontWeight: n.highlight || n.match ? 600 : 400 } } }}
            />
          </ListItemButton>
        ))}
      </List>
    </Paper>
  );
}

export default function KgraphMap({ procedures, reviews }: KgraphMapProps) {
  const { api } = usePlatformHost();
  const { isDesktop } = useBreakpoint();
  const [graph, setGraph] = useState<KgGraph | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [cursor, setCursor] = useState<number | undefined>(undefined);
  const [expanded, setExpanded] = useState<ReadonlySet<string>>(new Set());
  const [kinds, setKinds] = useState<MapKind[]>([]);
  const [search, setSearch] = useState('');
  const [focus, setFocus] = useState<string | null>(null);
  const [impactSite, setImpactSite] = useState<string | null>(null);
  const [selected, setSelected] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      setGraph(await getKgGraph(api, cursor));
      setError(null);
    } catch (e) {
      setError(e instanceof Error && e.message ? e.message : 'Could not load the map');
    }
  }, [api, cursor]);
  useEffect(() => {
    void load();
  }, [load]);

  const info = useMemo(() => new Map<string, MapProcedureInfo>(procedures.map((p) => [p.id, { procedureId: p.id, taskId: p.taskId, taskName: p.taskName, state: p.state }])), [procedures]);
  const kindSet = useMemo(() => new Set(kinds), [kinds]);
  const result = useMemo(() => (graph ? buildMap(graph, info, { expanded, kinds: kindSet, search, focus, impactSite }) : null), [graph, info, expanded, kindSet, search, focus, impactSite]);
  const selectedNode = result?.nodes.find((n) => n.id === selected) ?? null;

  const select = (id: string) => setSelected(id);
  const toggleExpand = (id: string) => setExpanded((s) => toggle(s, id));
  const chooseFocus = (id: string | null) => {
    setFocus(id);
    if (id) setImpactSite(null);
  };
  const chooseImpact = (id: string | null) => {
    setImpactSite(id);
    if (id) setFocus(null);
  };
  const clear = () => {
    setExpanded(new Set());
    setKinds([]);
    setSearch('');
    setFocus(null);
    setImpactSite(null);
  };

  if (error && !graph) return <ErrorBanner error={error} onRetry={() => void load()} />;
  if (!graph || !result) return <ListSkeleton />;
  if (graph.nodes.length === 0) {
    return (
      <EmptyState
        title="Nothing on the map yet"
        body="Choose Learn only or Learn and reuse on a saved task. After its next successful run, it shows up here with the sites, accounts and tools it uses."
        action={{ key: 'tasks', label: 'Open your tasks', to: '/tasks' }}
      />
    );
  }

  return (
    <Stack spacing={2}>
      <ErrorBanner error={error} onRetry={() => void load()} />
      <Stack direction="row" useFlexGap spacing={1.5} sx={{ flexWrap: 'wrap', alignItems: 'center' }}>
        <TextField size="small" label="Search the map" value={search} onChange={(e) => setSearch(e.target.value)} sx={{ width: 220 }} />
        <TextField select size="small" label="Focus on a task" value={focus ?? ''} onChange={(e) => chooseFocus(e.target.value || null)} sx={{ width: 240 }}>
          <MenuItem value="">No focus</MenuItem>
          {result.tasks.map((t) => (
            <MenuItem key={t.id} value={t.id}>
              {t.label}
            </MenuItem>
          ))}
        </TextField>
        <Button size="small" onClick={clear}>
          Reset the view
        </Button>
      </Stack>
      <ToggleButtonGroup size="small" value={kinds} onChange={(_, v: MapKind[]) => setKinds(v)} aria-label="Show only these types" sx={{ flexWrap: 'wrap' }}>
        {MAP_KINDS.map((k) => (
          <ToggleButton key={k} value={k} sx={{ textTransform: 'none' }}>
            {MAP_KIND_LABEL[k]}
          </ToggleButton>
        ))}
      </ToggleButtonGroup>
      <MapLegend />
      {graph.collapsed && <Alert severity="info">The graph has more than {graph.nodeLimit.toLocaleString()} nodes, so every task's steps are folded into it.</Alert>}
      {graph.truncated && (
        <Alert
          severity="info"
          action={
            <Stack direction="row" spacing={1}>
              {cursor !== undefined && (
                <Button size="small" onClick={() => setCursor(undefined)}>
                  First page
                </Button>
              )}
              {graph.nextCursor !== null && (
                <Button size="small" onClick={() => setCursor(graph.nextCursor ?? undefined)}>
                  Next tasks
                </Button>
              )}
            </Stack>
          }
        >
          This page shows part of your learned tasks.
        </Alert>
      )}
      {result.overLimit && !result.blocked && <Alert severity="warning">Expanding would show more than {result.limit} nodes, so the map stays clustered. Filter by type, focus on a task or search to narrow it.</Alert>}
      {result.blocked && <Alert severity="warning">More than {result.limit} nodes match, so the map is not drawn. Filter by type, focus on a task or search to narrow it.</Alert>}
      {impactSite && (
        <Alert severity="warning" variant="outlined">
          {result.affected.length === 0 ? 'No learned task uses this site.' : `A change to this site would affect ${result.affected.length} task${result.affected.length === 1 ? '' : 's'}, highlighted on the map.`}
        </Alert>
      )}
      <Box sx={{ display: 'grid', gap: 2, gridTemplateColumns: isDesktop ? 'minmax(0, 1fr) 320px' : 'minmax(0, 1fr)', alignItems: 'start' }}>
        <Stack spacing={2} sx={{ minWidth: 0 }}>
          {!result.blocked && <Canvas result={result} selected={selected} onSelect={select} />}
          {isDesktop && <NodeList result={result} selected={selected} onSelect={select} />}
        </Stack>
        <MapSidePanel
          node={selectedNode}
          graph={graph}
          info={info}
          reviews={reviews}
          focus={focus}
          impactSite={impactSite}
          onToggleExpand={toggleExpand}
          onFocus={chooseFocus}
          onImpact={chooseImpact}
          onSelect={select}
        />
        {!isDesktop && <NodeList result={result} selected={selected} onSelect={select} />}
      </Box>
    </Stack>
  );
}
