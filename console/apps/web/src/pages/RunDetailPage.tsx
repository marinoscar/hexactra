import { useCallback, useEffect, useState } from 'react';
import { Alert, Box, Button, Link, Stack, Typography } from '@mui/material';
import { Link as RouterLink, useNavigate, useParams } from 'react-router-dom';
import { isPlatformApiError, usePlatformHost } from '@marinoscar/platform-web/core';

import { fetchRunScreenshot, subscribeRun } from '../live';
import { ActionOverlay, frameCaption, RunActivityBar, useNow } from '../components/RunActivity';
import { RunBudgetMeter, RunHeaderChips, RunStopReason } from '../components/RunBudgetMeter';
import { runCost } from '../components/runBudget';
import { runAgain } from '../components/runRow';
import { RunTimeline } from '../components/RunTimeline';
import { withStreamedSteps } from '../components/runTimeline';
import type { Run, RunStep } from '../types/runs';
import { EmptyState, ErrorBanner, ListSkeleton, PageContainer, PageHeader, StatusChip, formatDateTime, isLive as isLiveStatus, useConfirm, useProfileTimeZone } from '../ui';

/** Where a person can watch and take over the run's browser. */
interface RunViewer {
  hostId: string | null;
  hostName: string | null;
  /** The host's desktop can be opened in the console. */
  desktop: boolean;
}

/**
 * `/runs/:id`: one run, live. Steps and status arrive over the run's event
 * stream, with what it is doing right now (#379); while the run is live, the browser's screenshot refreshes every
 * 2 s and the viewer link lets a person take over.
 */
export function RunDetailPage() {
  const { api, viewer } = usePlatformHost();
  const { id } = useParams<{ id: string }>();
  const navigate = useNavigate();
  const [run, setRun] = useState<Run | null>(null);
  const [error, setError] = useState<string | null>(null);
  /** The run is gone (404): deleted, here or on another device. */
  const [missing, setMissing] = useState(false);
  /** A failed Delete or Run again; the page stays as it is. */
  const [actionError, setActionError] = useState<string | null>(null);
  const confirm = useConfirm();
  const [shot, setShot] = useState<string | null>(null);
  /** When the shown frame was taken, and whether the latest fetch failed (#379). */
  const [shotAt, setShotAt] = useState<number | null>(null);
  const [shotFailing, setShotFailing] = useState(false);
  /** The frame's pixel size, to place where the agent acts on it (#381). */
  const [shotSize, setShotSize] = useState<{ width: number; height: number } | null>(null);
  const [watch, setWatch] = useState(true);
  const [where, setWhere] = useState<RunViewer | null>(null);
  useProfileTimeZone();

  const load = useCallback(async () => {
    try {
      const fetched = await api.get<Run>(`/runs/${id}`);
      // A load can finish after the stream delivered newer steps: keep them.
      setRun((prev) => withStreamedSteps(fetched, prev));
    } catch (e) {
      if (isPlatformApiError(e) && e.status === 404) return setMissing(true);
      setError(e instanceof Error ? e.message : 'Could not load the run');
    }
  }, [api, id]);

  // The task's name, for the link to it (#423).
  const taskId = run?.taskId ?? null;
  const [taskName, setTaskName] = useState<string | null>(null);
  useEffect(() => {
    if (!taskId || !viewer.hasPermission('tasks:read')) return setTaskName(null);
    let stale = false;
    api
      .get<{ name: string }>(`/tasks/${taskId}`)
      .then((task) => {
        if (!stale) setTaskName(task.name);
      })
      .catch(() => undefined);
    return () => {
      stale = true;
    };
  }, [api, taskId, viewer]);

  /** Delete (#423): asks first, then goes back to the list, which says so. */
  const remove = async () => {
    const ok = await confirm({
      title: 'Delete this run?',
      body: 'Its steps and answers are deleted too. Its cost and stop-reason history is removed from task spend and alerts. This cannot be undone.',
      confirmLabel: 'Delete',
      destructive: true,
    });
    if (!ok || !run) return;
    try {
      await api.delete(`/runs/${run.id}`);
      navigate('/runs', { state: { toast: 'Run deleted' } });
    } catch (e) {
      setActionError(e instanceof Error ? e.message : 'Could not delete the run');
    }
  };

  /** Run again (#423): the same task or goal; the policy only when it was chosen for this run. */
  const again = async () => {
    if (!run) return;
    try {
      const started = await runAgain(api, run);
      navigate(`/runs/${started.id}`);
    } catch (e) {
      setActionError(e instanceof Error ? e.message : 'Could not start the run');
    }
  };

  useEffect(() => {
    void load();
  }, [load]);

  const isLive = run ? isLiveStatus(run.status) : false;
  const now = useNow(isLive);

  // Live updates over SSE: a reconnect refetches, a step appends, a run event merges.
  useEffect(() => {
    if (!id || !isLive) return;
    return subscribeRun(id, (e) => {
      if (e.type === 'open') return void load();
      if (e.type === 'step') {
        const step = e.data as RunStep;
        setRun((r) => (r && !(r.steps ?? []).some((s) => s.seq === step.seq) ? { ...r, steps: [...(r.steps ?? []), step], stepCount: Math.max(r.stepCount, step.seq) } : r));
      }
      if (e.type === 'run') setRun((r) => (r ? { ...r, ...(e.data as Partial<Run>) } : r));
    });
  }, [id, isLive, load]);

  // The browser, every 2 s while watching a live run.
  useEffect(() => {
    if (!id || !isLive || !watch) return;
    let stopped = false;
    let current: string | null = null;
    const next = async () => {
      const url = await fetchRunScreenshot(id).catch(() => null);
      if (stopped) {
        if (url) URL.revokeObjectURL(url);
        return;
      }
      if (url) {
        if (current) URL.revokeObjectURL(current);
        current = url;
        setShot(url);
        setShotAt(Date.now());
      }
      // A failed fetch keeps the last frame, but the page says how old it is.
      setShotFailing(!url);
      timer = setTimeout(() => void next(), 2_000);
    };
    let timer = setTimeout(() => void next(), 0);
    return () => {
      stopped = true;
      clearTimeout(timer);
      if (current) URL.revokeObjectURL(current);
    };
  }, [id, isLive, watch]);

  useEffect(() => {
    if (!id || !isLive) return;
    void api.get<RunViewer>(`/runs/${id}/viewer`).then(setWhere).catch(() => setWhere(null));
  }, [api, id, isLive]);

  const back = { to: '/runs', label: 'Runs' };
  if (missing) {
    return (
      <PageContainer>
        <PageHeader title="Run" back={back} />
        <EmptyState title="This run does not exist any more." body="It may have been deleted." action={{ key: 'runs', label: 'Go to Runs', to: '/runs' }} />
      </PageContainer>
    );
  }
  if (error) {
    return (
      <PageContainer>
        <PageHeader title="Run" back={back} />
        <ErrorBanner error={error} />
      </PageContainer>
    );
  }
  if (!run) {
    return (
      <PageContainer>
        <ListSkeleton />
      </PageContainer>
    );
  }
  const finished = !isLive;
  return (
    <PageContainer>
      <PageHeader
        variant="h5"
        title={run.goal}
        back={run.taskId ? { to: `/tasks/${run.taskId}`, label: taskName ?? 'Task' } : back}
        actions={[
          { key: 'again', label: 'Run again', onClick: () => void again(), hidden: !finished || run.trigger === 'external' || !viewer.hasPermission('runs:write') },
          { key: 'delete', label: 'Delete', color: 'error', onClick: () => void remove(), hidden: !finished || !viewer.hasPermission('runs:delete') },
        ]}
        subtitle={
          <>
            Profile {run.profile} · {run.stepCount} steps{runCost(run) ? ` · ${runCost(run)}` : ''} · started {formatDateTime(run.createdAt)}
          </>
        }
      >
        <StatusChip status={run.status} size="medium" />
      </PageHeader>
      <ErrorBanner error={actionError} onClose={() => setActionError(null)} />
      {run.taskId && (
        <Typography variant="body2" sx={{ mb: 1 }}>
          <Link component={RouterLink} to={`/tasks/${run.taskId}`} underline="hover">
            Task{taskName ? `: ${taskName}` : ''}
          </Link>
          {' · '}
          <Link component={RouterLink} to="/runs" underline="hover">
            All runs
          </Link>
        </Typography>
      )}
      <RunHeaderChips policy={run.policy} tier={run.tier} />
      {/* A typed stop reason (#404) says why in one line; older runs keep the plain result and error. */}
      {!isLive && run.stopReason ? (
        <RunStopReason run={run} />
      ) : (
        <>
          {run.result && <Alert severity={run.status === 'succeeded' ? 'success' : 'info'} sx={{ my: 2 }}>{run.result}</Alert>}
          {run.error && <Alert severity="error" sx={{ my: 2 }}>{run.error}</Alert>}
        </>
      )}
      {run.status === 'waiting_human' && <Alert severity="warning" sx={{ my: 2 }}>The agent is waiting for you. Answer its request in the Inbox.</Alert>}
      {isLive && (
        <Stack direction="row" spacing={1} sx={{ mb: 2, flexWrap: 'wrap', rowGap: 1 }}>
          {viewer.hasPermission('runs:write') && (
            <Button color="error" variant="outlined" disabled={run.cancelRequested} onClick={() => void api.post(`/runs/${run.id}/cancel`, {}).then(load)}>
              {run.cancelRequested ? 'Cancelling…' : 'Cancel run'}
            </Button>
          )}
          <Button variant="outlined" onClick={() => setWatch((w) => !w)}>
            {watch ? 'Stop watching' : 'Watch the browser'}
          </Button>
          {where?.desktop && where.hostId && viewer.hasPermission('fleet:desktop') && (
            <Button variant="outlined" onClick={() => navigate(`/fleet/hosts/${where.hostId}/desktop`)}>
              Take over{where.hostName ? ` on ${where.hostName}` : ''}
            </Button>
          )}
        </Stack>
      )}
      {run.budget && <RunBudgetMeter budget={run.budget} ticking={run.status === 'running'} now={now} />}
      {run.status === 'running' && run.activity && <RunActivityBar activity={run.activity} now={now} />}
      {isLive && watch && (shot || shotFailing) && (
        <Box sx={{ mb: 2 }}>
          {shot && (
            <Box sx={{ position: 'relative' }}>
              <Box
                component="img"
                src={shot}
                alt="The run's browser, live"
                onLoad={(e: React.SyntheticEvent<HTMLImageElement>) => setShotSize({ width: e.currentTarget.naturalWidth, height: e.currentTarget.naturalHeight })}
                sx={{ display: 'block', width: '100%', borderRadius: 1, border: 1, borderColor: 'divider' }}
              />
              {run.status === 'running' && run.activity?.phase === 'acting' && <ActionOverlay activity={run.activity} natural={shotSize} />}
            </Box>
          )}
          {(() => {
            const caption = frameCaption(shotAt, shotFailing, now);
            return (
              <Typography variant="caption" color={caption.stale ? 'warning.main' : 'text.secondary'} data-testid="frame-age">
                {caption.text}
              </Typography>
            );
          })()}
        </Box>
      )}
      <RunTimeline steps={run.steps ?? []} live={isLive} />
    </PageContainer>
  );
}
