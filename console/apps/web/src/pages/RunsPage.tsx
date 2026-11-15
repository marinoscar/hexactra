import { useCallback, useEffect, useState } from 'react';
import { Alert, Button, Chip, Container, List, ListItemButton, ListItemText, Paper, Stack, Typography } from '@mui/material';
import { useNavigate, useParams, useSearchParams } from 'react-router-dom';
import { usePlatformHost } from '@marinoscar/platform-web/core';

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
  createdAt: string;
}

export interface Run {
  id: string;
  taskId: string | null;
  status: RunStatus;
  trigger: string;
  goal: string;
  profile: string;
  result: string | null;
  error: string | null;
  cancelRequested: boolean;
  stepCount: number;
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
  const { api } = usePlatformHost();
  const navigate = useNavigate();
  const [params] = useSearchParams();
  const taskId = params.get('taskId');
  const [runs, setRuns] = useState<Run[]>([]);
  const [error, setError] = useState<string | null>(null);

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
      {runs.length === 0 && !error && <Alert severity="info">No runs yet. Start one from Tasks.</Alert>}
      <List aria-label="Runs">
        {runs.map((r) => (
          <ListItemButton key={r.id} onClick={() => navigate(`/runs/${r.id}`)}>
            <ListItemText primary={r.goal} secondary={`${new Date(r.createdAt).toLocaleString()} · ${r.stepCount} steps · ${r.trigger}`} />
            <Chip size="small" color={STATUS_COLOR[r.status]} label={statusLabel(r.status)} />
          </ListItemButton>
        ))}
      </List>
    </Container>
  );
}

/** `/runs/:id`: one run, its steps, and cancel. Refreshes while it is live. */
export function RunDetailPage() {
  const { api, viewer } = usePlatformHost();
  const { id } = useParams<{ id: string }>();
  const [run, setRun] = useState<Run | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      setRun(await api.get<Run>(`/runs/${id}`));
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not load the run');
    }
  }, [api, id]);

  useEffect(() => {
    void load();
  }, [load]);
  useEffect(() => {
    if (!run || !live(run.status)) return;
    const t = setInterval(() => void load(), 2_000);
    return () => clearInterval(t);
  }, [run, load]);

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
      {run.status === 'waiting_human' && <Alert severity="warning" sx={{ my: 2 }}>The agent is waiting for you. Answer the request it sent you.</Alert>}
      {live(run.status) && viewer.hasPermission('runs:write') && (
        <Button color="error" variant="outlined" disabled={run.cancelRequested} onClick={() => void api.post(`/runs/${run.id}/cancel`, {}).then(load)} sx={{ mb: 2 }}>
          {run.cancelRequested ? 'Cancelling…' : 'Cancel run'}
        </Button>
      )}
      <Paper variant="outlined">
        <List aria-label="Steps" dense>
          {(run.steps ?? []).map((s) => (
            <ListItemText
              key={s.id}
              sx={{ px: 2, py: 1, borderBottom: 1, borderColor: 'divider' }}
              primary={`${s.seq}. ${s.action ?? s.kind}${s.ok ? '' : ' (failed)'}: ${s.summary}`}
              secondary={s.reasoning ?? (s.args ? JSON.stringify(s.args) : undefined)}
            />
          ))}
        </List>
      </Paper>
    </Container>
  );
}
