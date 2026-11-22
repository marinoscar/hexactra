import ArrowDownwardIcon from '@mui/icons-material/ArrowDownward';
import ArrowUpwardIcon from '@mui/icons-material/ArrowUpward';
import DragHandleIcon from '@mui/icons-material/DragHandle';
import GraphicEqIcon from '@mui/icons-material/GraphicEq';
import { Box, Chip, Paper, Stack, Table, TableBody, TableCell, TableContainer, TableHead, TableRow, Typography } from '@mui/material';
import { isPlatformApiError, usePlatformHost } from '@marinoscar/platform-web/core';
import { useEffect, useState, type ReactNode } from 'react';
import { useParams } from 'react-router-dom';

import { compareBenchmarks } from '../benchmarks/api';
import { DELTA_VERDICT_LABEL, METRIC_LABEL, benchmarkPath, deltaText, deltaVerdict, metricValue, ofText, type DeltaVerdict } from '../benchmarks/format';
import { errorText } from '../policies/usePolicyCatalog';
import type { BenchmarkComparison, ComparisonSide, FlippedChallenge, MetricDelta } from '../types/benchmarks';
import { CardSkeleton, EmptyState, ErrorBanner, PageContainer, PageHeader, ResponsiveList, formatDateTime, useBreakpoint, type Column } from '../ui';

/** A delta's reading as a chip: a win or a loss is coloured, a change within noise is labelled and never coloured as either. */
const VERDICT_CHIP: Record<DeltaVerdict, { color: 'success' | 'error' | 'default'; Icon: typeof ArrowUpwardIcon | null; variant: 'filled' | 'outlined' }> = {
  better: { color: 'success', Icon: ArrowUpwardIcon, variant: 'filled' },
  worse: { color: 'error', Icon: ArrowDownwardIcon, variant: 'filled' },
  noise: { color: 'default', Icon: GraphicEqIcon, variant: 'outlined' },
  same: { color: 'default', Icon: DragHandleIcon, variant: 'outlined' },
  none: { color: 'default', Icon: null, variant: 'outlined' },
};

function DeltaChip({ d }: { d: MetricDelta }) {
  const v = deltaVerdict(d);
  const { color, Icon, variant } = VERDICT_CHIP[v];
  return <Chip size="small" color={color} variant={variant} icon={Icon ? <Icon aria-hidden /> : undefined} label={DELTA_VERDICT_LABEL[v]} data-verdict={v} />;
}

function Panel({ title, children }: { title: string; children: ReactNode }) {
  return (
    <Paper variant="outlined" component="section" aria-label={title} sx={{ p: { xs: 1.5, sm: 2 }, minWidth: 0 }}>
      <Typography variant="h6" component="h2" sx={{ mb: 1 }}>
        {title}
      </Typography>
      {children}
    </Paper>
  );
}

function DeltaTable({ label, deltas }: { label: string; deltas: MetricDelta[] }) {
  const { isPhone } = useBreakpoint();
  if (isPhone) {
    return (
      <Stack spacing={1} aria-label={label} role="list">
        {deltas.map((d) => (
          <Box key={d.metric} role="listitem" data-metric={d.metric} sx={{ borderTop: 1, borderColor: 'divider', pt: 1 }}>
            <Stack direction="row" spacing={1} sx={{ justifyContent: 'space-between', alignItems: 'center' }}>
              <Typography variant="body2" sx={{ fontWeight: 600 }}>
                {METRIC_LABEL[d.metric]}
              </Typography>
              <DeltaChip d={d} />
            </Stack>
            <Typography variant="body2" sx={{ fontVariantNumeric: 'tabular-nums' }}>
              {metricValue(d.metric, d.baseline, d.atLeast)} → {metricValue(d.metric, d.current, d.atLeast)} ({deltaText(d)})
            </Typography>
          </Box>
        ))}
      </Stack>
    );
  }
  return (
    <TableContainer sx={{ overflowX: 'auto' }}>
      <Table size="small" aria-label={label}>
        <TableHead>
          <TableRow>
            {['Metric', 'Baseline', 'This benchmark', 'Change', 'Reading'].map((h) => (
              <TableCell key={h} component="th" scope="col">
                {h}
              </TableCell>
            ))}
          </TableRow>
        </TableHead>
        <TableBody>
          {deltas.map((d) => (
            <TableRow key={d.metric} data-metric={d.metric}>
              <TableCell component="th" scope="row">
                {METRIC_LABEL[d.metric]}
              </TableCell>
              <TableCell sx={{ fontVariantNumeric: 'tabular-nums' }}>{metricValue(d.metric, d.baseline, d.atLeast)}</TableCell>
              <TableCell sx={{ fontVariantNumeric: 'tabular-nums' }}>{metricValue(d.metric, d.current, d.atLeast)}</TableCell>
              <TableCell sx={{ fontVariantNumeric: 'tabular-nums' }}>{deltaText(d)}</TableCell>
              <TableCell>
                <DeltaChip d={d} />
              </TableCell>
            </TableRow>
          ))}
        </TableBody>
      </Table>
    </TableContainer>
  );
}

function SideCard({ title, side }: { title: string; side: ComparisonSide }) {
  return (
    <Paper variant="outlined" sx={{ p: 1.5, minWidth: 0 }} data-testid={`side-${title.toLowerCase().replace(/\s+/g, '-')}`}>
      <Typography variant="caption" color="text.secondary" component="div">
        {title}
      </Typography>
      <Typography variant="subtitle1" sx={{ overflowWrap: 'anywhere' }}>
        {side.name}
      </Typography>
      <Typography variant="body2" sx={{ overflowWrap: 'anywhere' }}>
        Console {side.appVersion} · commit {side.commit ? side.commit.slice(0, 12) : 'n/a (development build)'}
      </Typography>
      <Typography variant="caption" color="text.secondary">
        Suite {side.suiteKey} v{side.suiteVersion} · {side.status} · ended {formatDateTime(side.finishedAt)}
      </Typography>
    </Paper>
  );
}

const outcomeText = (o: FlippedChallenge['current']) => `${o.outcome} (${ofText(o.passes, o.judged)})`;

/** `/admin/settings/benchmarks/:id/compare/:baseline` (#743): what changed against a baseline on the same suite version. */
export function BenchmarkComparePage() {
  const { id = '', baseline = '' } = useParams();
  const { api } = usePlatformHost();
  const [cmp, setCmp] = useState<BenchmarkComparison | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    setCmp(null);
    setError(null);
    compareBenchmarks(api, id, baseline).then(setCmp, (e) => {
      if (isPlatformApiError(e) && e.status === 409) setError(e.message || 'The two benchmarks are on different suite versions and cannot be compared.');
      else setError(errorText(e, 'Could not compare the benchmarks'));
    });
  }, [api, id, baseline]);

  const flippedColumns: Column<FlippedChallenge>[] = [
    { key: 'challenge', header: 'Challenge', grow: true, render: (f) => <Box sx={{ overflowWrap: 'anywhere' }}>{f.title}</Box> },
    { key: 'policy', header: 'Policy', render: (f) => f.policyLabel },
    { key: 'baseline', header: 'Baseline', render: (f) => outcomeText(f.baseline) },
    { key: 'current', header: 'Now', render: (f) => outcomeText(f.current) },
    {
      key: 'direction',
      header: 'Direction',
      render: (f) => <Chip size="small" color={f.direction === 'better' ? 'success' : 'error'} icon={f.direction === 'better' ? <ArrowUpwardIcon aria-hidden /> : <ArrowDownwardIcon aria-hidden />} label={f.direction} />,
    },
  ];

  return (
    <PageContainer width="wide">
      <PageHeader title="Compare benchmarks" subtitle="Deltas whose 95% intervals overlap are labelled within noise, never a win or a loss." back={{ to: benchmarkPath(id), label: 'Benchmark' }} />
      <Stack spacing={2}>
        <ErrorBanner error={error} />
        {!cmp && !error && <CardSkeleton />}
        {cmp && (
          <>
            <Box sx={{ display: 'grid', gap: 1.5, gridTemplateColumns: { xs: 'minmax(0, 1fr)', sm: 'repeat(2, minmax(0, 1fr))' } }}>
              <SideCard title="Baseline" side={cmp.baseline} />
              <SideCard title="This benchmark" side={cmp.current} />
            </Box>
            <Panel title="Whole benchmark">
              <DeltaTable label="Whole benchmark deltas" deltas={cmp.totals} />
            </Panel>
            {cmp.policies.map((p) => (
              <Panel key={p.ref} title={p.label === p.baselineLabel ? p.label : `${p.label} (baseline: ${p.baselineLabel})`}>
                <Typography variant="caption" color="text.secondary" component="div" sx={{ mb: 1 }}>
                  Matched by {p.matchedBy}
                </Typography>
                <DeltaTable label={`Deltas for ${p.label}`} deltas={p.deltas} />
              </Panel>
            ))}
            {(cmp.unmatched.current.length > 0 || cmp.unmatched.baseline.length > 0) && (
              <Panel title="Not matched">
                {cmp.unmatched.current.length > 0 && <Typography variant="body2">Only in this benchmark: {cmp.unmatched.current.map((p) => p.label).join(', ')}</Typography>}
                {cmp.unmatched.baseline.length > 0 && <Typography variant="body2">Only in the baseline: {cmp.unmatched.baseline.map((p) => p.label).join(', ')}</Typography>}
              </Panel>
            )}
            <Panel title="Flipped challenges">
              {cmp.flipped.length === 0 ? (
                <EmptyState title="No challenge changed outcome" body="Every matched challenge passed, failed or was mixed in both benchmarks alike." />
              ) : (
                <ResponsiveList
                  aria-label="Flipped challenges"
                  items={cmp.flipped}
                  columns={flippedColumns}
                  getKey={(f) => `${f.challengeId}:${f.policyRef}`}
                  renderCard={(f) => (
                    <Paper variant="outlined" sx={{ p: 1.5 }}>
                      <Stack direction="row" spacing={1} sx={{ justifyContent: 'space-between', alignItems: 'flex-start' }}>
                        <Typography variant="subtitle2" sx={{ overflowWrap: 'anywhere', minWidth: 0 }}>
                          {f.title}
                        </Typography>
                        {flippedColumns[4]!.render(f)}
                      </Stack>
                      <Typography variant="body2">{f.policyLabel}</Typography>
                      <Typography variant="body2">
                        {outcomeText(f.baseline)} → {outcomeText(f.current)}
                      </Typography>
                    </Paper>
                  )}
                />
              )}
            </Panel>
          </>
        )}
      </Stack>
    </PageContainer>
  );
}
