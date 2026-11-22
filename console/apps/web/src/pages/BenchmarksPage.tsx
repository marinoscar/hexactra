import AddIcon from '@mui/icons-material/Add';
import LeaderboardOutlinedIcon from '@mui/icons-material/LeaderboardOutlined';
import { Alert, Box, Button, Card, CardActionArea, CardContent, Chip, Paper, Stack, Typography } from '@mui/material';
import { usePlatformHost } from '@marinoscar/platform-web/core';
import { useCallback, useEffect, useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';

import { getScorecard, listBenchmarks } from '../benchmarks/api';
import { BenchmarkStatusChip } from '../benchmarks/BenchmarkChips';
import { confirmAndDeleteBenchmarks } from '../benchmarks/DeleteBenchmarks';
import { BENCHMARKS_PATH, benchmarkPath, gradeColor, isLiveBenchmark, money, pct, scoreText } from '../benchmarks/format';
import type { Benchmark, RankingEntry } from '../types/benchmarks';
import { EmptyState, ErrorBanner, ListSkeleton, PageContainer, PageHeader, ResponsiveList, aboveBottomBar, formatDateTime, useConfirm, useProfileTimeZone, type Column, type ListSelection } from '../ui';
import { errorText } from '../policies/usePolicyCatalog';

/** The best policy of each listed benchmark (its scorecard's first ranking entry); absent while loading or when none was judged. */
type Best = Record<string, RankingEntry | null>;

function bestText(best: RankingEntry | null | undefined): string {
  if (best === undefined) return '…';
  if (!best || best.successRate === null) return 'n/a';
  return `${pct(best.successRate)} · ${best.label}`;
}

/** The leader's Benchmark Score and grade (#871), or a dash while loading, when none was rated, or from a console without scores. */
function TopScore({ best }: { best: RankingEntry | null | undefined }) {
  if (best === undefined) return <>…</>;
  if (!best || best.score === null || best.score === undefined || !best.grade) return <>n/a</>;
  return (
    <Stack direction="row" spacing={1} useFlexGap sx={{ alignItems: 'center', flexWrap: 'wrap', whiteSpace: 'normal', minWidth: 0 }} data-testid="top-score">
      <Box component="span" sx={{ fontWeight: 700, fontVariantNumeric: 'tabular-nums' }}>
        {scoreText(best.score)}
      </Box>
      <Chip size="small" label={best.grade} color={gradeColor(best.grade)} sx={{ fontWeight: 700, minWidth: 32 }} />
      <Box component="span" sx={{ overflowWrap: 'anywhere', color: 'text.secondary', minWidth: 0, flexBasis: { xs: 'auto', md: '100%' } }}>
        {best.label}
      </Box>
    </Stack>
  );
}

/** `/admin/settings/benchmarks` (#743): every benchmark of the administrator, newest first. */
export function BenchmarksPage() {
  const { api, viewer } = usePlatformHost();
  const navigate = useNavigate();
  const tz = useProfileTimeZone();
  const canRun = viewer.hasPermission('benchmarks:run');
  const [items, setItems] = useState<Benchmark[] | null>(null);
  const [best, setBest] = useState<Best>({});
  const [error, setError] = useState<string | null>(null);
  // Several benchmarks deleted at once, with or without their runs (#873).
  const confirm = useConfirm();
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());
  const [deleting, setDeleting] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);

  const load = useCallback(async () => {
    setError(null);
    try {
      const list = await listBenchmarks(api);
      setItems(list.items);
      // Each row's best policy, from its scorecard (cached once a benchmark has ended). A failed one reads n/a.
      const entries = await Promise.all(list.items.map(async (b) => [b.id, await getScorecard(api, b.id).then((s) => s.ranking[0] ?? null, () => null)] as const));
      setBest(Object.fromEntries(entries));
    } catch (e) {
      setError(errorText(e, 'Could not load the benchmarks'));
      setItems((prev) => prev ?? []);
    }
  }, [api]);

  useEffect(() => {
    void load();
  }, [load]);

  const ended = useMemo(() => (items ?? []).filter((b) => !isLiveBenchmark(b.status)), [items]);
  const selected = useMemo(() => new Set(ended.filter((b) => selectedIds.has(b.id)).map((b) => b.id)), [ended, selectedIds]);
  const selection: ListSelection | undefined = canRun
    ? {
        selected,
        onToggle: (id) => setSelectedIds((prev) => {
          const next = new Set(prev);
          if (next.has(id)) next.delete(id);
          else next.add(id);
          return next;
        }),
        onToggleAll: () => setSelectedIds(ended.length > 0 && ended.every((b) => selected.has(b.id)) ? new Set() : new Set(ended.map((b) => b.id))),
        disabledReason: (id) => (items?.find((b) => b.id === id && isLiveBenchmark(b.status)) ? 'Still running: cancel it first' : null),
      }
    : undefined;

  const deleteSelected = async () => {
    const chosen = ended.filter((b) => selected.has(b.id)).map((b) => ({ id: b.id, name: b.name }));
    if (!chosen.length) return;
    setDeleting(true);
    try {
      const res = await confirmAndDeleteBenchmarks({ api, confirm, items: chosen, canDeleteRuns: viewer.hasPermission('runs:delete') });
      if (!res) return;
      const n = res.deleted.length;
      const runs = res.runsDeleted > 0 ? ` and ${res.runsDeleted.toLocaleString('en-US')} run${res.runsDeleted === 1 ? '' : 's'}` : '';
      const skipped = res.skippedRunning.length ? `. ${res.skippedRunning.length} still running ${res.skippedRunning.length === 1 ? 'was' : 'were'} skipped` : '';
      setNotice(`Deleted ${n} benchmark${n === 1 ? '' : 's'}${runs}${skipped}.`);
      setSelectedIds(new Set());
      await load();
    } catch (e) {
      setError(errorText(e, 'Could not delete the benchmarks'));
    } finally {
      setDeleting(false);
    }
  };

  const policiesText = (b: Benchmark) => b.config.policies.map((p) => p.label).join(', ');
  const spend = (b: Benchmark) => (b.config.capUsd === null ? `${money(b.spentUsd, b.totals.costKnown)} (no cap)` : `${money(b.spentUsd, b.totals.costKnown)} of ${money(b.config.capUsd)}`);
  const date = (b: Benchmark) => formatDateTime(b.startedAt ?? b.createdAt, { timeZone: tz, dateStyle: 'medium' });

  const columns: Column<Benchmark>[] = [
    { key: 'name', header: 'Name', grow: true, render: (b) => <Box sx={{ overflowWrap: 'anywhere', fontWeight: 500, minWidth: 160 }}>{b.name}</Box> },
    { key: 'status', header: 'Status', render: (b) => <BenchmarkStatusChip status={b.status} /> },
    { key: 'policies', header: 'Policies', render: (b) => <Box sx={{ whiteSpace: 'normal', overflowWrap: 'anywhere', minWidth: 160, maxWidth: 280 }}>{policiesText(b)}</Box> },
    { key: 'score', header: 'Top score', render: (b) => <Box sx={{ minWidth: 140, maxWidth: 260 }}><TopScore best={best[b.id]} /></Box> },
    { key: 'best', header: 'Best success', hideBelow: 'lg', render: (b) => <Box sx={{ whiteSpace: 'normal', overflowWrap: 'anywhere', minWidth: 120, maxWidth: 220 }}>{bestText(best[b.id])}</Box> },
    { key: 'spend', header: 'Spend', align: 'right', render: (b) => spend(b) },
    { key: 'version', header: 'Version', hideBelow: 'lg', render: (b) => `${b.appVersion} · suite ${b.suiteVersion}` },
    { key: 'date', header: 'Started', render: (b) => date(b) },
  ];

  return (
    <PageContainer width="wide">
      <PageHeader
        title="Benchmarks"
        subtitle="The same challenges run under several agent policies on a node, each trial graded from the challenge site's own state."
        back={{ to: '/admin/settings', label: 'Administration' }}
        primary={{ key: 'new', label: 'New benchmark', Icon: AddIcon, to: `${BENCHMARKS_PATH}/new`, hidden: !canRun }}
      />
      <ErrorBanner error={error} onRetry={() => void load()} />
      {notice && (
        <Alert severity="success" onClose={() => setNotice(null)} sx={{ mb: 2 }} data-testid="delete-notice">
          {notice}
        </Alert>
      )}
      {items === null ? (
        <ListSkeleton />
      ) : items.length === 0 ? (
        <EmptyState
          Icon={LeaderboardOutlinedIcon}
          title="No benchmarks yet"
          body="A benchmark compares agent policies on the built-in challenges: success, reliability, speed, tokens and cost."
          action={canRun ? { key: 'new', label: 'New benchmark', Icon: AddIcon, to: `${BENCHMARKS_PATH}/new` } : undefined}
        />
      ) : (
        <ResponsiveList
          aria-label="Benchmarks"
          items={items}
          columns={columns}
          getKey={(b) => b.id}
          getLabel={(b) => b.name}
          selection={selection}
          onRowClick={(b) => navigate(benchmarkPath(b.id))}
          renderCard={(b) => (
            <Card variant="outlined">
              <CardActionArea onClick={() => navigate(benchmarkPath(b.id))} sx={{ minHeight: 44 }}>
                <CardContent>
                  <Stack direction="row" spacing={1} sx={{ alignItems: 'flex-start', justifyContent: 'space-between', mb: 0.5 }}>
                    <Typography variant="subtitle1" component="h2" sx={{ overflowWrap: 'anywhere', minWidth: 0 }}>
                      {b.name}
                    </Typography>
                    <BenchmarkStatusChip status={b.status} />
                  </Stack>
                  <Typography variant="body2" color="text.secondary" sx={{ overflowWrap: 'anywhere' }}>
                    {policiesText(b)}
                  </Typography>
                  <Box sx={{ my: 0.5 }}>
                    <TopScore best={best[b.id]} />
                  </Box>
                  <Typography variant="body2">Best success: {bestText(best[b.id])}</Typography>
                  <Typography variant="body2">Spend: {spend(b)}</Typography>
                  <Typography variant="caption" color="text.secondary">
                    {date(b)} · {b.appVersion} · suite {b.suiteVersion}
                  </Typography>
                </CardContent>
              </CardActionArea>
            </Card>
          )}
        />
      )}
      {canRun && selected.size > 0 && (
        <Paper
          elevation={6}
          role="region"
          aria-label="Selection"
          sx={{ position: 'sticky', bottom: aboveBottomBar(16), zIndex: 3, mt: 2, px: 2, py: 1, display: 'flex', alignItems: 'center', gap: 1, flexWrap: 'wrap' }}
        >
          <Typography sx={{ flexGrow: 1, fontVariantNumeric: 'tabular-nums' }}>{selected.size} selected</Typography>
          <Button color="error" variant="contained" disabled={deleting} onClick={() => void deleteSelected()} sx={{ minHeight: 44 }}>
            Delete
          </Button>
          <Button onClick={() => setSelectedIds(new Set())} sx={{ minHeight: 44 }}>
            Cancel selection
          </Button>
        </Paper>
      )}
    </PageContainer>
  );
}
