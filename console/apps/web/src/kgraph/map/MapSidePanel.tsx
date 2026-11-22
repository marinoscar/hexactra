// The Map's side panel (E46.21, #795): the clicked node's details, the tasks that use it, its pending reviews, and the links to the
// step list and history. Everything the canvas does (expand, focus, what uses this site) is a button here too, so the keyboard reaches it.
import { Box, Button, Chip, Divider, Link, Paper, Stack, Typography } from '@mui/material';
import { Link as RouterLink } from 'react-router-dom';

import type { KgGraph, KgReview } from '../api';
import { everydayUsesText, HealthChip, StateChip } from '../labels';
import { MAP_KIND_LABEL, procedureIdOf, tasksUsing, type MapNode, type MapProcedureInfo } from './mapModel';

const procedurePath = (id: string) => `/kgraph/procedures/${encodeURIComponent(id)}`;
const historyPath = (id: string) => `/kgraph?tab=history&procedure=${encodeURIComponent(id)}`;

export interface MapSidePanelProps {
  node: MapNode | null;
  graph: KgGraph;
  info: ReadonlyMap<string, MapProcedureInfo>;
  reviews: readonly KgReview[];
  focus: string | null;
  impactSite: string | null;
  onToggleExpand: (id: string) => void;
  onFocus: (id: string | null) => void;
  onImpact: (id: string | null) => void;
  onSelect: (id: string) => void;
}

function TaskLinks({ procedureId }: { procedureId: string }) {
  return (
    <Stack direction="row" spacing={1} useFlexGap sx={{ flexWrap: 'wrap' }}>
      <Button size="small" variant="outlined" component={RouterLink} to={procedurePath(procedureId)}>
        Step list
      </Button>
      <Button size="small" variant="outlined" component={RouterLink} to={historyPath(procedureId)}>
        History
      </Button>
    </Stack>
  );
}

export function MapSidePanel({ node, graph, info, reviews, focus, impactSite, onToggleExpand, onFocus, onImpact, onSelect }: MapSidePanelProps) {
  if (!node) {
    return (
      <Paper variant="outlined" component="aside" aria-label="Details" sx={{ p: 2 }}>
        <Typography variant="body2" color="text.secondary">
          Choose a node on the map or in the list to see its details, the tasks that use it and its links.
        </Typography>
      </Paper>
    );
  }
  // A task's own procedure, or the procedure a step, parameter or output belongs to.
  const owner = node.kind === 'task' ? node.id : (graph.nodes.find((n) => n.id === node.id)?.procedure ?? null);
  const pid = owner ? procedureIdOf(owner) : null;
  const pinfo = node.info;
  const pending = pid ? reviews.filter((r) => r.procedureId === pid) : [];
  const users = node.kind === 'task' ? [] : tasksUsing(graph, node.id);
  const taskName = (procNode: string) => info.get(procedureIdOf(procNode) ?? '')?.taskName ?? graph.nodes.find((n) => n.id === procNode)?.label ?? procNode;
  return (
    <Paper variant="outlined" component="aside" aria-label="Details" sx={{ p: 2, minWidth: 0 }}>
      <Stack spacing={1.5}>
        <Box>
          <Typography variant="overline" color="text.secondary">
            {node.type === 'Parameter' || node.type === 'Output' ? node.type : MAP_KIND_LABEL[node.kind]}
          </Typography>
          <Typography variant="subtitle1" component="h2" sx={{ fontWeight: 600, overflowWrap: 'anywhere' }}>
            {pinfo?.taskName ?? node.label}
          </Typography>
          {pinfo && pinfo.taskName !== node.label && (
            <Typography variant="body2" color="text.secondary" sx={{ overflowWrap: 'anywhere' }}>
              Procedure: {node.label}
            </Typography>
          )}
        </Box>
        <Stack direction="row" spacing={1} useFlexGap sx={{ flexWrap: 'wrap' }}>
          {pinfo && <StateChip state={pinfo.state} />}
          {(node.kind === 'task' || node.kind === 'step') && <HealthChip health={node.health} />}
          {node.unused && <Chip size="small" variant="outlined" label="Not used by any task yet" />}
        </Stack>
        {(node.kind === 'task' || node.kind === 'step') && (
          <Typography variant="body2">
            {node.counts.successes} successful, {node.counts.failures} failed, {node.counts.repairs} repaired
          </Typography>
        )}
        {pinfo?.everydayRuns !== undefined && (
          <Typography variant="body2" data-testid="map-everyday-uses">
            {everydayUsesText(pinfo.everydayRuns)}
          </Typography>
        )}
        {node.kind !== 'task' && node.kind !== 'step' && !node.unused && (
          <Typography variant="body2">
            Used {node.counts.uses} time{node.counts.uses === 1 ? '' : 's'} by learned steps
          </Typography>
        )}
        <Stack direction="row" spacing={1} useFlexGap sx={{ flexWrap: 'wrap' }}>
          {node.expandable && (
            <Button size="small" variant="contained" onClick={() => onToggleExpand(node.id)}>
              {node.expanded ? 'Collapse' : node.kind === 'task' ? 'Show its steps' : 'Expand'}
            </Button>
          )}
          {node.kind === 'task' && (
            <Button size="small" variant="outlined" onClick={() => onFocus(focus === node.id ? null : node.id)}>
              {focus === node.id ? 'Stop focusing' : 'Focus on this task'}
            </Button>
          )}
          {node.type === 'Site' && (
            <Button size="small" variant="outlined" onClick={() => onImpact(impactSite === node.id ? null : node.id)}>
              {impactSite === node.id ? 'Stop highlighting' : 'What uses this site'}
            </Button>
          )}
        </Stack>
        {pid && <TaskLinks procedureId={pid} />}
        {pid && (
          <Box>
            <Divider sx={{ mb: 1 }} />
            <Typography variant="subtitle2" component="h3">
              Pending reviews
            </Typography>
            {pending.length === 0 && (
              <Typography variant="body2" color="text.secondary">
                None
              </Typography>
            )}
            {pending.map((r) => (
              <Box key={r.id} sx={{ mt: 0.5 }}>
                {r.changes.map((c, i) => (
                  <Typography key={i} variant="body2" sx={{ overflowWrap: 'anywhere' }}>
                    {c.text}
                  </Typography>
                ))}
              </Box>
            ))}
            {pending.length > 0 && (
              <Link component={RouterLink} to="/kgraph?tab=reviews" variant="body2">
                Answer in Reviews
              </Link>
            )}
          </Box>
        )}
        {node.kind !== 'task' && node.kind !== 'step' && (
          <Box>
            <Divider sx={{ mb: 1 }} />
            <Typography variant="subtitle2" component="h3">
              {node.type === 'Site' ? 'Tasks a change to this site would affect' : 'Tasks that use it'}
            </Typography>
            {users.length === 0 && (
              <Typography variant="body2" color="text.secondary">
                No learned task uses it yet.
              </Typography>
            )}
            <Stack component="ul" spacing={0.5} sx={{ pl: 2, my: 0.5 }}>
              {users.map((u) => (
                <li key={u}>
                  <Link component="button" type="button" variant="body2" onClick={() => onSelect(u)} sx={{ textAlign: 'left', overflowWrap: 'anywhere' }}>
                    {taskName(u)}
                  </Link>
                </li>
              ))}
            </Stack>
          </Box>
        )}
      </Stack>
    </Paper>
  );
}
