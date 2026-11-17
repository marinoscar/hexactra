import { useCallback, useEffect, useState } from 'react';
import { Alert, Box, Button, Chip, Container, List, ListItemButton, ListItemText, Paper, Stack, TextField, Typography } from '@mui/material';
import { useNavigate, useParams, useSearchParams } from 'react-router-dom';
import { usePlatformHost } from '@marinoscar/platform-web/core';

import { fetchRunScreenshot, subscribeRun } from '../live';
import { frameCaption, RunActivityBar, useNow, type RunActivity } from '../components/RunActivity';
import { RunTimeline } from '../components/RunTimeline';

/** `fetched`, plus any step of `prev` (received over the stream) it does not have yet. */
export function withStreamedSteps(fetched: Run, prev: Run | null): Run {
  if (!prev || prev.id !== fetched.id || !prev.steps?.length) return fetched;
  const have = new Set((fetched.steps ?? []).map((st) => st.seq));
  const extra = prev.steps.filter((st) => !have.has(st.seq));
  if (!extra.length) return fetched;
  const steps = [...(fetched.steps ?? []), ...extra].sort((a, b) => a.seq - b.seq);
  return { ...fetched, steps, stepCount: Math.max(fetched.stepCount, ...steps.map((st) => st.seq)) };
}

export type RunStatus = 'queued' | 'running' | 'waiting_human' | 'succeeded' | 'failed' | 'cancelled';

export interface RunStep {
  id: string;
  seq: number;
  kind: string;
  action: string | null;
  args: Record<string, unknown> | null;
  ok: boolean;
  summary: string;
  reasoning: string | null;
  durationMs?: number | null;
  createdAt: string;
}

export interface Run {
  id: string;
  taskId: string | null;
  status: RunStatus;
  trigger: string;
  actor?: string | null;
  goal: string;
  profile: string;
  result: string | null;
  error: string | null;
  cancelRequested: boolean;
  stepCount: number;
  /** What a running run is doing right now (#379). */
  activity?: RunActivity | null;
  createdAt: string;
  finishedAt: string | null;
  steps?: RunStep[];
}

const STATUS_COLOR: Record<RunStatus, 'default' | 'info' | 'warning' | 'success' | 'error'> = {
  queued: 'default',
  running: 'info',
  waiting_human: 'warning',
  succeeded: 'success',
  failed: 'error',
  cancelled: 'default',
};

export const statusLabel = (s: RunStatus) => (s === 'waiting_human' ? 'needs you' : s);
const live = (s: RunStatus) => s === 'queued' || s === 'running' || s === 'waiting_human';

/** `/runs`: recent runs. */
export function RunsPage() {
  const { api, viewer } = usePlatformHost();
  const navigate = useNavigate();
  const [params] = useSearchParams();
  const taskId = params.get('taskId');
  const [runs, setRuns] = useState<Run[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [goal, setGoal] = useState('');
  const [profile, setProfile] = useState('default');
  const canRun = viewer.hasPermission('runs:write');

  const start = async () => {
    setError(null);
    try {
      const r = await api.post<{ id: string }>('/runs', { goal: goal.trim(), profile: profile.trim() || 'default' });
      navigate(`/runs/${r.id}`);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not start the run');
    }
  };

  const load = useCallback(async () => {
    try {
      setRuns(await api.get<Run[]>(`/runs${taskId ? `?taskId=${encodeURIComponent(taskId)}` : ''}`));
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not load runs');
    }
  }, [api, taskId]);

  useEffect(() => {
    void load();
    const t = setInterval(() => void load(), 5_000);
    return () => clearInterval(t);
  }, [load]);

  return (
    <Container maxWidth="md" sx={{ py: 4 }}>
      <Typography variant="h4" component="h1" gutterBottom>
        Runs
      </Typography>
      {error && <Alert severity="error">{error}</Alert>}
      {canRun && !taskId && (
        <Stack
          component="form"
          aria-label="Run a goal"
          direction={{ xs: 'column', sm: 'row' }}
          spacing={1}
          sx={{ my: 2 }}
          onSubmit={(e) => {
            e.preventDefault();
            void start();
          }}
        >
          <TextField label="Goal" value={goal} onChange={(e) => setGoal(e.target.value)} fullWidth size="small" helperText="A one-off goal; save it as a task to reuse it." />
          <TextField label="Profile" value={profile} onChange={(e) => setProfile(e.target.value)} size="small" />
          <Box>
            <Button type="submit" variant="contained" disabled={!goal.trim()}>
              Run
            </Button>
          </Box>
        </Stack>
      )}
      {runs.length === 0 && !error && <Alert severity="info">No runs yet. Run a goal above, or start one from Tasks.</Alert>}
      <List aria-label="Runs">
        {runs.map((r) => (
          <ListItemButton key={r.id} onClick={() => navigate(`/runs/${r.id}`)}>
            <ListItemText primary={r.goal} secondary={`${new Date(r.createdAt).toLocaleString()} · ${r.stepCount} steps · ${r.trigger === 'external' ? `driven by ${r.actor ?? 'an external agent'}` : r.trigger}`} />
            <Chip size="small" color={STATUS_COLOR[r.status]} label={statusLabel(r.status)} />
          </ListItemButton>
        ))}
      </List>
    </Container>
  );
}

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
  const [watch, setWatch] = useState(true);
  const [where, setWhere] = useState<RunViewer | null>(null);

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

  const isLive = run ? live(run.status) : false;
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


  if (error) return <Alert severity="error">{error}</Alert>;
  if (!run) return null;
  return (
    <Container maxWidth="md" sx={{ py: 4 }}>
      <Stack direction="row" spacing={1} sx={{ alignItems: 'center', mb: 1 }}>
        <Typography variant="h5" component="h1" sx={{ flexGrow: 1 }}>
          {run.goal}
        </Typography>
        <Chip color={STATUS_COLOR[run.status]} label={statusLabel(run.status)} />
      </Stack>
      <Typography color="text.secondary" gutterBottom>
        Profile {run.profile} · {run.stepCount} steps · started {new Date(run.createdAt).toLocaleString()}
      </Typography>
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
          {shot && <Box component="img" src={shot} alt="The run's browser, live" sx={{ display: 'block', width: '100%', borderRadius: 1, border: 1, borderColor: 'divider' }} />}
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
    </Container>
  );
}
