// The Map's legend (E46.21, #795): the three edge styles, health colours, a suspended task and an unused capability.
import { Box, Stack, Typography } from '@mui/material';
import { useTheme, type Theme } from '@mui/material/styles';
import type { ReactNode } from 'react';

import { healthColor } from './KgNode';

export function edgeColors(theme: Theme) {
  return { uses: theme.palette.text.disabled, then: theme.palette.text.secondary, feeds: theme.palette.secondary.main, highlight: theme.palette.warning.main };
}

function Line({ color, dashed, faint }: { color: string; dashed?: boolean; faint?: boolean }) {
  return (
    <svg width="28" height="10" aria-hidden focusable="false">
      <line x1="1" y1="5" x2="27" y2="5" stroke={color} strokeWidth={faint ? 1 : 2} strokeDasharray={dashed ? '5 3' : undefined} opacity={faint ? 0.7 : 1} />
    </svg>
  );
}

function Swatch({ color, dashed, faint }: { color: string; dashed?: boolean; faint?: boolean }) {
  return <Box aria-hidden sx={{ width: 16, height: 12, borderRadius: 0.5, border: `2px ${dashed ? 'dashed' : 'solid'} ${color}`, opacity: faint ? 0.55 : 1, flexShrink: 0 }} />;
}

function Item({ mark, label }: { mark: ReactNode; label: string }) {
  return (
    <Stack component="li" direction="row" spacing={0.75} sx={{ alignItems: 'center' }}>
      {mark}
      <Typography variant="caption">{label}</Typography>
    </Stack>
  );
}

export function MapLegend() {
  const theme = useTheme();
  const c = edgeColors(theme);
  return (
    <Box component="section" aria-label="Legend">
      <Stack component="ul" direction="row" useFlexGap spacing={2} sx={{ flexWrap: 'wrap', listStyle: 'none', p: 0, m: 0, rowGap: 0.5 }}>
        <Item mark={<Line color={c.uses} faint />} label="uses" />
        <Item mark={<Line color={c.then} />} label="then" />
        <Item mark={<Line color={c.feeds} dashed />} label="feeds a value" />
        <Item mark={<Swatch color={healthColor(theme, 'healthy')} />} label="Healthy" />
        <Item mark={<Swatch color={healthColor(theme, 'degraded')} />} label="Degraded" />
        <Item mark={<Swatch color={healthColor(theme, 'failing')} />} label="Failing" />
        <Item mark={<Swatch color={theme.palette.error.main} />} label="Suspended (marked with a pause icon)" />
        <Item mark={<Swatch color={theme.palette.text.disabled} dashed faint />} label="Not used by any task yet" />
      </Stack>
    </Box>
  );
}
