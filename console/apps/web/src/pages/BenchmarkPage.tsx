import CompareArrowsIcon from '@mui/icons-material/CompareArrows';
import DeleteOutlineIcon from '@mui/icons-material/DeleteOutlineOutlined';
import StopCircleOutlinedIcon from '@mui/icons-material/StopCircleOutlined';
import { Box, Button, LinearProgress, MenuItem, Paper, Stack, TextField, Typography } from '@mui/material';
import { usePlatformHost } from '@marinoscar/platform-web/core';
import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react';
import { useNavigate, useParams } from 'react-router-dom';

import { cancelBenchmark, deleteBenchmark, getBenchmark, getScorecard, listBenchmarks, listTrials } from '../benchmarks/api';
import { BenchmarkStatusChip } from '../benchmarks/BenchmarkChips';
import { BenchmarkExportButton } from '../components/BenchmarkExportMenu';
import { BENCHMARKS_PATH, comparePath, isLiveBenchmark, money, ofText, tokens } from '../benchmarks/format';
import { ScorecardView } from '../benchmarks/ScorecardView';
import { TrialList } from '../benchmarks/TrialList';
import { errorText } from '../policies/usePolicyCatalog';
import type { Benchmark, BenchmarkTrial, Scorecard } from '../types/benchmarks';
import { CardSkeleton, ErrorBanner, PageContainer, PageHeader, formatDateTime, useConfirm, type PageAction } from '../ui';

/** How often a live benchmark is read again. */
export const POLL_MS = 5_000;

function Tile({ label, value, detail, testId }: { label: string; value: ReactNode; detail?: ReactNode; testId: string }) {
  return (
    <Paper variant="outlined" data-testid={testId} sx={{ p: 1.5, minWidth: 0 }}>
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

/** The totals strip: what the whole benchmark cost and used, and its spend against the cap. */
function TotalsStrip({ b, scorecard }: { b: Benchmark; scorecard: Scorecard | null }) {
  const t = scorecard?.totals;
  const costKnown = t ? t.costKnown : b.totals.costKnown;
  const cost = t ? t.costUsd : b.spentUsd;
  const input = t ? t.inputTokens : b.totals.inputTokens;
  const output = t ? t.outputTokens : b.totals.outputTokens;
  const cached = t ? t.cachedInputTokens : b.totals.cachedInputTokens;
  const share = b.config.capUsd !== null && b.config.capUsd > 0 ? Math.min(1, b.spentUsd / b.config.capUsd) : 0;
  return (
    <Box component="section" aria-label="Totals" sx={{ display: 'grid', gap: 1.5, gridTemplateColumns: { xs: 'repeat(2, minmax(0, 1fr))', md: 'repeat(5, minmax(0, 1fr))' } }}>
      <Tile testId="total-cost" label="Total cost" value={money(cost, costKnown)} detail={costKnown ? `${(t?.modelCalls ?? b.totals.modelCalls).toLocaleString('en-US')} model calls` : 'At least: a model call had no price'} />
      <Tile testId="total-input" label="Input tokens" value={tokens(input)} detail={`${tokens(input, false)} in all`} />
      <Tile testId="total-output" label="Output tokens" value={tokens(output)} detail={`${tokens(output, false)} in all`} />
      <Tile testId="total-cached" label="Cached input tokens" value={tokens(cached)} detail="Part of the input" />
      <Paper variant="outlined" data-testid="spend-cap" sx={{ p: 1.5, minWidth: 0, gridColumn: { xs: '1 / -1', md: 'auto' } }}>
        <Typography variant="caption" color="text.secondary" component="div">
          Spend against the cap
        </Typography>
        <Typography variant="h6" component="div" sx={{ fontVariantNumeric: 'tabular-nums', lineHeight: 1.3 }}>
          {b.config.capUsd === null ? <>{money(b.spentUsd, b.totals.costKnown)} (no cap)</> : <>{money(b.spentUsd, b.totals.costKnown)} of {money(b.config.capUsd)}</>}
        </Typography>
        <LinearProgress variant="determinate" value={share * 100} aria-label={`${Math.round(share * 100)}% of the spend cap`} sx={{ mt: 0.75 }} />
      </Paper>
    </Box>
  );
}

/** `/admin/settings/benchmarks/:id` (#743): watch a benchmark, read its scorecard and trials, cancel it, compare it. */
export function BenchmarkPage() {
  const { id = '' } = useParams();
  const { api, viewer } = usePlatformHost();
  const navigate = useNavigate();
  const confirm = useConfirm();
  const canRun = viewer.hasPermission('benchmarks:run');
  const [b, setB] = useState<Benchmark | null>(null);
  const [trials, setTrials] = useState<BenchmarkTrial[]>([]);
  const [scorecard, setScorecard] = useState<Scorecard | null>(null);
  const [baselines, setBaselines] = useState<Benchmark[]>([]);
  const [baseline, setBaseline] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const load = useCallback(async () => {
    try {
      const [bench, list, card] = await Promise.all([getBenchmark(api, id), listTrials(api, id), getScorecard(api, id)]);
      setB(bench);
      setTrials(list);
      setScorecard(card);
      setError(null);
      return bench;
    } catch (e) {
      setError(errorText(e, 'Could not load the benchmark'));
      return null;
    }
  }, [api, id]);

  // Read it once, then again every few seconds while it is live.
  useEffect(() => {
    let stopped = false;
    const tick = async () => {
      const bench = await load();
      if (!stopped && bench && isLiveBenchmark(bench.status)) timer.current = setTimeout(() => void tick(), POLL_MS);
    };
    void tick();
    return () => {
      stopped = true;
      if (timer.current) clearTimeout(timer.current);
    };
  }, [load]);

  // The earlier benchmarks it can be compared with: the same suite key and version.
  useEffect(() => {
    if (!b) return;
    listBenchmarks(api).then(
      (list) => setBaselines(list.items.filter((x) => x.id !== b.id && x.suiteKey === b.suiteKey && x.suiteVersion === b.suiteVersion && !isLiveBenchmark(x.status))),
      () => setBaselines([]),
    );
  }, [api, b?.id, b?.suiteKey, b?.suiteVersion]); // eslint-disable-line react-hooks/exhaustive-deps

  const doCancel = async () => {
    if (!b) return;
    const ok = await confirm({ title: `Cancel “${b.name}”?`, body: 'Nothing more starts, the trials that have not run are skipped, and the trial that is running is stopped like any run.', confirmLabel: 'Cancel benchmark', cancelLabel: 'Keep running', destructive: true });
    if (!ok) return;
    setBusy(true);
    try {
      setB(await cancelBenchmark(api, b.id));
      await load();
    } catch (e) {
      setError(errorText(e, 'Could not cancel the benchmark'));
    } finally {
      setBusy(false);
    }
  };

  const doDelete = async () => {
    if (!b) return;
    const ok = await confirm({ title: `Delete “${b.name}”?`, body: 'Its trials and scorecard are deleted. The runs it started stay in the run history. This cannot be undone.', confirmLabel: 'Delete', destructive: true });
    if (!ok) return;
    setBusy(true);
    try {
      await deleteBenchmark(api, b.id);
      navigate(BENCHMARKS_PATH);
    } catch (e) {
      setError(errorText(e, 'Could not delete the benchmark'));
      setBusy(false);
    }
  };

  if (!b) {
    return (
      <PageContainer width="wide">
        <PageHeader title="Benchmark" back={{ to: BENCHMARKS_PATH, label: 'Benchmarks' }} />
        <ErrorBanner error={error} onRetry={() => void load()} />
        {!error && <CardSkeleton />}
      </PageContainer>
    );
  }

  const live = isLiveBenchmark(b.status);
  const p = b.progress;
  const ended = p.total - p.pending - p.running;
  const actions: PageAction[] = [
    { key: 'cancel', label: 'Cancel', Icon: StopCircleOutlinedIcon, onClick: () => void doCancel(), color: 'error', hidden: !canRun || !live, disabled: busy },
    { key: 'delete', label: 'Delete', Icon: DeleteOutlineIcon, onClick: () => void doDelete(), color: 'error', hidden: !canRun || live, disabled: busy },
  ];

  return (
    <PageContainer width="wide">
      <PageHeader
        title={b.name}
        back={{ to: BENCHMARKS_PATH, label: 'Benchmarks' }}
        actions={actions}
      >
        <Stack direction="row" spacing={1} useFlexGap sx={{ alignItems: 'center', flexWrap: 'wrap' }}>
          <BenchmarkStatusChip status={b.status} />
          <Typography variant="body2" color="text.secondary" sx={{ overflowWrap: 'anywhere', minWidth: 0 }}>
            Suite {b.suiteKey} v{b.suiteVersion} · console {b.appVersion}
            {b.commit ? ` (${b.commit.slice(0, 7)})` : ''} · {b.config.trials} trials each · started {formatDateTime(b.startedAt ?? b.createdAt)}
          </Typography>
        </Stack>
        {/* The report (E44.6, #744): PDF, CSV of trials, JSON; with the comparison when a baseline is chosen below. */}
        <Stack direction="row" useFlexGap sx={{ flexWrap: 'wrap', gap: 1, mt: 1.5 }} data-testid="benchmark-export">
          <BenchmarkExportButton benchmarkId={b.id} live={isLiveBenchmark(b.status)} baselineId={baseline || null} sx={{ minHeight: 44 }} />
        </Stack>
      </PageHeader>
      <Stack spacing={2}>
        <ErrorBanner error={error} onRetry={() => void load()} />

        <Paper variant="outlined" component="section" aria-label="Progress" sx={{ p: { xs: 1.5, sm: 2 } }} data-testid="benchmark-progress">
          <Typography variant="body1">
            {ofText(ended, p.total)} trials ended{live ? `, ${p.running} running` : ''} · {p.pass} passed · {p.fail} failed · {p.error} error · {p.skipped} skipped · {p.unsupported} unsupported
          </Typography>
          <LinearProgress variant="determinate" value={p.total ? (ended / p.total) * 100 : 0} aria-label={`${ofText(ended, p.total)} trials ended`} sx={{ mt: 1 }} />
        </Paper>

        <TotalsStrip b={b} scorecard={scorecard} />

        {scorecard && <ScorecardView scorecard={scorecard} />}

        <Paper variant="outlined" component="section" aria-label="Compare with" sx={{ p: { xs: 1.5, sm: 2 } }}>
          <Typography variant="h6" component="h2" sx={{ mb: 1 }}>
            Compare with
          </Typography>
          {baselines.length === 0 ? (
            <Typography variant="body2" color="text.secondary">
              No other benchmark on suite {b.suiteKey} v{b.suiteVersion} has ended yet. Two benchmarks compare only on one suite version.
            </Typography>
          ) : (
            <Stack direction={{ xs: 'column', sm: 'row' }} spacing={1.5} sx={{ alignItems: { sm: 'center' } }}>
              <TextField select label="Baseline" value={baseline} onChange={(e) => setBaseline(e.target.value)} sx={{ minWidth: { sm: 320 } }} fullWidth slotProps={{ select: { displayEmpty: true }, inputLabel: { shrink: true } }}>
                <MenuItem value="">Choose a benchmark</MenuItem>
                {baselines.map((x) => (
                  <MenuItem key={x.id} value={x.id}>
                    {x.name} · {formatDateTime(x.startedAt ?? x.createdAt)}
                  </MenuItem>
                ))}
              </TextField>
              <Button variant="outlined" startIcon={<CompareArrowsIcon />} disabled={!baseline} onClick={() => navigate(comparePath(b.id, baseline))} sx={{ minHeight: 44, flexShrink: 0 }}>
                Compare
              </Button>
            </Stack>
          )}
        </Paper>

        <Paper variant="outlined" component="section" aria-label="Trials" sx={{ p: { xs: 1.5, sm: 2 }, minWidth: 0 }}>
          <Typography variant="h6" component="h2" sx={{ mb: 1 }}>
            Trials
          </Typography>
          <TrialList trials={trials} />
        </Paper>
      </Stack>
    </PageContainer>
  );
}
