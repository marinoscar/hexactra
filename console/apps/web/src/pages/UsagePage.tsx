import { Alert, Box, Button, FormControl, InputLabel, Link, MenuItem, Paper, Select, Skeleton, Stack, ToggleButton, ToggleButtonGroup, Typography } from '@mui/material';
import DownloadOutlinedIcon from '@mui/icons-material/DownloadOutlined';
import InsightsOutlinedIcon from '@mui/icons-material/InsightsOutlined';
import PaidOutlinedIcon from '@mui/icons-material/PaidOutlined';
import { useTheme } from '@mui/material/styles';
import { rainbowSurgePalette } from '@mui/x-charts/colorPalettes';
import { usePlatformHost } from '@marinoscar/platform-web/core';
import { Suspense, lazy, useCallback, useEffect, useId, useState, type ReactNode } from 'react';
import { Link as RouterLink } from 'react-router-dom';

import {
  BREAKDOWN_LABEL,
  USAGE_RANGES,
  USAGE_RANGE_LABEL,
  bucketLabel,
  downloadUsageCsv,
  formatTokens,
  getUsageReport,
  seriesTotals,
  topSeries,
  type UsageBreakdown,
  type UsageMetric,
  type UsageModelLine,
  type UsageRange,
  type UsageReport,
  type UsageScope,
} from '../usage/api';
import { EmptyState, ErrorBanner, PageContainer, PageHeader, ResponsiveList, formatCost, useApiAction, type Column } from '../ui';

// The chart library is loaded only when the page has something to draw.
const UsageChart = lazy(() => import('../usage/UsageChart'));

/** Off screen, still read by assistive technology (on a block box, never on the `<table>` itself). */
const visuallyHidden = { border: 0, clip: 'rect(0 0 0 0)', height: '1px', margin: '-1px', overflow: 'hidden', padding: 0, position: 'absolute', whiteSpace: 'nowrap', width: '1px' } as const;

/** The breakdowns offered: a user's own page has no "User". */
const BREAKDOWNS: Record<UsageScope, UsageBreakdown[]> = {
  me: ['model', 'tokenType', 'feature', 'none'],
  all: ['model', 'tokenType', 'feature', 'user', 'provider', 'none'],
};

/** What the features are called on screen (the registry's ids are the keys). */
const FEATURE_LABEL: Record<string, string> = {
  browser_agent: 'Browser agent',
  chat_orchestrator: 'Chat',
  task_builder: 'Task builder',
  notes_summary: 'Notes summary',
  none: 'No feature',
};

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

const money = (usd: number, known = true) => formatCost(usd, known) ?? '$0.00';
const pct = (x: number) => `${(x * 100).toLocaleString('en-US', { maximumFractionDigits: 1 })}%`;

export interface UsagePageProps {
  /** `me`: the signed-in user's own usage (Settings). `all`: everyone's (Administration, `ai_config:read`). */
  scope: UsageScope;
}

/**
 * AI usage and cost (#734, epic #730): what the signed-in user (or, for an AI
 * administrator, everyone) spent on AI, over 7, 30 or 90 days or a year by
 * month. Cost or tokens, stacked by model, token type, feature (or user), the
 * totals, the cost by token type, a table per model, and a CSV export. Reads
 * `GET /api/usage/report`; the CSV is `GET /api/usage/export.csv`.
 */
export function UsagePage({ scope }: UsagePageProps) {
  const { api, viewer } = usePlatformHost();
  const theme = useTheme();
  const colors = rainbowSurgePalette(theme.palette.mode);
  const tableId = useId();
  const [range, setRange] = useState<UsageRange>('30d');
  const [metric, setMetric] = useState<UsageMetric>('costUsd');
  const [breakdown, setBreakdown] = useState<UsageBreakdown>('model');
  const [report, setReport] = useState<UsageReport | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [attempt, setAttempt] = useState(0);
  const exporting = useApiAction('Could not export the usage');

  useEffect(() => {
    const ctrl = new AbortController();
    setError(null);
    getUsageReport(api, { range, scope, breakdown }, ctrl.signal)
      .then((r) => {
        if (!ctrl.signal.aborted) setReport(r);
      })
      .catch((e: unknown) => {
        if (!ctrl.signal.aborted) setError(e instanceof Error ? e.message : 'Could not load the usage');
      });
    return () => ctrl.abort();
  }, [api, range, scope, breakdown, attempt]);

  const retry = useCallback(() => setAttempt((n) => n + 1), []);
  const exportCsv = useCallback(() => {
    void exporting.run('export', () => downloadUsageCsv(api, { range, scope }));
  }, [api, exporting, range, scope]);

  const canPrice = viewer.hasPermission('system_settings:read');
  const title = scope === 'all' ? 'AI usage & cost' : 'My usage & cost';
  const subtitle =
    scope === 'all'
      ? 'Every user’s AI tokens and what they cost, by day or month. Cost uses the model prices set in Administration.'
      : 'The AI tokens your account used and what they cost, by day or month: runs, chats and the task builder.';

  // The previous range's numbers stay on screen while the next one loads.
  const r = report;
  const shownSeries = r ? (breakdown === 'tokenType' ? r.series : topSeries(r.series, metric)) : [];
  const empty = r !== null && r.totals.requests === 0;
  const totalsBySeries = r ? seriesTotals(shownSeries, metric) : [];
  const colorOf = (key: string) => colors[Math.max(0, shownSeries.findIndex((x) => x.key === key)) % colors.length];
  const cacheRate = r && r.totals.inputTokens > 0 ? r.totals.cachedInputTokens / r.totals.inputTokens : null;

  const columns: Column<UsageModelLine>[] = [
    { key: 'model', header: 'Model', render: (m) => <Box component="span" sx={{ overflowWrap: 'anywhere' }}>{m.model}<Typography component="span" variant="caption" color="text.secondary"> · {m.provider}</Typography></Box> },
    { key: 'requests', header: 'Requests', align: 'right', render: (m) => m.requests.toLocaleString('en-US') },
    { key: 'input', header: 'Input', align: 'right', hideBelow: 'lg', render: (m) => formatTokens(m.inputTokens - m.cachedInputTokens, true) },
    { key: 'cached', header: 'Cached', align: 'right', hideBelow: 'lg', render: (m) => formatTokens(m.cachedInputTokens, true) },
    { key: 'output', header: 'Output', align: 'right', hideBelow: 'lg', render: (m) => formatTokens(m.outputTokens, true) },
    { key: 'tokens', header: 'Tokens', align: 'right', render: (m) => formatTokens(m.tokens, true) },
    { key: 'cost', header: 'Cost', align: 'right', render: (m) => (m.costUsd === null ? <Typography component="span" variant="body2" color="warning.main">No price</Typography> : money(m.costUsd)) },
    { key: 'share', header: 'Share', align: 'right', hideBelow: 'lg', render: (m) => (m.costShare === null ? '–' : pct(m.costShare)) },
  ];

  return (
    <PageContainer width="wide">
      <PageHeader
        title={title}
        subtitle={subtitle}
        primary={{ key: 'export', label: 'Export CSV', Icon: DownloadOutlinedIcon, onClick: exportCsv, disabled: exporting.busy !== null || !r }}
        actions={[{ key: 'prices', label: 'Model prices', Icon: PaidOutlinedIcon, to: '/admin/settings/agent-pricing', hidden: !canPrice }]}
      />
      <ErrorBanner error={exporting.error} onClose={exporting.clearError} />

      {/* Range, metric and stacking: they wrap onto several lines on a phone. */}
      <Stack direction="row" useFlexGap sx={{ flexWrap: 'wrap', gap: 1.5, alignItems: 'center', mb: 2 }}>
        <ToggleButtonGroup size="small" exclusive value={range} aria-label="Period" onChange={(_, v: UsageRange | null) => v && setRange(v)}>
          {USAGE_RANGES.map((p) => (
            <ToggleButton key={p} value={p} sx={{ minHeight: { xs: 44, md: 'auto' }, px: 1.5 }}>
              {USAGE_RANGE_LABEL[p]}
            </ToggleButton>
          ))}
        </ToggleButtonGroup>
        <ToggleButtonGroup size="small" exclusive value={metric} aria-label="Show" onChange={(_, v: UsageMetric | null) => v && setMetric(v)}>
          <ToggleButton value="costUsd" sx={{ minHeight: { xs: 44, md: 'auto' }, px: 1.5 }}>
            Cost
          </ToggleButton>
          <ToggleButton value="tokens" sx={{ minHeight: { xs: 44, md: 'auto' }, px: 1.5 }}>
            Tokens
          </ToggleButton>
        </ToggleButtonGroup>
        <FormControl size="small" sx={{ minWidth: 160 }}>
          <InputLabel id={`${tableId}-stack`}>Stack by</InputLabel>
          <Select labelId={`${tableId}-stack`} label="Stack by" value={breakdown} onChange={(e) => setBreakdown(e.target.value as UsageBreakdown)} inputProps={{ 'data-testid': 'usage-stack-by' }}>
            {BREAKDOWNS[scope].map((b) => (
              <MenuItem key={b} value={b}>
                {BREAKDOWN_LABEL[b]}
              </MenuItem>
            ))}
          </Select>
        </FormControl>
      </Stack>

      {error && !r && <ErrorBanner error={`Could not load the usage: ${error}`} onRetry={retry} />}
      {error && r && <ErrorBanner error={`Could not refresh the usage: ${error}`} onRetry={retry} />}

      {!r && !error && (
        <Box aria-busy="true">
          <Skeleton variant="rounded" height={84} />
          <Skeleton variant="rounded" height={280} sx={{ mt: 2 }} />
        </Box>
      )}

      {r && (
        <Stack spacing={2.5}>
          <Typography variant="body2" color="text.secondary">
            {bucketLabel(r.from, 'day')} – {bucketLabel(r.to, 'day')} ({r.timeZone}){r.pricing.overridesApplied ? ' · priced with your own model prices' : ''}
          </Typography>

          {r.unpricedModels.length > 0 && (
            <Alert severity="warning" data-testid="usage-unpriced">
              {r.unpricedModels.length === 1 ? 'One model has' : `${r.unpricedModels.length} models have`} no price, so the cost is at least what is shown: {r.unpricedModels.join(', ')}.{' '}
              {canPrice ? (
                <Link component={RouterLink} to="/admin/settings/agent-pricing">
                  Set model prices
                </Link>
              ) : (
                'Ask an administrator to set their prices.'
              )}
            </Alert>
          )}

          <Box sx={{ display: 'grid', gap: 1.5, gridTemplateColumns: { xs: 'repeat(2, minmax(0, 1fr))', sm: 'repeat(auto-fit, minmax(150px, 1fr))' } }}>
            <Tile testId="usage-cost" label="Cost" value={money(r.totals.costUsd, r.totals.costKnown)} detail={`${USAGE_RANGE_LABEL[r.range]}`} />
            <Tile
              testId="usage-tokens"
              label="Tokens"
              value={formatTokens(r.totals.tokens, true)}
              detail={`${formatTokens(r.totals.inputTokens, true)} in · ${formatTokens(r.totals.outputTokens, true)} out`}
            />
            <Tile testId="usage-requests" label="Model calls" value={r.totals.requests.toLocaleString('en-US')} detail={r.totals.failed ? `${r.totals.failed.toLocaleString('en-US')} failed` : 'none failed'} />
            <Tile testId="usage-cache" label="Cache hit rate" value={cacheRate === null ? 'n/a' : pct(cacheRate)} detail="of input tokens served from the provider's cache" />
            <Tile
              testId="usage-runs"
              label="Cost per successful run"
              value={r.runs.avgSuccessCostUsd === null ? 'n/a' : money(r.runs.avgSuccessCostUsd)}
              detail={`${r.runs.succeeded.toLocaleString('en-US')} of ${r.runs.count.toLocaleString('en-US')} runs succeeded`}
            />
          </Box>

          {empty ? (
            <EmptyState Icon={InsightsOutlinedIcon} title="No AI usage in this period" body="Runs, chats and the task builder record their model calls here as they happen." />
          ) : (
            <Paper variant="outlined" sx={{ p: { xs: 1.5, sm: 2 }, minWidth: 0 }}>
              <Typography variant="h6" component="h2" sx={{ mb: 1 }}>
                {metric === 'costUsd' ? 'Cost' : 'Tokens'} per {r.granularity === 'month' ? 'month' : 'day'}
                {breakdown !== 'none' ? `, by ${BREAKDOWN_LABEL[breakdown].toLowerCase()}` : ''}
              </Typography>
              <Suspense fallback={<Skeleton variant="rounded" height={280} />}>
                <UsageChart
                  buckets={r.buckets}
                  granularity={r.granularity}
                  series={shownSeries.map((s) => (breakdown === 'feature' ? { ...s, label: FEATURE_LABEL[s.key] ?? s.label } : s))}
                  metric={metric}
                  stacked={breakdown !== 'none'}
                  describedBy={tableId}
                  colors={colors}
                  label={`${metric === 'costUsd' ? 'Cost' : 'Tokens'} per ${r.granularity}, ${USAGE_RANGE_LABEL[r.range]}${breakdown !== 'none' ? `, stacked by ${BREAKDOWN_LABEL[breakdown].toLowerCase()}` : ''}`}
                />
              </Suspense>
              {breakdown !== 'none' && totalsBySeries.length > 0 && (
                <Stack direction="row" useFlexGap sx={{ flexWrap: 'wrap', gap: 1.5, mt: 1 }} data-testid="usage-series-totals" aria-label="Legend">
                  {totalsBySeries.map((s) => (
                    <Typography key={s.key} variant="caption" color="text.secondary" sx={{ display: 'inline-flex', alignItems: 'center', gap: 0.75, minWidth: 0, overflowWrap: 'anywhere' }}>
                      <Box component="span" aria-hidden sx={{ width: 10, height: 10, borderRadius: '2px', flex: '0 0 auto', bgcolor: colorOf(s.key) }} />
                      <span>
                        {breakdown === 'feature' ? (FEATURE_LABEL[s.key] ?? s.label) : s.label}: <strong>{metric === 'costUsd' ? money(s.value) : formatTokens(s.value, true)}</strong>
                      </span>
                    </Typography>
                  ))}
                </Stack>
              )}
              {/* The chart's numbers as a table, for assistive technology. */}
              <Box sx={visuallyHidden}>
                <table id={tableId}>
                  <caption>{metric === 'costUsd' ? 'Cost' : 'Tokens'} per period</caption>
                  <thead>
                    <tr>
                      <th scope="col">Period</th>
                      {shownSeries.map((s) => (
                        <th key={s.key} scope="col">
                          {s.label}
                        </th>
                      ))}
                    </tr>
                  </thead>
                  <tbody>
                    {r.buckets.map((b, i) => (
                      <tr key={b}>
                        <th scope="row">{bucketLabel(b, r.granularity)}</th>
                        {shownSeries.map((s) => (
                          <td key={s.key}>{metric === 'costUsd' ? money(s.costUsd[i] ?? 0) : formatTokens(s.tokens[i] ?? 0)}</td>
                        ))}
                      </tr>
                    ))}
                  </tbody>
                </table>
              </Box>
            </Paper>
          )}

          {!empty && (
            <Paper variant="outlined" sx={{ p: { xs: 1.5, sm: 2 } }} data-testid="usage-token-types">
              <Typography variant="h6" component="h2" sx={{ mb: 1 }}>
                By token type
              </Typography>
              <Box sx={{ display: 'grid', gap: 1.5, gridTemplateColumns: { xs: 'repeat(2, minmax(0, 1fr))', sm: 'repeat(4, minmax(0, 1fr))' } }}>
                {(
                  [
                    ['Input (uncached)', r.totals.inputTokens - r.totals.cachedInputTokens, r.totals.costByTokenType.input],
                    ['Cached input', r.totals.cachedInputTokens, r.totals.costByTokenType.cachedInput],
                    ['Output', r.totals.outputTokens - r.totals.reasoningTokens, r.totals.costByTokenType.output],
                    ['Reasoning', r.totals.reasoningTokens, r.totals.costByTokenType.reasoning],
                  ] as const
                ).map(([label, tokens, cost]) => (
                  <Box key={label} sx={{ minWidth: 0 }}>
                    <Typography variant="caption" color="text.secondary" component="div">
                      {label}
                    </Typography>
                    <Typography variant="body1" sx={{ fontVariantNumeric: 'tabular-nums' }}>
                      {formatTokens(tokens, true)}
                    </Typography>
                    <Typography variant="caption" color="text.secondary">
                      {money(cost)}
                    </Typography>
                  </Box>
                ))}
              </Box>
            </Paper>
          )}

          {!empty && (
            <Box>
              <Typography variant="h6" component="h2" sx={{ mb: 1 }}>
                By model
              </Typography>
              <ResponsiveList
                aria-label="Usage by model"
                items={r.byModel}
                columns={columns}
                getKey={(m) => m.key}
                renderCard={(m) => (
                  <Box sx={{ minWidth: 0 }}>
                    <Typography variant="subtitle2" sx={{ overflowWrap: 'anywhere' }}>
                      {m.model} <Typography component="span" variant="caption" color="text.secondary">· {m.provider}</Typography>
                    </Typography>
                    <Typography variant="body2" color="text.secondary">
                      {m.requests.toLocaleString('en-US')} calls · {formatTokens(m.tokens, true)} tokens · {m.costUsd === null ? 'no price' : money(m.costUsd)}
                      {m.costShare !== null ? ` (${pct(m.costShare)})` : ''}
                    </Typography>
                  </Box>
                )}
              />
            </Box>
          )}

          <Typography variant="caption" color="text.secondary">
            Cost is computed from tokens at the current model prices. A run's own cost, on its page, keeps the prices of the day it ran. Export CSV has one line per {r.granularity}, model and feature
            {scope === 'all' ? ' and user' : ''}.{' '}
            <Button size="small" startIcon={<DownloadOutlinedIcon />} onClick={exportCsv} disabled={exporting.busy !== null} sx={{ verticalAlign: 'baseline' }}>
              Export CSV
            </Button>
          </Typography>
        </Stack>
      )}
    </PageContainer>
  );
}

/** Settings → My usage & cost (`usage:read`). */
export function MyUsagePage() {
  return <UsagePage scope="me" />;
}

/** Administration → AI usage & cost (`ai_config:read`). */
export function AdminUsagePage() {
  return <UsagePage scope="all" />;
}
