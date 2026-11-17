import { useCallback, useEffect, useState } from 'react';
import { Alert, Box, Button, Stack, Typography } from '@mui/material';
import { useNavigate, useParams } from 'react-router-dom';
import { usePlatformHost } from '@marinoscar/platform-web/core';

import { fetchRunScreenshot, subscribeRun } from '../live';
import { ActionOverlay, frameCaption, RunActivityBar, useNow } from '../components/RunActivity';
import { RunTimeline } from '../components/RunTimeline';
import { withStreamedSteps } from '../components/runTimeline';
import type { Run, RunStep } from '../types/runs';
import { ErrorBanner, ListSkeleton, PageContainer, PageHeader, StatusChip, formatDateTime, isLive as isLiveStatus, useProfileTimeZone } from '../ui';

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
      setError(e instanceof Error ? e.message : 'Could not load the run');
    }
  }, [api, id]);

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
  return (
    <PageContainer>
      <PageHeader
        variant="h5"
        title={run.goal}
        back={back}
        subtitle={
          <>
            Profile {run.profile} · {run.stepCount} steps · started {formatDateTime(run.createdAt)}
            {run.policy && ` · policy ${run.policy.name} v${run.policy.version}${run.policy.source === 'run' ? ' (this run only)' : ''}`}
          </>
        }
      >
        <StatusChip status={run.status} stopReason={run.stopReason} size="medium" />
      </PageHeader>
      {run.result && <Alert severity={run.status === 'succeeded' ? 'success' : 'info'} sx={{ my: 2 }}>{run.result}</Alert>}
      {run.error && <Alert severity="error" sx={{ my: 2 }}>{run.error}</Alert>}
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
