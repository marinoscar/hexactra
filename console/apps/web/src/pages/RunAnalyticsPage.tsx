import { Alert, Box, FormControl, InputLabel, Link, MenuItem, Paper, Select, Skeleton, Stack, ToggleButton, ToggleButtonGroup, Typography } from '@mui/material';
import DownloadOutlinedIcon from '@mui/icons-material/DownloadOutlined';
import InsightsOutlinedIcon from '@mui/icons-material/InsightsOutlined';
import ListAltOutlinedIcon from '@mui/icons-material/ListAltOutlined';
import { usePlatformHost } from '@marinoscar/platform-web/core';
import { Suspense, lazy, useCallback, useEffect, useId, useState, type ReactNode } from 'react';
import { Link as RouterLink } from 'react-router-dom';

import {
  ANALYTICS_RANGES,
  ANALYTICS_RANGE_LABEL,
  BREAKDOWNS,
  BREAKDOWN_LABEL,
  formatCount,
  formatDuration,
  getRunStats,
  keyLabel,
  periodOf,
  runsLink,
  startRunDataset,
  type AnalyticsRange,
  type Breakdown,
  type RunStats,
  type RunStatsScope,
  type StatsGroupRow,
} from '../runAnalytics/api';
import { TREND_SERIES } from '../runAnalytics/RunsTrendChart';
import { EmptyState, ErrorBanner, PageContainer, PageHeader, ResponsiveList, formatCost, useApiAction, type Column } from '../ui';

// The chart library is loaded only when there is something to draw.
const RunsTrendChart = lazy(() => import('../runAnalytics/RunsTrendChart'));

const visuallyHidden = { border: 0, clip: 'rect(0 0 0 0)', height: '1px', margin: '-1px', overflow: 'hidden', padding: 0, position: 'absolute', whiteSpace: 'nowrap', width: '1px' } as const;

const money = (usd: number | null | undefined, known = true) => (usd === null || usd === undefined ? '–' : (formatCost(usd, known) ?? '$0.00'));
const pct = (x: number | null) => (x === null ? '–' : `${Math.round(x * 100)}%`);
const pair = (a: string, b: string) => `${a} / ${b}`;

function Tile({ label, value, detail, testId }: { label: string; value: ReactNode; detail?: ReactNode; testId: string }) {
  return (
    <Paper variant="outlined" data-testid={testId} sx={{ p: 1.5, minWidth: 0, height: '100%' }}>
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
}

export interface RunAnalyticsPageProps {
  /** `me`: the signed-in user's runs (`runs:read`). `all`: everyone's, aggregates only (`run_stats:read_all`). */
  scope: RunStatsScope;
}

/**
 * Runs Analytics (E53.5, #1073): how runs behaved over 7, 30 or 90 days or a year. Tiles (runs, success, p50/p90 of working time,
 * tokens and cost, cost per success), runs per day or week stacked by outcome, and a breakdown by task, policy, stop reason, tier or
 * trigger (and user, for an administrator), each row linking to its runs on your own page. Reads `GET /runs/stats` or
 * `GET /admin/runs/stats`; "Export dataset" starts the run dataset (`POST /exports`).
 */
export function RunAnalyticsPage({ scope }: RunAnalyticsPageProps) {
  const { api } = usePlatformHost();
  const tableId = useId();
  const [range, setRange] = useState<AnalyticsRange>('30d');
  const [breakdown, setBreakdown] = useState<Breakdown>(scope === 'all' ? 'user' : 'task');
  const [trend, setTrend] = useState<RunStats | null>(null);
  const [groups, setGroups] = useState<RunStats | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [attempt, setAttempt] = useState(0);
  const [started, setStarted] = useState(false);
  const exporting = useApiAction('Could not start the dataset');

  useEffect(() => {
    const ctrl = new AbortController();
    setError(null);
    Promise.all([getRunStats(api, { scope, range, groupBy: periodOf(range) }, ctrl.signal), getRunStats(api, { scope, range, groupBy: breakdown }, ctrl.signal)])
      .then(([t, g]) => {
        if (ctrl.signal.aborted) return;
        setTrend(t);
        setGroups(g);
      })
      .catch((e: unknown) => {
        if (!ctrl.signal.aborted) setError(e instanceof Error ? e.message : 'Could not load the statistics');
      });
    return () => ctrl.abort();
  }, [api, scope, range, breakdown, attempt]);

  const retry = useCallback(() => setAttempt((n) => n + 1), []);
  const exportDataset = useCallback(() => {
    void exporting.run('dataset', async () => {
      await startRunDataset(api, range);
      setStarted(true);
    });
  }, [api, exporting, range]);

  const t = trend?.total;
  const empty = t !== undefined && t.runs === 0;
  const title = scope === 'all' ? 'Runs analytics' : 'Run analytics';
  const subtitle =
    scope === 'all'
      ? 'How every user’s runs behaved: counts, success, time, tokens and cost. Aggregates only: no goal, result or step.'
      : 'How your runs behaved: success, steps, working time, tokens and cost, and where they spend the most.';

  const linkOf = (row: StatsGroupRow) => (scope === 'me' ? runsLink(breakdown, row.key, range) : null);
  const name = (row: StatsGroupRow) => {
    const text = keyLabel(breakdown, row);
    const to = linkOf(row);
    return to ? (
      <Link component={RouterLink} to={to} sx={{ overflowWrap: 'anywhere' }}>
        {text}
      </Link>
    ) : (
      <Box component="span" sx={{ overflowWrap: 'anywhere' }}>
        {text}
      </Box>
    );
  };
  const m = (row: StatsGroupRow) => row.metrics;
  const columns: Column<StatsGroupRow>[] = [
    { key: 'name', header: BREAKDOWN_LABEL[breakdown], render: name },
    { key: 'runs', header: 'Runs', align: 'right', render: (r) => r.runs.toLocaleString('en-US') },
    { key: 'ok', header: 'Succeeded', align: 'right', render: (r) => pct(r.successRate) },
    { key: 'steps', header: 'Steps p50 / p90', align: 'right', hideBelow: 'lg', render: (r) => pair(formatCount(m(r).steps?.p50), formatCount(m(r).steps?.p90)) },
    { key: 'time', header: 'Time p50 / p90', align: 'right', hideBelow: 'lg', render: (r) => pair(formatDuration(m(r).workingMs?.p50), formatDuration(m(r).workingMs?.p90)) },
    { key: 'tokens', header: 'Tokens p50 / p90', align: 'right', hideBelow: 'lg', render: (r) => pair(formatCount(m(r).totalTokens?.p50), formatCount(m(r).totalTokens?.p90)) },
    { key: 'cost', header: 'Cost', align: 'right', render: (r) => money(m(r).costUsd?.sum, r.costKnown) },
    { key: 'p90cost', header: 'Cost p90', align: 'right', hideBelow: 'lg', render: (r) => money(m(r).costUsd?.p90, r.costKnown) },
    { key: 'perSuccess', header: 'Per success', align: 'right', render: (r) => money(r.costPerSuccessUsd, r.costKnown) },
  ];

  return (
    <PageContainer width="wide">
      <PageHeader
        title={title}
        subtitle={subtitle}
        primary={scope === 'me' ? { key: 'dataset', label: 'Export dataset', Icon: DownloadOutlinedIcon, onClick: exportDataset, disabled: exporting.busy !== null || empty } : undefined}
        actions={[{ key: 'runs', label: 'All runs', Icon: ListAltOutlinedIcon, to: '/runs', hidden: scope === 'all' }]}
      />
      <ErrorBanner error={exporting.error} onClose={exporting.clearError} />
      {started && (
        <Alert severity="success" onClose={() => setStarted(false)} sx={{ mb: 2 }} data-testid="dataset-started">
          Your run dataset is being made (runs, findings and steps, masked). Download it from{' '}
          <Link component={RouterLink} to="/settings/data-export">
            Export your data
          </Link>{' '}
          when it is ready, or with <code>hexactra runs dataset export</code>.
        </Alert>
      )}

      <Stack direction="row" useFlexGap sx={{ flexWrap: 'wrap', gap: 1.5, alignItems: 'center', mb: 2 }}>
        <ToggleButtonGroup size="small" exclusive value={range} aria-label="Period" onChange={(_, v: AnalyticsRange | null) => v && setRange(v)}>
          {ANALYTICS_RANGES.map((p) => (
            <ToggleButton key={p} value={p} sx={{ minHeight: { xs: 44, md: 'auto' }, px: 1.5 }}>
              {ANALYTICS_RANGE_LABEL[p]}
            </ToggleButton>
          ))}
        </ToggleButtonGroup>
        <FormControl size="small" sx={{ minWidth: 160 }}>
          <InputLabel id={`${tableId}-by`}>Break down by</InputLabel>
          <Select labelId={`${tableId}-by`} label="Break down by" value={breakdown} onChange={(e) => setBreakdown(e.target.value as Breakdown)} inputProps={{ 'data-testid': 'analytics-breakdown' }}>
            {BREAKDOWNS[scope].map((b) => (
              <MenuItem key={b} value={b}>
                {BREAKDOWN_LABEL[b]}
              </MenuItem>
            ))}
          </Select>
        </FormControl>
      </Stack>

      {error && !trend && <ErrorBanner error={`Could not load the statistics: ${error}`} onRetry={retry} />}
      {error && trend && <ErrorBanner error={`Could not refresh the statistics: ${error}`} onRetry={retry} />}
      {!trend && !error && (
        <Box aria-busy="true" data-testid="analytics-loading">
          <Skeleton variant="rounded" height={84} />
          <Skeleton variant="rounded" height={260} sx={{ mt: 2 }} />
        </Box>
      )}

      {trend && t && (
        <Stack spacing={2.5}>
          {empty ? (
            <EmptyState Icon={InsightsOutlinedIcon} title="No runs in this period" body="Runs appear here as they finish: their steps, time, tokens and cost." />
          ) : (
            <>
              <Box sx={{ display: 'grid', gap: 1.5, gridTemplateColumns: { xs: 'repeat(2, minmax(0, 1fr))', sm: 'repeat(auto-fit, minmax(150px, 1fr))' } }}>
                <Tile testId="analytics-runs" label="Runs" value={t.runs.toLocaleString('en-US')} detail={`${t.finished.toLocaleString('en-US')} finished · ${t.live.toLocaleString('en-US')} live`} />
                <Tile testId="analytics-success" label="Succeeded" value={pct(t.successRate)} detail={`${t.byStatus.succeeded.toLocaleString('en-US')} of ${t.finished.toLocaleString('en-US')} finished`} />
                <Tile testId="analytics-time" label="Working time p50 / p90" value={pair(formatDuration(t.metrics.workingMs?.p50), formatDuration(t.metrics.workingMs?.p90))} detail="waiting for you never counts" />
                <Tile testId="analytics-tokens" label="Tokens p50 / p90" value={pair(formatCount(t.metrics.totalTokens?.p50), formatCount(t.metrics.totalTokens?.p90))} detail={`${formatCount(t.metrics.totalTokens?.sum)} in all`} />
                <Tile testId="analytics-cost" label="Cost" value={money(t.metrics.costUsd?.sum, t.costKnown)} detail={`p50 ${money(t.metrics.costUsd?.p50, t.costKnown)} · p90 ${money(t.metrics.costUsd?.p90, t.costKnown)}`} />
                <Tile testId="analytics-per-success" label="Cost per success" value={money(t.costPerSuccessUsd, t.costKnown)} detail="all finished runs’ cost ÷ successes" />
              </Box>
              {!t.costKnown && <Alert severity="warning">A model had no price, so costs are at least what is shown.</Alert>}
              {trend.truncated && <Alert severity="info">Only the newest {trend.scanned.toLocaleString('en-US')} runs were counted: choose a shorter period for exact numbers.</Alert>}

              <Paper variant="outlined" sx={{ p: { xs: 1.5, sm: 2 }, minWidth: 0 }}>
                <Typography variant="h6" component="h2" sx={{ mb: 1 }}>
                  Runs per {periodOf(range)}
                </Typography>
                <Suspense fallback={<Skeleton variant="rounded" height={260} />}>
                  <RunsTrendChart groups={trend.groups} describedBy={tableId} label={`Runs per ${periodOf(range)}, ${ANALYTICS_RANGE_LABEL[range]}, stacked by outcome`} />
                </Suspense>
                <Stack direction="row" useFlexGap sx={{ flexWrap: 'wrap', gap: 1.5, mt: 1 }} aria-label="Legend" data-testid="analytics-legend">
                  {TREND_SERIES.map((s) => (
                    <Typography key={s.key} variant="caption" color="text.secondary">
                      {s.label}: <strong>{(s.key === 'live' ? t.live : t.byStatus[s.key]).toLocaleString('en-US')}</strong>
                    </Typography>
                  ))}
                </Stack>
                <Box sx={visuallyHidden}>
                  <table id={tableId}>
                    <caption>Runs per {periodOf(range)}</caption>
                    <thead>
                      <tr>
                        <th scope="col">Period</th>
                        {TREND_SERIES.map((s) => (
                          <th key={s.key} scope="col">
                            {s.label}
                          </th>
                        ))}
                      </tr>
                    </thead>
                    <tbody>
                      {trend.groups.map((g) => (
                        <tr key={g.key}>
                          <th scope="row">{g.label}</th>
                          {TREND_SERIES.map((s) => (
                            <td key={s.key}>{s.key === 'live' ? g.live : g.byStatus[s.key]}</td>
                          ))}
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </Box>
              </Paper>

              <Box>
                <Typography variant="h6" component="h2" sx={{ mb: 1 }}>
                  By {BREAKDOWN_LABEL[breakdown].toLowerCase()}
                </Typography>
                {groups && (
                  <ResponsiveList
                    aria-label={`Runs by ${BREAKDOWN_LABEL[breakdown].toLowerCase()}`}
                    items={groups.groups}
                    columns={columns}
                    getKey={(r) => r.key}
                    renderCard={(r) => (
                      <Box sx={{ minWidth: 0 }}>
                        <Typography variant="subtitle2">{name(r)}</Typography>
                        <Typography variant="body2" color="text.secondary">
                          {r.runs.toLocaleString('en-US')} runs · {pct(r.successRate)} succeeded · {money(r.metrics.costUsd?.sum, r.costKnown)} · p90 {formatCount(r.metrics.steps?.p90)} steps
                        </Typography>
                      </Box>
                    )}
                  />
                )}
              </Box>
              <Typography variant="caption" color="text.secondary">
                Percentiles and success are over finished runs. Cost is each run’s own, at the prices of the day it ran. Days are in {trend.timeZone}.
              </Typography>
            </>
          )}
        </Stack>
      )}
    </PageContainer>
  );
}

/** `/runs/analytics` (`runs:read`). */
export function MyRunAnalyticsPage() {
  return <RunAnalyticsPage scope="me" />;
}

/** `/admin/runs/analytics` (`run_stats:read_all`). */
export function AdminRunAnalyticsPage() {
  return <RunAnalyticsPage scope="all" />;
}
