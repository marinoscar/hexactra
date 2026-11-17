// The week's runs as a stacked bar per day (#430). Loaded lazily by
// `ThisWeekBlock`: `@mui/x-charts` stays out of the entry bundle.
import { useTheme } from '@mui/material';
import { BarChart } from '@mui/x-charts/BarChart';

import type { HomeWeekDay } from '../../types/home';

/** "Mon 16" from a `YYYY-MM-DD` key (the key is already in the profile zone). */
export function dayLabel(date: string): string {
  const d = new Date(`${date}T12:00:00Z`);
  if (Number.isNaN(d.getTime())) return date;
  return new Intl.DateTimeFormat('en-US', { weekday: 'short', day: 'numeric', timeZone: 'UTC' }).format(d);
}

export default function HomeWeekChart({ series }: { series: HomeWeekDay[] }) {
  const theme = useTheme();
  const reduced = typeof window !== 'undefined' && typeof window.matchMedia === 'function' && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  return (
    <BarChart
      height={160}
      skipAnimation={reduced}
      margin={{ top: 8, right: 8, bottom: 0, left: 0 }}
      xAxis={[{ scaleType: 'band', data: series.map((d) => dayLabel(d.date)), tickLabelStyle: { fontSize: 11 } }]}
      yAxis={[{ tickMinStep: 1, width: 28, tickLabelStyle: { fontSize: 11 } }]}
      series={[
        { data: series.map((d) => d.succeeded), label: 'Succeeded', stack: 'runs', color: theme.palette.success.main },
        { data: series.map((d) => d.failed), label: 'Failed', stack: 'runs', color: theme.palette.error.main },
        { data: series.map((d) => d.cancelled), label: 'Cancelled', stack: 'runs', color: theme.palette.text.disabled },
      ]}
      hideLegend
      grid={{ horizontal: true }}
    />
  );
}
