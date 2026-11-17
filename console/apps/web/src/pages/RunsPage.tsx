import { useCallback, useEffect, useState } from 'react';
import { Alert, Box, Button, Chip, Container, List, ListItemButton, ListItemText, Paper, Stack, TextField, Typography } from '@mui/material';
import { useNavigate, useParams, useSearchParams } from 'react-router-dom';
import { usePlatformHost } from '@marinoscar/platform-web/core';

import { fetchRunScreenshot, subscribeRun } from '../live';
import { ActionOverlay, frameCaption, RunActivityBar, useNow, type RunActivity } from '../components/RunActivity';
import { RunTimeline } from '../components/RunTimeline';
import { RunBudgetMeter, RunHeaderChips, RunStopReason, TaskSpendLine } from '../components/RunBudgetMeter';
import { formatUsd, stopChipLabel, type RunBudget, type RunPolicy, type RunTier, type StopReason, type TaskSpend } from '../components/runBudget';

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
  /** Spend (#400): USD, a lower bound while `costKnown` is false. */
  costUsd?: number;
  costKnown?: boolean;
  modelCalls?: number;
  /** The policy, the budget and why it stopped (#401, #404), and its model tier (#408). */
  policy?: RunPolicy | null;
  budget?: RunBudget | null;
  stopReason?: StopReason | null;
  tier?: RunTier | null;
}

/** The run's cost, or null before it made a model call. */
const runCost = (r: Run) => (typeof r.costUsd === 'number' && (r.modelCalls ?? 0) > 0 ? formatUsd(r.costUsd, r.costKnown ?? true) : null);

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
  /** The task's spend, on its runs view (#408). */
  const [spend, setSpend] = useState<{ name: string; spend30d?: TaskSpend } | null>(null);
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

  useEffect(() => {
    if (!taskId || !viewer.hasPermission('tasks:read')) return setSpend(null);
    api
      .get<{ name: string; spend30d?: TaskSpend }>(`/tasks/${encodeURIComponent(taskId)}`)
      .then(setSpend)
      .catch(() => setSpend(null));
  }, [api, taskId, viewer]);

  return (
    <Container maxWidth="md" sx={{ py: 4 }}>
      <Typography variant="h4" component="h1" gutterBottom>
        Runs
      </Typography>
      {error && <Alert severity="error">{error}</Alert>}
      {spend && (
        <Box sx={{ mb: 1 }}>
          <Typography variant="subtitle1">{spend.name}</Typography>
          <TaskSpendLine spend={spend.spend30d} />
        </Box>
      )}
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
        {runs.map((r) => {
          const cost = runCost(r);
          const stop = stopChipLabel(r.stopReason);
          return (
            <ListItemButton key={r.id} onClick={() => navigate(`/runs/${r.id}`)} data-testid={`run-row-${r.id}`}>
              <ListItemText primary={r.goal} secondary={`${new Date(r.createdAt).toLocaleString()} · ${r.stepCount} steps · ${r.trigger === 'external' ? `driven by ${r.actor ?? 'an external agent'}` : r.trigger}`} />
              {/* The cost: a column from sm up, a chip on a phone (#408). */}
              <Typography variant="body2" color="text.secondary" sx={{ display: { xs: 'none', sm: 'block' }, minWidth: 72, textAlign: 'right', mx: 1, fontVariantNumeric: 'tabular-nums' }} data-testid="run-cost">
                {cost ?? '—'}
              </Typography>
              <Stack direction={{ xs: 'column', sm: 'row' }} spacing={0.5} sx={{ alignItems: { xs: 'flex-end', sm: 'center' }, justifyContent: 'flex-end', ml: 1, minWidth: { sm: 190 } }}>
                {cost && <Chip size="small" variant="outlined" label={cost} sx={{ display: { xs: 'inline-flex', sm: 'none' } }} />}
                {stop && <Chip size="small" variant="outlined" color={r.stopReason === 'error' || r.stopReason === 'no_model' ? 'error' : 'warning'} label={stop} data-testid="run-stop" />}
                <Chip size="small" color={STATUS_COLOR[r.status]} label={statusLabel(r.status)} />
              </Stack>
            </ListItemButton>
          );
        })}
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
  /** The frame's pixel size, to place where the agent acts on it (#381). */
  const [shotSize, setShotSize] = useState<{ width: number; height: number } | null>(null);
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
        Profile {run.profile} · {run.stepCount} steps{runCost(run) ? ` · ${runCost(run)}` : ''} · started {new Date(run.createdAt).toLocaleString()}
      </Typography>
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
    </Container>
  );
}
