// The usage chart (#734): cost or tokens per day (or month), one bar per
// period, stacked by the chosen breakdown. Loaded lazily by the Usage & Cost
// page, so `@mui/x-charts` stays out of the entry bundle. The numbers are also
// in the visually hidden table the page names in `describedBy`.
import { Box } from '@mui/material';
import { BarChart } from '@mui/x-charts/BarChart';

import { formatCost } from '../ui';
import { bucketLabel, formatTokens, type UsageMetric, type UsageSeries } from './api';

export interface UsageChartProps {
  buckets: string[];
  granularity: 'day' | 'month';
  series: UsageSeries[];
  metric: UsageMetric;
  /** Stack the series (false draws one bar for the total). */
  stacked: boolean;
  describedBy: string;
  label: string;
  /** One colour per series, in order (the page's legend uses the same). */
  colors: readonly string[];
}

/** Each bar gets at least this much width; a long period scrolls inside the chart's own box. */
const MIN_BAR_PX = 12;
const HEIGHT = 280;

export default function UsageChart({ buckets, granularity, series, metric, stacked, describedBy, label, colors }: UsageChartProps) {
  const reduced = typeof window !== 'undefined' && typeof window.matchMedia === 'function' && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  const minWidth = Math.max(280, buckets.length * MIN_BAR_PX + 72);
  const fmt = (v: number | null) => (v === null ? '' : metric === 'costUsd' ? (formatCost(v) ?? '$0.00') : formatTokens(v, true));
  const drawn = stacked
    ? series
    : [{ key: 'total', label: metric === 'costUsd' ? 'Cost' : 'Tokens', costUsd: buckets.map((_, i) => series.reduce((a, s) => a + (s.costUsd[i] ?? 0), 0)), tokens: buckets.map((_, i) => series.reduce((a, s) => a + (s.tokens[i] ?? 0), 0)), requests: [] }];
  return (
    // The chart scrolls inside this box, never the page.
    <Box role="img" aria-label={label} aria-describedby={describedBy} data-testid="usage-chart" sx={{ overflowX: 'auto', maxWidth: '100%' }}>
      <Box sx={{ minWidth, height: HEIGHT }}>
        <BarChart
          height={HEIGHT}
          margin={{ top: 8, right: 8, bottom: 8, left: 0 }}
          xAxis={[{ scaleType: 'band', data: buckets.map((b) => bucketLabel(b, granularity)), tickLabelStyle: { fontSize: 11 } }]}
          yAxis={[{ width: 56, valueFormatter: (v: number) => fmt(v), tickLabelStyle: { fontSize: 11 } }]}
          series={drawn.map((s, i) => ({ id: s.key, data: s[metric], label: s.label, stack: 'usage', valueFormatter: fmt, color: colors[i % colors.length] }))}
          // The page draws the legend (with each series' total) under the chart.
          hideLegend
          skipAnimation={reduced}
        />
      </Box>
    </Box>
  );
}
