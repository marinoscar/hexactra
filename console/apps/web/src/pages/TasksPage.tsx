import { useCallback, useEffect, useState, type FormEvent } from 'react';
import { Alert, Box, Button, Card, CardActions, CardContent, Chip, Container, FormControlLabel, Stack, Switch, TextField, Typography } from '@mui/material';
import { useNavigate } from 'react-router-dom';
import { usePlatformHost } from '@marinoscar/platform-web/core';

import { TaskSchedules } from './TaskSchedules';

/** A task, as `GET /api/tasks` returns it. */
export interface Task {
  id: string;
  name: string;
  goal: string;
  profile: string;
  hostId: string | null;
  allowedDomains: string[];
  maxSteps: number;
  maxMinutes: number;
  confirmRiskyActions: boolean;
  model: string | null;
}

function message(e: unknown, fallback: string): string {
  return e instanceof Error ? e.message : fallback;
}

/** `/tasks`: saved browser goals; run one now. */
export function TasksPage() {
  const { api, viewer } = usePlatformHost();
  const navigate = useNavigate();
  const canWrite = viewer.hasPermission('tasks:write');
  const canRun = viewer.hasPermission('runs:write');
  const [tasks, setTasks] = useState<Task[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [name, setName] = useState('');
  const [goal, setGoal] = useState('');
  const [profile, setProfile] = useState('default');
  const [domains, setDomains] = useState('');
  const [confirmRisky, setConfirmRisky] = useState(false);
  const [editing, setEditing] = useState<string | null>(null);

  const reset = () => {
    setEditing(null);
    setName('');
    setGoal('');
    setProfile('default');
    setDomains('');
    setConfirmRisky(false);
  };

  const edit = (t: Task) => {
    setEditing(t.id);
    setName(t.name);
    setGoal(t.goal);
    setProfile(t.profile);
    setDomains(t.allowedDomains.join(', '));
    setConfirmRisky(t.confirmRiskyActions);
  };

  const load = useCallback(async () => {
    try {
      setTasks(await api.get<Task[]>('/tasks'));
    } catch (e) {
      setError(message(e, 'Could not load tasks'));
    }
  }, [api]);

  useEffect(() => {
    void load();
  }, [load]);

  const create = async (event: FormEvent) => {
    event.preventDefault();
    setError(null);
    const body = {
      name: name.trim(),
      goal: goal.trim(),
      profile: profile.trim() || 'default',
      allowedDomains: domains.split(/[\s,]+/).map((d) => d.trim()).filter(Boolean),
      confirmRiskyActions: confirmRisky,
    };
    try {
      if (editing) await api.patch(`/tasks/${editing}`, body);
      else await api.post('/tasks', body);
      reset();
      await load();
    } catch (e) {
      setError(message(e, editing ? 'Could not save the task' : 'Could not create the task'));
    }
  };

  const run = async (task: Task) => {
    try {
      const r = await api.post<{ id: string }>(`/tasks/${task.id}/runs`, {});
      navigate(`/runs/${r.id}`);
    } catch (e) {
      setError(message(e, 'Could not start the run'));
    }
  };

  return (
    <Container maxWidth="md" sx={{ py: 4 }}>
      <Typography variant="h4" component="h1" gutterBottom>
        Tasks
      </Typography>
      {error && (
        <Alert severity="error" sx={{ mb: 2 }}>
          {error}
        </Alert>
      )}
      {canWrite && (
        <Card variant="outlined" sx={{ mb: 3 }}>
          <CardContent component="form" onSubmit={create} aria-label={editing ? 'Edit task' : 'New task'}>
            <Stack spacing={2}>
              <TextField label="Name" value={name} onChange={(e) => setName(e.target.value)} required />
              <TextField label="Goal" value={goal} onChange={(e) => setGoal(e.target.value)} multiline minRows={2} required helperText="What the agent should achieve, in plain words." />
              <Stack direction={{ xs: 'column', sm: 'row' }} spacing={2}>
                <TextField label="Profile" value={profile} onChange={(e) => setProfile(e.target.value)} helperText="The browser profile (its sign-ins)." />
                <TextField label="Allowed sites" value={domains} onChange={(e) => setDomains(e.target.value)} helperText="e.g. shop.example.test, *.example.test; empty allows any." fullWidth />
              </Stack>
              <FormControlLabel control={<Switch checked={confirmRisky} onChange={(e) => setConfirmRisky(e.target.checked)} />} label="Ask me before purchases and other irreversible steps" />
              <Box>
                <Button type="submit" variant="contained" disabled={!name.trim() || !goal.trim()}>
                  {editing ? 'Save task' : 'Create task'}
                </Button>
                {editing && (
                  <Button sx={{ ml: 1 }} onClick={reset}>
                    Cancel
                  </Button>
                )}
              </Box>
            </Stack>
          </CardContent>
        </Card>
      )}
      <Stack spacing={2} aria-label="Tasks">
        {tasks.map((t) => (
          <Card key={t.id} variant="outlined" aria-label={`Task ${t.name}`}>
            <CardContent>
              <Typography variant="h6" component="h2">
                {t.name}
              </Typography>
              <Typography color="text.secondary" sx={{ whiteSpace: 'pre-wrap' }}>
                {t.goal}
              </Typography>
              <Stack direction="row" spacing={1} sx={{ mt: 1, flexWrap: 'wrap', rowGap: 1 }}>
                <Chip size="small" label={`profile: ${t.profile}`} />
                <Chip size="small" label={t.allowedDomains.length ? t.allowedDomains.join(', ') : 'any site'} />
                <Chip size="small" variant="outlined" label={`${t.maxSteps} steps · ${t.maxMinutes} min`} />
              </Stack>
              <TaskSchedules taskId={t.id} canWrite={canWrite} />
            </CardContent>
            <CardActions>
              {canRun && (
                <Button variant="contained" onClick={() => void run(t)}>
                  Run now
                </Button>
              )}
              <Button onClick={() => navigate(`/runs?taskId=${t.id}`)}>Runs</Button>
              {canWrite && <Button onClick={() => edit(t)}>Edit</Button>}
              {canWrite && (
                <Button color="error" onClick={() => void api.delete(`/tasks/${t.id}`).then(load)}>
                  Delete
                </Button>
              )}
            </CardActions>
          </Card>
        ))}
      </Stack>
    </Container>
  );
}
