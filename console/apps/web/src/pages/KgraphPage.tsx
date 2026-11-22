import AccountTreeOutlinedIcon from '@mui/icons-material/AccountTreeOutlined';
import { Box, MenuItem, Paper, Stack, Tab, Tabs, TextField, Typography } from '@mui/material';
import { usePlatformHost } from '@marinoscar/platform-web/core';
import { lazy, Suspense, useCallback, useEffect, useMemo, useState } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';

import { getKgStatus, getKgSummary, listProcedures, type KgProcedureItem, type KgStatus, type KgTaskSummary } from '../kgraph/api';
import { HealthChip, KgraphOffNotice, StateChip, savingText } from '../kgraph/labels';
import { KgReviewCard, usePendingKgReviews } from '../kgraph/ReviewCard';
import { VersionHistory } from '../kgraph/VersionHistory';
import { EmptyState, ErrorBanner, ListSkeleton, PageContainer, PageHeader, RelativeTime, ResponsiveList, type Column } from '../ui';

// The Map (E46.21) is its own chunk: no other page, and no other tab of this one, loads React Flow or the layout.
const MapTab = lazy(() => import('../kgraph/map/MapTab'));

const TABS = ['procedures', 'map', 'reviews', 'history'] as const;
type KgTab = (typeof TABS)[number];
const TAB_LABEL: Record<KgTab, string> = { procedures: 'Procedures', map: 'Map', reviews: 'Reviews', history: 'History' };

export const procedurePath = (id: string) => `/kgraph/procedures/${encodeURIComponent(id)}`;

/** "12 runs, 92% replayed cleanly", or "no runs yet". */
function healthLine(p: KgProcedureItem): string {
  if (p.ledger.runs === 0) return 'No runs yet';
  const rate = p.ledger.cleanReplayRate === null ? '' : `, ${Math.round(p.ledger.cleanReplayRate * 100)}% replayed cleanly`;
  return `${p.ledger.runs} run${p.ledger.runs === 1 ? '' : 's'}${rate}`;
}

function ProcedureCard({ p, summary, onOpen }: { p: KgProcedureItem; summary: KgTaskSummary | undefined; onOpen: () => void }) {
  return (
    <Paper variant="outlined" component="article" aria-label={`Procedure ${p.taskName}`} onClick={onOpen} sx={{ p: 2, cursor: 'pointer', minWidth: 0 }}>
      <Stack direction="row" spacing={1} useFlexGap sx={{ flexWrap: 'wrap', alignItems: 'center', mb: 0.5 }}>
        <StateChip state={p.state} />
        <HealthChip health={p.health} />
      </Stack>
      <Typography sx={{ fontWeight: 500, overflowWrap: 'anywhere' }}>{p.taskName}</Typography>
      <Typography variant="body2" color="text.secondary" sx={{ overflowWrap: 'anywhere' }}>
        {p.steps} step{p.steps === 1 ? '' : 's'} · {healthLine(p)} · <RelativeTime iso={p.updatedAt} prefix="updated " />
      </Typography>
      <Typography variant="body2" sx={{ mt: 0.5 }}>
        {savingText(summary)}
      </Typography>
    </Paper>
  );
}

function ProceduresTab({ procedures, summaries }: { procedures: KgProcedureItem[]; summaries: Map<string, KgTaskSummary> }) {
  const navigate = useNavigate();
  const columns: Column<KgProcedureItem>[] = [
    { key: 'state', header: 'State', width: 120, render: (p) => <StateChip state={p.state} /> },
    {
      key: 'task',
      header: 'Task',
      grow: true,
      render: (p) => (
        <>
          <Typography variant="body2" sx={{ fontWeight: 500, overflowWrap: 'anywhere' }}>
            {p.taskName}
          </Typography>
          <Typography variant="caption" color="text.secondary">
            {p.steps} step{p.steps === 1 ? '' : 's'}
            {p.versionNumber !== null && ` · version ${p.versionNumber}`}
          </Typography>
        </>
      ),
    },
    {
      key: 'health',
      header: 'Health',
      render: (p) => (
        <Stack spacing={0.5} sx={{ alignItems: 'flex-start' }}>
          <HealthChip health={p.health} />
          <Typography variant="caption" color="text.secondary">
            {healthLine(p)}
          </Typography>
        </Stack>
      ),
    },
    { key: 'saving', header: 'Against AI only', render: (p) => <Typography variant="body2">{savingText(summaries.get(p.taskId))}</Typography> },
    { key: 'updated', header: 'Updated', hideBelow: 'lg', render: (p) => <RelativeTime iso={p.updatedAt} /> },
  ];
  return (
    <ResponsiveList
      aria-label="Procedures"
      items={procedures}
      columns={columns}
      getKey={(p) => p.id}
      onRowClick={(p) => navigate(procedurePath(p.id))}
      renderCard={(p) => <ProcedureCard p={p} summary={summaries.get(p.taskId)} onOpen={() => navigate(procedurePath(p.id))} />}
    />
  );
}

function HistoryTab({ procedures, initial }: { procedures: KgProcedureItem[]; initial: string | null }) {
  // `?procedure=` opens one procedure's history (the Map's side panel links here).
  const [picked, setPicked] = useState<string>(initial ?? procedures[0]?.id ?? '');
  const id = procedures.some((p) => p.id === picked) ? picked : (procedures[0]?.id ?? '');
  return (
    <Stack spacing={2}>
      <TextField select size="small" label="Procedure" value={id} onChange={(e) => setPicked(e.target.value)} sx={{ maxWidth: { sm: 420 } }}>
        {procedures.map((p) => (
          <MenuItem key={p.id} value={p.id}>
            {p.taskName}
          </MenuItem>
        ))}
      </TextField>
      {id && <VersionHistory procedureId={id} />}
    </Stack>
  );
}

/**
 * `/kgraph` (E46.20, #794): what the Knowledge Graph learned. Procedures (a task's learned steps, its state, health and what it saved
 * against AI only), Map (E46.21, a lazily loaded chunk), Reviews (sensitive changes waiting for the owner) and History (versions and their diffs). Every
 * string from the graph is rendered as text, masked as the API returns it. While a switch is off the stored data is still shown.
 */
export function KgraphPage() {
  const { api } = usePlatformHost();
  const [params, setParams] = useSearchParams();
  const tab: KgTab = (TABS as readonly string[]).includes(params.get('tab') ?? '') ? (params.get('tab') as KgTab) : 'procedures';
  const setTab = (next: KgTab) => {
    const p = new URLSearchParams(params);
    if (next === 'procedures') p.delete('tab');
    else p.set('tab', next);
    setParams(p, { replace: true });
  };
  const [status, setStatus] = useState<KgStatus | null>(null);
  const [procedures, setProcedures] = useState<KgProcedureItem[] | null>(null);
  const [summaries, setSummaries] = useState<KgTaskSummary[]>([]);
  const [error, setError] = useState<string | null>(null);
  const reviews = usePendingKgReviews();

  const load = useCallback(async () => {
    try {
      const [s, list] = await Promise.all([getKgStatus(api), listProcedures(api)]);
      setStatus(s);
      setProcedures(list.procedures);
      setError(null);
    } catch (e) {
      setError(e instanceof Error && e.message ? e.message : 'Could not load the Knowledge Graph');
      setProcedures([]);
    }
    // The savings are a nice-to-have: without them each row says so.
    getKgSummary(api).then((r) => setSummaries(r.tasks), () => setSummaries([]));
  }, [api]);
  useEffect(() => {
    void load();
  }, [load]);

  const byTask = useMemo(() => new Map(summaries.map((s) => [s.taskId, s])), [summaries]);
  const pending = reviews.reviews?.length ?? 0;
  const empty = procedures !== null && procedures.length === 0;

  return (
    <PageContainer width="wide">
      <PageHeader title="Knowledge Graph" subtitle="The steps your saved tasks learned from their runs, and how well they repeat without the model." />
      {status && <KgraphOffNotice status={status} />}
      <Tabs value={tab} onChange={(_, v: KgTab) => setTab(v)} aria-label="Knowledge Graph views" variant="scrollable" allowScrollButtonsMobile sx={{ mb: 2, minHeight: 0 }}>
        {TABS.map((t) => (
          <Tab key={t} value={t} label={t === 'reviews' && pending > 0 ? `Reviews (${pending})` : TAB_LABEL[t]} sx={{ minHeight: 44 }} />
        ))}
      </Tabs>
      <ErrorBanner error={error} onRetry={() => void load()} />
      {tab === 'map' && (
        <Suspense fallback={<ListSkeleton />}>
          <MapTab procedures={procedures} reviews={reviews.reviews} />
        </Suspense>
      )}
      {tab === 'reviews' && (
        <Box aria-label="Reviews" component="section">
          <ErrorBanner error={reviews.error} />
          {reviews.reviews === null && <ListSkeleton />}
          {reviews.reviews?.length === 0 && <EmptyState title="Nothing to review" body="When a repair would change what a procedure sends or pays, its recipients, its sites, its accounts or its saved logins, it waits here for you." />}
          {reviews.reviews?.map((r) => <KgReviewCard key={r.id} review={r} onAnswered={() => reviews.drop(r.id)} />)}
        </Box>
      )}
      {(tab === 'procedures' || tab === 'history') && procedures === null && <ListSkeleton />}
      {(tab === 'procedures' || tab === 'history') && empty && (
        <EmptyState
          Icon={AccountTreeOutlinedIcon}
          title="Nothing learned yet"
          body="Choose Learn only or Learn and reuse on a saved task. After its next successful run, its steps show up here as a list you can read."
          action={{ key: 'tasks', label: 'Open your tasks', to: '/tasks' }}
        />
      )}
      {tab === 'procedures' && procedures && procedures.length > 0 && <ProceduresTab procedures={procedures} summaries={byTask} />}
      {tab === 'history' && procedures && procedures.length > 0 && <HistoryTab procedures={procedures} initial={params.get('procedure')} />}
    </PageContainer>
  );
}
