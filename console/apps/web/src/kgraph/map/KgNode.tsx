// One node of the Map (E46.21, #795): an icon, the label as text, and a line with its kind, health and what is folded inside.
// Health is a coloured border plus words; an unused capability is faint with a dashed border; a suspended task says so.
import AccountCircleOutlinedIcon from '@mui/icons-material/AccountCircleOutlined';
import AssignmentOutlinedIcon from '@mui/icons-material/AssignmentOutlined';
import BuildOutlinedIcon from '@mui/icons-material/BuildOutlined';
import InputOutlinedIcon from '@mui/icons-material/InputOutlined';
import PasswordIcon from '@mui/icons-material/Password';
import LanguageOutlinedIcon from '@mui/icons-material/LanguageOutlined';
import OutputOutlinedIcon from '@mui/icons-material/OutputOutlined';
import PauseCircleOutlinedIcon from '@mui/icons-material/PauseCircleOutlined';
import RadioButtonCheckedOutlinedIcon from '@mui/icons-material/RadioButtonCheckedOutlined';
import { Box, Typography } from '@mui/material';
import { useTheme, type Theme } from '@mui/material/styles';
import { Handle, Position, type Node, type NodeProps } from '@xyflow/react';
import type { ElementType } from 'react';

import type { KgHealth } from '../api';
import { HEALTH_LABEL } from '../labels';
import { NODE_HEIGHT, NODE_WIDTH } from './layout';
import { MAP_KIND_LABEL, type MapNode } from './mapModel';

export type KgFlowNode = Node<{ node: MapNode }, 'kg'>;

const ICON: Record<MapNode['type'], ElementType> = {
  Procedure: AssignmentOutlinedIcon,
  Site: LanguageOutlinedIcon,
  Account: AccountCircleOutlinedIcon,
  Tool: BuildOutlinedIcon,
  SecretRef: PasswordIcon,
  Step: RadioButtonCheckedOutlinedIcon,
  Parameter: InputOutlinedIcon,
  Output: OutputOutlinedIcon,
};

export function healthColor(theme: Theme, health: KgHealth): string {
  if (health === 'healthy') return theme.palette.success.main;
  if (health === 'degraded') return theme.palette.warning.main;
  if (health === 'failing') return theme.palette.error.main;
  return theme.palette.divider;
}

/** The second line: kind, then health (for a task or step) or "unused", then what is folded inside. */
export function subline(n: MapNode): string {
  const kind = n.type === 'Parameter' ? 'Parameter' : n.type === 'Output' ? 'Output' : MAP_KIND_LABEL[n.kind];
  const parts = [kind];
  if (n.suspended) parts.push('Suspended');
  else if (n.kind === 'task' || n.kind === 'step') parts.push(HEALTH_LABEL[n.health]);
  if (n.counts.repairs > 0) parts.push(`${n.counts.repairs} repair${n.counts.repairs === 1 ? '' : 's'}`);
  if (n.unused) parts.push('Not used yet');
  if (n.inside > 0) parts.push(`+${n.inside} inside`);
  return parts.join(' · ');
}

export function KgNode({ data, selected }: NodeProps<KgFlowNode>) {
  const theme = useTheme();
  const n = data.node;
  const Icon = n.suspended ? PauseCircleOutlinedIcon : ICON[n.type];
  const border = n.highlight ? theme.palette.warning.main : n.suspended ? theme.palette.error.main : healthColor(theme, n.health);
  return (
    <Box
      sx={{
        width: NODE_WIDTH,
        height: NODE_HEIGHT,
        boxSizing: 'border-box',
        display: 'flex',
        alignItems: 'center',
        gap: 1,
        px: 1.25,
        borderRadius: 1.5,
        bgcolor: 'background.paper',
        border: `${n.highlight || selected ? 3 : 2}px ${n.unused ? 'dashed' : 'solid'} ${border}`,
        outline: selected ? `2px solid ${theme.palette.primary.main}` : 'none',
        outlineOffset: 2,
        opacity: n.dim ? 0.2 : n.unused ? 0.55 : 1,
        boxShadow: n.match ? `0 0 0 4px ${theme.palette.info.light}` : 'none',
        cursor: 'pointer',
      }}
    >
      <Handle type="target" position={Position.Left} isConnectable={false} style={{ opacity: 0 }} />
      <Icon aria-hidden fontSize="small" sx={{ color: n.suspended ? 'error.main' : 'text.secondary', flexShrink: 0 }} />
      <Box sx={{ minWidth: 0 }}>
        <Typography variant="body2" noWrap sx={{ fontWeight: n.kind === 'task' ? 600 : 500 }} title={n.label}>
          {n.info?.taskName ?? n.label}
        </Typography>
        <Typography variant="caption" color="text.secondary" noWrap component="p">
          {subline(n)}
        </Typography>
      </Box>
      <Handle type="source" position={Position.Right} isConnectable={false} style={{ opacity: 0 }} />
    </Box>
  );
}

export const NODE_TYPES = { kg: KgNode };
