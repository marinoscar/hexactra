import { useCallback, useEffect, useState, type FormEvent } from 'react';
import { Alert, Box, Button, Card, CardActions, CardContent, Chip, FormControlLabel, MenuItem, Stack, Switch, TextField, Typography } from '@mui/material';
import { useNavigate } from 'react-router-dom';
import { usePlatformHost } from '@marinoscar/platform-web/core';

import { TaskSchedules } from './TaskSchedules';
import { runTaskWith } from '../policies/api';
import { taskPolicyChips } from '../policies/format';
import { PolicySelect } from '../policies/PolicySelect';
import { RunWithButton } from '../policies/RunWithButton';
import { usePolicyCatalog } from '../policies/usePolicyCatalog';
import { machineState, type FleetHost } from '../types/fleet';
import type { Task } from '../types/tasks';
import { CardSkeleton, ErrorBanner, PageContainer, PageHeader, useConfirm } from '../ui';

function message(e: unknown, fallback: string): string {
  return e instanceof Error ? e.message : fallback;
}

/** `/tasks`: saved browser goals; run one now. */
export function TasksPage() {
  const { api, viewer } = usePlatformHost();
  const navigate = useNavigate();
  const canWrite = viewer.hasPermission('tasks:write');
  const canRun = viewer.hasPermission('runs:write');
  const [tasks, setTasks] = useState<Task[] | null>(null);
  const confirm = useConfirm();
  const [error, setError] = useState<string | null>(null);
  const [name, setName] = useState('');
  const [goal, setGoal] = useState('');
  const [profile, setProfile] = useState('default');
  const [domains, setDomains] = useState('');
  const [confirmRisky, setConfirmRisky] = useState(false);
  const [editing, setEditing] = useState<string | null>(null);
  const [hostId, setHostId] = useState('');
  const [hostFallback, setHostFallback] = useState(true);
  const [hosts, setHosts] = useState<FleetHost[]>([]);
  const [policyId, setPolicyId] = useState<string | null>(null);
  const catalog = usePolicyCatalog();
  const canPickPolicy = viewer.hasPermission('agent_policies:read');

  const reset = () => {
    setEditing(null);
    setName('');
    setGoal('');
    setProfile('default');
    setDomains('');
    setConfirmRisky(false);
    setHostId('');
    setHostFallback(true);
    setPolicyId(null);
  };

  const edit = (t: Task) => {
    setEditing(t.id);
    setName(t.name);
    setGoal(t.goal);
    setProfile(t.profile);
    setDomains(t.allowedDomains.join(', '));
    setConfirmRisky(t.confirmRiskyActions);
    setHostId(t.hostId ?? '');
    setHostFallback(t.hostFallback);
    setPolicyId(t.policyId ?? null);
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

  // The machines to choose from; without fleet:read the picker offers "Any available machine" only.
  useEffect(() => {
    if (!viewer.hasPermission('fleet:read')) return;
    api
      .get<FleetHost[]>('/fleet/hosts')
      .then(setHosts)
      .catch(() => setHosts([]));
  }, [api, viewer]);

  const hostName = (id: string | null) => (id ? (hosts.find((h) => h.id === id)?.name ?? id.slice(0, 8)) : null);

  const create = async (event: FormEvent) => {
    event.preventDefault();
    setError(null);
    const body = {
      name: name.trim(),
      goal: goal.trim(),
      profile: profile.trim() || 'default',
      allowedDomains: domains.split(/[\s,]+/).map((d) => d.trim()).filter(Boolean),
      confirmRiskyActions: confirmRisky,
      hostId: hostId || null,
      hostFallback,
      // The agent policy replaces the earlier step, minute and model fields, which the form never sends.
      ...(canPickPolicy ? { policyId } : {}),
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

  const run = async (task: Task, runPolicyId?: string) => {
    try {
      const r = await runTaskWith(api, task.id, runPolicyId);
      navigate(`/runs/${r.id}`);
    } catch (e) {
      setError(message(e, 'Could not start the run'));
    }
  };

  /** Delete asks first: the task's schedules go with it. */
  const remove = async (task: Task) => {
    const ok = await confirm({
      title: `Delete task “${task.name}”?`,
      body: 'Its schedules are deleted. Its runs are kept.',
      confirmLabel: 'Delete',
      destructive: true,
    });
    if (!ok) return;
    try {
      await api.delete(`/tasks/${task.id}`);
      await load();
    } catch (e) {
      setError(message(e, 'Could not delete the task'));
    }
  };

  return (
    <PageContainer>
      <PageHeader title="Tasks" />
      <ErrorBanner error={error} />
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
              <Stack direction={{ xs: 'column', sm: 'row' }} spacing={2} sx={{ alignItems: { sm: 'center' } }}>
                <TextField
                  select
                  label="Machine"
                  value={hostId}
                  onChange={(e) => setHostId(e.target.value)}
                  helperText="Which computer runs it; any available one by default (home machines first)."
                  sx={{ minWidth: 260 }}
                >
                  <MenuItem value="">Any available machine</MenuItem>
                  {hosts.map((h) => (
                    <MenuItem key={h.id} value={h.id}>
                      {h.name} ({machineState(h)})
                    </MenuItem>
                  ))}
                  {hostId && !hosts.some((h) => h.id === hostId) && <MenuItem value={hostId}>{hostId.slice(0, 8)}</MenuItem>}
                </TextField>
                {hostId && (
                  <FormControlLabel
                    control={<Switch checked={hostFallback} onChange={(e) => setHostFallback(e.target.checked)} />}
                    label="If it is unavailable, use another available machine"
                  />
                )}
              </Stack>
              {hostId && hosts.some((h) => h.id === hostId && machineState(h) !== 'online') && (
                <Alert severity="warning">
                  {hostName(hostId)} is {machineState(hosts.find((h) => h.id === hostId)!)} right now.{' '}
                  {hostFallback ? 'Runs will use another available machine until it is back.' : 'Runs will fail until it is back.'}
                </Alert>
              )}
              {canPickPolicy && <PolicySelect catalog={catalog} value={policyId} onChange={setPolicyId} manageLink />}
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
      {tasks === null && !error && <CardSkeleton />}
      <Stack spacing={2} aria-label="Tasks">
        {(tasks ?? []).map((t) => {
          const chips = taskPolicyChips(t, catalog);
          return (
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
                <Chip size="small" label={`machine: ${hostName(t.hostId) ?? 'any available'}${t.hostId && !t.hostFallback ? ' only' : ''}`} />
                <Chip size="small" label={t.allowedDomains.length ? t.allowedDomains.join(', ') : 'any site'} />
                {chips && <Chip size="small" variant="outlined" label={`policy: ${chips.policy}`} />}
                {chips?.model && <Chip size="small" variant="outlined" label={`model: ${chips.model}`} />}
              </Stack>
              <TaskSchedules taskId={t.id} canWrite={canWrite} catalog={canPickPolicy ? catalog : undefined} taskPolicyId={t.policyId} />
            </CardContent>
            <CardActions>
              {canRun && <RunWithButton catalog={catalog} taskPolicyId={t.policyId} onRun={(p) => void run(t, p)} />}
              <Button onClick={() => navigate(`/runs?taskId=${t.id}`)}>Runs</Button>
              {canWrite && <Button onClick={() => edit(t)}>Edit</Button>}
              {canWrite && (
                <Button color="error" onClick={() => void remove(t)}>
                  Delete
                </Button>
              )}
            </CardActions>
          </Card>
          );
        })}
      </Stack>
    </PageContainer>
  );
}
