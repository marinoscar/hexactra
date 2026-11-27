// Runs Analytics (E53.5, #1073): runs per day (or week), one bar per period stacked by how they ended. Loaded lazily, so
// `@mui/x-charts` stays out of the entry bundle. The numbers are also in the visually hidden table the page names in `describedBy`.
import { BarChart } from '@mui/x-charts/BarChart';

import type { StatsGroupRow } from './api';

export interface RunsTrendChartProps {
  groups: StatsGroupRow[];
  describedBy: string;
  label: string;
  /** One colour per series of `TREND_SERIES`, from the page's theme. The chart imports nothing of MUI but the chart itself: a
   * lazy chunk that imports `Box` or the theme hook moves them into new shared chunks (bundle:compare, #894). */
  colors: Record<(typeof TREND_SERIES)[number]['key'], string>;
}

const MIN_BAR_PX = 12;

/** `Oct 29` for a period's first day (the accessible table keeps the full date). */
export function shortDay(key: string): string {
  const t = Date.parse(`${key}T00:00:00Z`);
  return Number.isNaN(t) ? key : new Date(t).toLocaleDateString('en-US', { month: 'short', day: 'numeric', timeZone: 'UTC' });
}
const HEIGHT = 260;

/** The series drawn, in stack order, with a theme colour each (success, error, the neutral grey, info for live). */
export const TREND_SERIES = [
  { key: 'succeeded', label: 'Succeeded' },
  { key: 'failed', label: 'Failed' },
  { key: 'cancelled', label: 'Stopped' },
  { key: 'live', label: 'Live' },
] as const;

export default function RunsTrendChart({ groups, describedBy, label, colors: color }: RunsTrendChartProps) {
  const reduced = typeof window !== 'undefined' && typeof window.matchMedia === 'function' && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  const value = (g: StatsGroupRow, key: (typeof TREND_SERIES)[number]['key']) => (key === 'live' ? g.live : g.byStatus[key]);
  return (
    <div role="img" aria-label={label} aria-describedby={describedBy} data-testid="runs-trend-chart" style={{ overflowX: 'auto', maxWidth: '100%' }}>
      <div style={{ minWidth: Math.max(280, groups.length * MIN_BAR_PX + 72), height: HEIGHT }}>
        <BarChart
          height={HEIGHT}
          margin={{ top: 8, right: 8, bottom: 8, left: 0 }}
          xAxis={[{ scaleType: 'band', data: groups.map((g) => shortDay(g.key)), tickLabelStyle: { fontSize: 11 } }]}
          yAxis={[{ width: 44, tickLabelStyle: { fontSize: 11 } }]}
          series={TREND_SERIES.map((s) => ({ id: s.key, label: s.label, data: groups.map((g) => value(g, s.key)), stack: 'runs', color: color[s.key] }))}
          hideLegend
          skipAnimation={reduced}
        />
      </div>
    </div>
  );
}
