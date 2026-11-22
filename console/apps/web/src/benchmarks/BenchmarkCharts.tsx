// The scorecard's two charts (E44.5, #743), loaded lazily so `@mui/x-charts` stays out of the
// list pages' bundle (pattern `components/TaskStatsChart.tsx`). Each chart is an image with an
// accessible name, described by the table of the same numbers the page draws beside it; the
// legend names every policy, so colour is not the only signal.
import { Box } from '@mui/material';
import { BarChart } from '@mui/x-charts/BarChart';
import { ScatterChart } from '@mui/x-charts/ScatterChart';

import type { Scorecard } from '../types/benchmarks';
import { money, pct } from './format';

const HEIGHT = 260;
/** Each category group gets at least this much width; more scroll inside the chart's own box. */
const MIN_GROUP_PX = 64;

export interface ChartProps {
  scorecard: Scorecard;
  /** The id of the table that holds the same numbers as text. */
  describedBy: string;
  colors: readonly string[];
}

/** Success rate per category, one bar per policy. */
export function CategoryChart({ scorecard, describedBy, colors }: ChartProps) {
  const cats = scorecard.categories;
  const minWidth = Math.max(280, cats.length * Math.max(MIN_GROUP_PX, scorecard.policies.length * 18) + 56);
  return (
    <Box role="img" aria-label="Success rate per category, one bar per policy" aria-describedby={describedBy} data-testid="benchmark-category-chart" sx={{ overflowX: 'auto', maxWidth: '100%' }}>
      <Box sx={{ minWidth, height: HEIGHT }}>
        <BarChart
          height={HEIGHT}
          margin={{ top: 8, right: 8, bottom: 8, left: 0 }}
          xAxis={[{ scaleType: 'band', data: cats.map((c) => c.label), height: 28, tickLabelInterval: () => true, tickLabelStyle: { fontSize: 11 } }]}
          yAxis={[{ min: 0, max: 1, width: 44, valueFormatter: (v: number) => pct(v), tickLabelStyle: { fontSize: 11 } }]}
          series={scorecard.policies.map((p, i) => ({
            id: p.ref,
            label: p.label,
            color: colors[i % colors.length],
            data: cats.map((c) => p.categories.find((x) => x.category === c.id)?.metrics.successRate.value ?? null),
            valueFormatter: (v: number | null) => (v === null ? 'n/a' : pct(v)),
          }))}
          // The page draws the legend under the chart.
          hideLegend
          skipAnimation
        />
      </Box>
    </Box>
  );
}

/** Success rate against cost per success, one point per policy (a policy with no success has no cost per success and is not drawn). */
export function SuccessCostChart({ scorecard, describedBy, colors }: ChartProps) {
  return (
    <Box role="img" aria-label="Success rate against cost per success, one point per policy" aria-describedby={describedBy} data-testid="benchmark-cost-chart" sx={{ overflowX: 'auto', maxWidth: '100%' }}>
      <Box sx={{ minWidth: 280, height: HEIGHT }}>
        <ScatterChart
          height={HEIGHT}
          margin={{ top: 8, right: 16, bottom: 8, left: 0 }}
          xAxis={[{ label: 'Cost per success', height: 48, tickNumber: 5, valueFormatter: (v: number) => money(v), tickLabelStyle: { fontSize: 11 } }]}
          yAxis={[{ min: 0, max: 1, width: 44, valueFormatter: (v: number) => pct(v), tickLabelStyle: { fontSize: 11 } }]}
          series={scorecard.policies.map((p, i) => ({
            id: p.ref,
            label: p.label,
            color: colors[i % colors.length],
            markerSize: 7,
            data:
              p.metrics.cost.perSuccessUsd !== null && p.metrics.successRate.value !== null ? [{ id: p.ref, x: p.metrics.cost.perSuccessUsd, y: p.metrics.successRate.value }] : [],
            valueFormatter: (v: { x: number; y: number } | null) => (v ? `${pct(v.y)} at ${money(v.x, p.metrics.cost.known)} per success` : ''),
          }))}
          // The page draws the legend under the chart.
          hideLegend
          skipAnimation
        />
      </Box>
    </Box>
  );
}
