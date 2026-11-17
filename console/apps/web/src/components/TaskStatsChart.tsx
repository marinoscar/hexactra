import { Box } from '@mui/material';
import { useTheme } from '@mui/material/styles';
import { BarChart } from '@mui/x-charts/BarChart';

import { dayLabel } from './taskDetail';
import type { TaskStats } from '../types/tasks';

export interface TaskStatsChartProps {
  /** The days to draw, oldest first. */
  days: TaskStats['series'];
  /** The id of the table that holds the same numbers as text. */
  describedBy: string;
}

/** Each bar gets at least this much width; a longer period scrolls inside the chart's own box. */
const MIN_BAR_PX = 14;

/**
 * The task's runs per day, stacked by outcome (#428). Colours are the theme's
 * (success, error, a neutral grey for cancelled) and the legend names them, so
 * colour is not the only signal; the numbers are in the table `describedBy`
 * names. Loaded lazily: the chart library stays out of the list pages' bundle.
 */
export default function TaskStatsChart({ days, describedBy }: TaskStatsChartProps) {
  const theme = useTheme();
  const minWidth = Math.max(280, days.length * MIN_BAR_PX + 64);
  return (
    // The chart scrolls inside this box, never the page.
    <Box role="img" aria-label={`Runs per day, last ${days.length} days, by outcome`} aria-describedby={describedBy} data-testid="task-stats-chart" sx={{ overflowX: 'auto', maxWidth: '100%' }}>
      <Box sx={{ minWidth, height: 240 }}>
        <BarChart
          height={240}
          margin={{ top: 8, right: 8, bottom: 8, left: 0 }}
          xAxis={[{ scaleType: 'band', data: days.map((d) => dayLabel(d.date)) }]}
          yAxis={[{ tickMinStep: 1, width: 32 }]}
          series={[
            { data: days.map((d) => d.succeeded), label: 'Succeeded', stack: 'runs', color: theme.palette.success.main },
            { data: days.map((d) => d.failed), label: 'Failed', stack: 'runs', color: theme.palette.error.main },
            { data: days.map((d) => d.cancelled), label: 'Cancelled', stack: 'runs', color: theme.palette.grey[500] },
          ]}
          skipAnimation
        />
      </Box>
    </Box>
  );
}
