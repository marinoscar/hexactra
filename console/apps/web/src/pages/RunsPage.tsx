import { useEffect, useState } from 'react';
import AddIcon from '@mui/icons-material/Add';
import { Box, Link, Snackbar, Typography } from '@mui/material';
import { Link as RouterLink, useLocation, useNavigate, useSearchParams } from 'react-router-dom';
import { usePlatformHost } from '@marinoscar/platform-web/core';

import { NewRunDialog } from '../components/NewRunDialog';
import { RunList } from '../components/RunList';
import { TaskSpendLine } from '../components/RunBudgetMeter';
import type { TaskSpend } from '../components/runBudget';
import { PageContainer, PageHeader, aboveBottomBar } from '../ui';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * `/runs`: every run, filtered, searched and paged by the API (`GET /runs`,
 * `GET /runs/counts`), with select and bulk delete (`POST /runs/delete`). The
 * list itself is `RunList`; this page adds the header, "New run" (`POST /runs`)
 * and, on a task's view (`?taskId=`), that task's spend.
 */
export function RunsPage() {
  const { api, viewer } = usePlatformHost();
  const navigate = useNavigate();
  const location = useLocation();
  const [params] = useSearchParams();
  const taskId = params.get('taskId');
  const [creating, setCreating] = useState(false);
  /** The task's spend, on its runs view (#408). */
  const [spend, setSpend] = useState<{ name: string; spend30d?: TaskSpend } | null>(null);
  /** What another page says on arrival ("Run deleted", from the run page). */
  const [toast, setToast] = useState<string | null>(() => (location.state as { toast?: string } | null)?.toast ?? null);
  const canRun = viewer.hasPermission('runs:write');
  const canReadTasks = viewer.hasPermission('tasks:read');

  useEffect(() => {
    if (!taskId || !UUID.test(taskId) || !canReadTasks) return setSpend(null);
    let stale = false;
    api
      .get<{ name: string; spend30d?: TaskSpend }>(`/tasks/${encodeURIComponent(taskId)}`)
      .then((task) => {
        if (!stale) setSpend(task);
      })
      .catch(() => {
        if (!stale) setSpend(null);
      });
    return () => {
      stale = true;
    };
  }, [api, taskId, canReadTasks]);

  return (
    <PageContainer width="wide">
      <PageHeader title="Runs" primary={{ key: 'new', label: 'New run', Icon: AddIcon, onClick: () => setCreating(true), hidden: !canRun }} />
      {spend && taskId && (
        <Box sx={{ mb: 2 }}>
          <Typography variant="subtitle1" component="h2">
            <Link component={RouterLink} to={`/tasks/${taskId}`} underline="hover" color="inherit">
              {spend.name}
            </Link>
          </Typography>
          <TaskSpendLine spend={spend.spend30d} />
        </Box>
      )}
      <RunList showTaskColumn onNewRun={canRun ? () => setCreating(true) : undefined} />
      {canRun && <NewRunDialog open={creating} onClose={() => setCreating(false)} onStarted={(id) => navigate(`/runs/${id}`)} />}
      <Snackbar open={toast !== null} autoHideDuration={6000} onClose={() => setToast(null)} message={toast} sx={{ bottom: aboveBottomBar(24) }} />
    </PageContainer>
  );
}
