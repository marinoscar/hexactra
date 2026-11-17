import { useCallback, useEffect, useState } from 'react';
import ListAltOutlinedIcon from '@mui/icons-material/ListAltOutlined';
import { Box, Button, List, ListItemButton, ListItemText, Stack, TextField } from '@mui/material';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { usePlatformHost } from '@marinoscar/platform-web/core';

import type { Run } from '../types/runs';
import { EmptyState, ErrorBanner, ListSkeleton, PageContainer, PageHeader, StatusChip, formatDateTime, useProfileTimeZone } from '../ui';

/** `/runs`: recent runs. */
export function RunsPage() {
  const { api, viewer } = usePlatformHost();
  const navigate = useNavigate();
  const [params] = useSearchParams();
  const taskId = params.get('taskId');
  const [runs, setRuns] = useState<Run[] | null>(null);
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

  return (
    <PageContainer>
      <PageHeader title="Runs" />
      <ErrorBanner error={error} />
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
        {(runs ?? []).map((r) => (
          <ListItemButton key={r.id} onClick={() => navigate(`/runs/${r.id}`)} sx={{ gap: 1 }}>
            <ListItemText
              primary={r.goal}
              secondary={`${formatDateTime(r.createdAt)} · ${r.stepCount} steps · ${r.trigger === 'external' ? `driven by ${r.actor ?? 'an external agent'}` : r.trigger}`}
              sx={{ minWidth: 0, overflowWrap: 'anywhere' }}
            />
            <StatusChip status={r.status} stopReason={r.stopReason} />
          </ListItemButton>
        ))}
      </List>
    </PageContainer>
  );
}
