import { Box, Button, Link, Paper, Skeleton, Stack, ToggleButton, ToggleButtonGroup, Tooltip, Typography } from '@mui/material';
import { Suspense, lazy, useCallback, useEffect, useId, useState, type ReactNode } from 'react';
import { Link as RouterLink } from 'react-router-dom';
import { usePlatformHost } from '@marinoscar/platform-web/core';

import {
  CHART_DAYS_ON_PHONE,
  DEFAULT_STATS_PERIOD,
  STATS_PERIODS,
  chartDays,
  dayLabel,
  durationWords,
  getTaskStats,
  statsSpend,
  stoppedWords,
  successRate,
  type StatsPeriod,
} from './taskDetail';
import { taskPaths } from './taskList';
import type { TaskStats as TaskStatsData, TaskSummary } from '../types/tasks';
import { RelativeTime, StatusChip, useBreakpoint } from '../ui';

/** Off screen, still read by assistive technology. */
const visuallyHidden = { border: 0, clip: 'rect(0 0 0 0)', height: '1px', margin: '-1px', overflow: 'hidden', padding: 0, position: 'absolute', whiteSpace: 'nowrap', width: '1px' } as const;

// The chart library is loaded only when a task page shows statistics.
const TaskStatsChart = lazy(() => import('./TaskStatsChart'));

export interface TaskStatsProps {
  taskId: string;
  /** The task's newest run (the summary's): the Last run tile. */
  lastRun: TaskSummary['lastRun'];
  /** Why that run stopped, when the page knows it. */
  lastStopReason?: string | null;
  /** Changes when the statistics should be read again (a run finished). */
  refreshKey?: string;
}

function Tile({ label, value, detail, title, testId }: { label: string; value: ReactNode; detail?: ReactNode; title?: string; testId: string }) {
  const body = (
    <Paper variant="outlined" data-testid={testId} sx={{ p: 1.5, minWidth: 0, height: '100%' }} tabIndex={title ? 0 : undefined}>
      <Typography variant="caption" color="text.secondary" component="div">
        {label}
      </Typography>
      <Typography variant="h6" component="div" sx={{ fontVariantNumeric: 'tabular-nums', lineHeight: 1.3, overflowWrap: 'anywhere' }}>
        {value}
      </Typography>
      {detail && (
        <Typography variant="caption" color="text.secondary" component="div" sx={{ overflowWrap: 'anywhere' }}>
          {detail}
        </Typography>
      )}
    </Paper>
  );
  return title ? <Tooltip title={title}>{body}</Tooltip> : body;
}

/**
 * How a task's runs have gone (#428): success rate, runs, average duration,
 * spend and the last run as tiles, then the runs per day as a stacked bar
 * chart with the same numbers in a visually hidden table. The period is 7, 30
 * or 90 days (`GET /tasks/:id/stats?days=`). A failed load leaves a one-line
 * "Could not load statistics · Retry"; the rest of the page does not depend on it.
 */
export function TaskStats({ taskId, lastRun, lastStopReason, refreshKey }: TaskStatsProps) {
  const { api } = usePlatformHost();
  const { isPhone } = useBreakpoint();
  const tableId = useId();
  const [days, setDays] = useState<StatsPeriod>(DEFAULT_STATS_PERIOD);
  const [stats, setStats] = useState<TaskStatsData | null>(null);
  const [failed, setFailed] = useState(false);
  const [attempt, setAttempt] = useState(0);

  useEffect(() => {
    let stale = false;
    getTaskStats(api, taskId, days)
      .then((next) => {
        if (stale) return;
        setStats(next);
        setFailed(false);
      })
      .catch(() => {
        if (!stale) setFailed(true);
      });
    return () => {
      stale = true;
    };
  }, [api, taskId, days, refreshKey, attempt]);
  const retry = useCallback(() => {
    setFailed(false);
    setAttempt((n) => n + 1);
  }, []);

  const heading = (
    <Stack direction="row" useFlexGap sx={{ alignItems: 'center', justifyContent: 'space-between', flexWrap: 'wrap', gap: 1, mb: 1.5 }}>
      <Typography variant="h6" component="h2">
        Statistics
      </Typography>
      <ToggleButtonGroup
        size="small"
        exclusive
        value={days}
        aria-label="Period"
        onChange={(_, next: StatsPeriod | null) => {
          if (next) setDays(next);
        }}
      >
        {STATS_PERIODS.map((p) => (
          <ToggleButton key={p} value={p} aria-label={`${p} days`} sx={{ minHeight: { xs: 44, md: 'auto' }, px: 1.5 }}>
            {p} d
          </ToggleButton>
        ))}
      </ToggleButtonGroup>
    </Stack>
  );

  // While another period loads, the previous one's numbers stay on screen.
  const shown = failed ? null : stats;
  if (failed) {
    return (
      <Box component="section" aria-label="Statistics">
        {heading}
        <Typography variant="body2" color="text.secondary" role="status">
          Could not load statistics ·{' '}
          <Button size="small" onClick={retry} sx={{ minHeight: { xs: 44, md: 'auto' }, verticalAlign: 'baseline' }}>
            Retry
          </Button>
        </Typography>
      </Box>
    );
  }
  if (!shown) {
    return (
      <Box component="section" aria-label="Statistics" aria-busy="true">
        {heading}
        <Skeleton variant="rounded" height={84} />
        <Skeleton variant="rounded" height={240} sx={{ mt: 2 }} />
      </Box>
    );
  }

  const rate = successRate(shown.totals);
  const spend = statsSpend(shown);
  const stopped = lastRun ? stoppedWords(lastStopReason) : null;
  const period = `last ${shown.days} days`;
  const drawn = chartDays(shown.series, isPhone ? CHART_DAYS_ON_PHONE : undefined);
  const noRuns = shown.totals.runs === 0;

  return (
    <Box component="section" aria-label="Statistics">
      {heading}
      {/* Two tiles per row on a phone, then as many as fit. */}
      <Box sx={{ display: 'grid', gap: 1.5, gridTemplateColumns: { xs: 'repeat(2, minmax(0, 1fr))', sm: 'repeat(auto-fit, minmax(132px, 1fr))' } }}>
        <Tile testId="stat-success" label="Success rate" value={rate.value} detail={rate.detail} />
        <Tile testId="stat-runs" label="Runs" value={shown.totals.runs.toLocaleString('en-US')} detail={period} />
        <Tile
          testId="stat-duration"
          label="Average duration"
          value={shown.avgDurationSeconds === null ? 'n/a' : durationWords(shown.avgDurationSeconds)}
          detail={shown.avgSteps === null ? undefined : `${Math.round(shown.avgSteps)} steps on average`}
          title={shown.p95DurationSeconds === null ? undefined : `95 % of runs finish within ${durationWords(shown.p95DurationSeconds)}`}
        />
        {spend && <Tile testId="stat-spend" label="Spend" value={spend.value} detail={spend.detail ?? period} />}
        <Tile
          testId="stat-last-run"
          label="Last run"
          value={
            lastRun ? (
              <Link component={RouterLink} to={taskPaths.run(lastRun.id)} underline="none" color="inherit" aria-label={`Last run: ${lastRun.status}`} sx={{ display: 'inline-flex', minHeight: { xs: 32, md: 'auto' }, alignItems: 'center' }}>
                <StatusChip status={lastRun.status} />
              </Link>
            ) : (
              'Never run'
            )
          }
          detail={
            lastRun ? (
              <>
                <RelativeTime iso={lastRun.finishedAt ?? lastRun.createdAt} />
                {stopped && (
                  <Box component="span" sx={{ display: 'block', color: 'warning.main', fontWeight: 500 }}>
                    {stopped}
                  </Box>
                )}
              </>
            ) : undefined
          }
        />
      </Box>

      <Box sx={{ mt: 2, minWidth: 0 }}>
        {noRuns ? (
          <Typography variant="body2" color="text.secondary">
            No runs in the {period}.
          </Typography>
        ) : (
          <Suspense fallback={<Skeleton variant="rounded" height={240} />}>
            <TaskStatsChart days={drawn} describedBy={tableId} />
          </Suspense>
        )}
        {/* The chart as text: one row per day of the period. */}
        <Box component="table" id={tableId} sx={visuallyHidden}>
          <caption>
            Runs per day, {period} ({shown.timezone})
          </caption>
          <thead>
            <tr>
              <th scope="col">Day</th>
              <th scope="col">Succeeded</th>
              <th scope="col">Failed</th>
              <th scope="col">Cancelled</th>
            </tr>
          </thead>
          <tbody>
            {shown.series.map((d) => (
              <tr key={d.date}>
                <th scope="row">{dayLabel(d.date)}</th>
                <td>{d.succeeded}</td>
                <td>{d.failed}</td>
                <td>{d.cancelled}</td>
              </tr>
            ))}
          </tbody>
        </Box>
      </Box>
    </Box>
  );
}
