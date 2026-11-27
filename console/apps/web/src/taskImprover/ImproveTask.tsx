import { Box, Button, Link, List, ListItem, Stack, Typography } from '@mui/material';
import { usePlatformHost } from '@marinoscar/platform-web/core';
import { useEffect, useState } from 'react';
import { Link as RouterLink, useNavigate } from 'react-router-dom';

import { formatDateTime, toast } from '../ui';
import { listImprovements, improvementPath, startImprovement, type Improvement } from './api';

/**
 * **Improve this task** (E52.9): asks for a proposal and opens it. A 409 (one is being made) opens that one. Hidden without
 * `tasks:write`; disabled, with the reason, before the task has a finished run. A deployment with the feature off answers 404: the
 * button then says so once.
 */
export function ImproveTaskButton({ taskId, runIds, hasFinishedRun = true, label = 'Improve this task', variant = 'outlined' }: { taskId: string; runIds?: string[]; hasFinishedRun?: boolean; label?: string; variant?: 'outlined' | 'text' }) {
  const { api, viewer } = usePlatformHost();
  const navigate = useNavigate();
  const [busy, setBusy] = useState(false);
  if (!viewer.hasPermission('tasks:write')) return null;
  const go = async () => {
    setBusy(true);
    try {
      navigate(improvementPath(taskId, await startImprovement(api, taskId, runIds)));
    } catch (e) {
      toast(e instanceof Error && e.message ? e.message : 'Could not start the proposal', 'error');
    } finally {
      setBusy(false);
    }
  };
  return (
    <Button size="small" variant={variant} disabled={busy || !hasFinishedRun} onClick={() => void go()} title={hasFinishedRun ? undefined : 'Run the task once first: proposals learn from finished runs'}>
      {busy ? 'Starting…' : label}
    </Button>
  );
}

const STATUS: Record<Improvement['status'], string> = { queued: 'Waiting', running: 'Being made', ready: 'Ready to review', failed: 'Failed', applied: 'Applied', dismissed: 'Dismissed' };

/** The task page's **Improvements** (E52.9): its proposals, newest first, each linking to its page. Nothing without any. */
export function TaskImprovements({ taskId, refreshKey }: { taskId: string; refreshKey?: string }) {
  const { api } = usePlatformHost();
  const [items, setItems] = useState<Improvement[] | null>(null);
  useEffect(() => {
    let live = true;
    listImprovements(api, taskId)
      .then((r) => live && setItems(r.items))
      .catch(() => live && setItems(null));
    return () => {
      live = false;
    };
  }, [api, taskId, refreshKey]);
  if (!items || items.length === 0) return null;
  return (
    <Box component="section" aria-label="Improvements" data-testid="task-improvements">
      <Typography variant="subtitle2" component="h2" gutterBottom>
        Improvements
      </Typography>
      <List dense disablePadding>
        {items.slice(0, 5).map((i) => (
          <ListItem key={i.id} disableGutters>
            <Stack direction="row" spacing={1} useFlexGap sx={{ flexWrap: 'wrap', alignItems: 'baseline' }}>
              <Link component={RouterLink} to={improvementPath(taskId, i.id)} variant="body2">
                {STATUS[i.status]}
              </Link>
              <Typography variant="caption" color="text.secondary">
                {formatDateTime(i.createdAt)} · {i.runIds.length} {i.runIds.length === 1 ? 'run' : 'runs'} read
              </Typography>
            </Stack>
          </ListItem>
        ))}
      </List>
    </Box>
  );
}
