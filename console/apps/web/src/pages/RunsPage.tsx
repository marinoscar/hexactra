import { useCallback, useEffect, useState } from 'react';
import ListAltOutlinedIcon from '@mui/icons-material/ListAltOutlined';
import { Box, Button, Chip, List, ListItemButton, ListItemText, Stack, TextField, Typography } from '@mui/material';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { usePlatformHost } from '@marinoscar/platform-web/core';

import { TaskSpendLine } from '../components/RunBudgetMeter';
import { runCost, stopChipLabel, type TaskSpend } from '../components/runBudget';
import type { Run } from '../types/runs';
import { EmptyState, ErrorBanner, ListSkeleton, PageContainer, PageHeader, StatusChip, formatDateTime, useProfileTimeZone } from '../ui';

/** `/runs`: recent runs. */
export function RunsPage() {
  const { api, viewer } = usePlatformHost();
  const navigate = useNavigate();
  const [params] = useSearchParams();
  const taskId = params.get('taskId');
  const [runs, setRuns] = useState<Run[] | null>(null);
  /** The task's spend, on its runs view (#408). */
  const [spend, setSpend] = useState<{ name: string; spend30d?: TaskSpend } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [goal, setGoal] = useState('');
  const [profile, setProfile] = useState('default');
  const canRun = viewer.hasPermission('runs:write');
  useProfileTimeZone();

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
    <PageContainer>
      <PageHeader title="Runs" />
      <ErrorBanner error={error} />
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
      {runs === null && !error && <ListSkeleton />}
      {runs?.length === 0 && !error && <EmptyState Icon={ListAltOutlinedIcon} title="No runs yet" body="Run a goal above, or start one from Tasks." />}
      <List aria-label="Runs">
        {(runs ?? []).map((r) => {
          const cost = runCost(r);
          const stop = stopChipLabel(r.stopReason);
          return (
            <ListItemButton key={r.id} onClick={() => navigate(`/runs/${r.id}`)} data-testid={`run-row-${r.id}`}>
              <ListItemText
                primary={r.goal}
                secondary={`${formatDateTime(r.createdAt)} · ${r.stepCount} steps · ${r.trigger === 'external' ? `driven by ${r.actor ?? 'an external agent'}` : r.trigger}`}
                sx={{ minWidth: 0, overflowWrap: 'anywhere' }}
              />
              {/* The cost: a column from sm up, a chip on a phone (#408). */}
              <Typography variant="body2" color="text.secondary" sx={{ display: { xs: 'none', sm: 'block' }, minWidth: 72, textAlign: 'right', mx: 1, fontVariantNumeric: 'tabular-nums' }} data-testid="run-cost">
                {cost ?? '—'}
              </Typography>
              <Stack direction={{ xs: 'column', sm: 'row' }} spacing={0.5} sx={{ alignItems: { xs: 'flex-end', sm: 'center' }, justifyContent: 'flex-end', ml: 1, minWidth: { sm: 190 }, flexShrink: 0 }}>
                {cost && <Chip size="small" variant="outlined" label={cost} sx={{ display: { xs: 'inline-flex', sm: 'none' } }} />}
                {/* #408's stop-reason chip says why; the status chip keeps to the status, so the reason is not said twice. */}
                {stop && <Chip size="small" variant="outlined" color={r.stopReason === 'error' || r.stopReason === 'no_model' ? 'error' : 'warning'} label={stop} data-testid="run-stop" />}
                <StatusChip status={r.status} />
              </Stack>
            </ListItemButton>
          );
        })}
      </List>
    </PageContainer>
  );
}
