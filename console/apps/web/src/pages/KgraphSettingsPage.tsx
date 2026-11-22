import { Alert, Box, Button, FormControlLabel, Link, Paper, Stack, Switch, Typography } from '@mui/material';
import { usePlatformHost } from '@marinoscar/platform-web/core';
import { useCallback, useEffect, useState } from 'react';
import { Link as RouterLink } from 'react-router-dom';

import { getKgStatus, purgeKgraph, setKgEverydaySwitch, setKgUserSwitch, type KgStatus } from '../kgraph/api';
import { useKgraphStatus } from '../kgraph/KgraphStatusProvider';
import { everydayDisabledReason } from '../kgraph/labels';
import { CardSkeleton, ErrorBanner, PageContainer, PageHeader, toast, useApiAction, useConfirm } from '../ui';

/**
 * `/settings/kgraph` (E46.20): the owner's own Knowledge Graph switch (`kgraph.enabled` of the user settings, off by default), a link
 * to what was learned, and Delete everything learned (`DELETE /api/kgraph`) behind a confirmation. Turning the switch off deletes
 * nothing; the delete does. Changing needs `kgraph:write`. E46.29: "Use in chats and one-off runs" (`kgraph.everyday`), disabled with
 * the reason while the user or the deployment switch is off.
 */
export function KgraphSettingsPage() {
  const { api, viewer } = usePlatformHost();
  const confirm = useConfirm();
  const action = useApiAction();
  const shell = useKgraphStatus();
  const canWrite = viewer.hasPermission('kgraph:write');
  const [status, setStatus] = useState<KgStatus | null>(null);
  const { setError } = action;

  const load = useCallback(async () => {
    try {
      setStatus(await getKgStatus(api));
    } catch (e) {
      setError(e instanceof Error && e.message ? e.message : 'Could not load the Knowledge Graph settings');
    }
  }, [api, setError]);
  useEffect(() => {
    void load();
  }, [load]);

  const toggle = async (enabled: boolean) => {
    const done = await action.run('switch', () => setKgUserSwitch(api, enabled), 'Could not change the setting');
    if (done === undefined) return;
    toast(enabled ? 'Knowledge Graph turned on' : 'Knowledge Graph turned off; nothing was deleted');
    await load();
    await shell.refresh();
  };

  const toggleEveryday = async (everyday: boolean) => {
    const done = await action.run('everyday', () => setKgEverydaySwitch(api, everyday), 'Could not change the setting');
    if (done === undefined) return;
    toast(everyday ? 'Saved procedures are now offered in chats and one-off runs' : 'Saved procedures are no longer offered in chats and one-off runs');
    await load();
    await shell.refresh();
  };

  const purge = async () => {
    const ok = await confirm({
      title: 'Delete everything learned?',
      body: 'Every procedure, version, review and run record of yours is deleted, and every task goes back to AI only. Your tasks and runs stay. This cannot be undone.',
      confirmLabel: 'Delete everything',
      destructive: true,
      requireText: 'delete',
    });
    if (!ok) return;
    const res = await action.run('purge', () => purgeKgraph(api), 'Could not delete what was learned');
    if (res) toast(`Deleted ${res.deleted.procedures ?? 0} procedure${res.deleted.procedures === 1 ? '' : 's'} and everything learned with them`);
  };

  return (
    <PageContainer width="narrow">
      <PageHeader title="Knowledge Graph" subtitle="Let your saved tasks learn their steps from their runs, so later runs can repeat them without the model." back={{ to: '/settings', label: 'Settings' }} />
      <ErrorBanner error={action.error} onClose={action.clearError} />
      {!status && !action.error && <CardSkeleton />}
      {status && (
        <Stack spacing={2}>
          <Paper variant="outlined" sx={{ p: { xs: 2, sm: 3 } }}>
            <FormControlLabel
              control={<Switch checked={status.user} disabled={!canWrite || action.busy !== null} onChange={(e) => void toggle(e.target.checked)} />}
              label="Use the Knowledge Graph for my saved tasks"
              sx={{ minHeight: 44 }}
            />
            <Typography variant="body2" color="text.secondary" sx={{ mt: 1 }}>
              Off by default. Each task still chooses AI only, Learn only or Learn and reuse on its own page. Turning this off keeps everything learned, unused.
            </Typography>
            {!status.deployment && (
              <Alert severity="info" sx={{ mt: 2 }}>
                Your administrator has not allowed the Knowledge Graph on this console, so it does nothing even when your switch is on. Nothing learned was deleted.
              </Alert>
            )}
            <Box sx={{ mt: 2, pt: 2, borderTop: 1, borderColor: 'divider' }}>
              <FormControlLabel
                control={<Switch checked={status.everyday} disabled={!canWrite || action.busy !== null || everydayDisabledReason(status) !== null} onChange={(e) => void toggleEveryday(e.target.checked)} />}
                label="Use in chats and one-off runs"
                sx={{ minHeight: 44 }}
              />
              <Typography variant="body2" color="text.secondary" sx={{ mt: 1 }}>
                Offers your learned procedures to chats and one-off runs when they fit the goal; you still approve anything sensitive.
              </Typography>
              {everydayDisabledReason(status) && (
                <Typography variant="body2" color="text.secondary" sx={{ mt: 1 }} data-testid="kgraph-everyday-reason">
                  {everydayDisabledReason(status)}
                </Typography>
              )}
            </Box>
            <Typography variant="body2" sx={{ mt: 2 }}>
              <Link component={RouterLink} to="/kgraph">
                See what was learned
              </Link>
            </Typography>
          </Paper>
          {canWrite && (
            <Paper variant="outlined" sx={{ p: { xs: 2, sm: 3 }, borderColor: 'error.main' }}>
              <Typography variant="subtitle1" component="h2" sx={{ fontWeight: 500 }}>
                Delete everything learned
              </Typography>
              <Typography variant="body2" color="text.secondary" sx={{ mb: 1.5 }}>
                Removes your procedures, their versions and history, reviews and run records. Nobody else&apos;s.
              </Typography>
              <Box>
                <Button color="error" variant="outlined" sx={{ minHeight: 44 }} disabled={action.busy !== null} onClick={() => void purge()}>
                  Delete everything learned
                </Button>
              </Box>
            </Paper>
          )}
        </Stack>
      )}
    </PageContainer>
  );
}
