// The task page's read-only view of where a task's results go and which accounts it may use (E39.10, #607). The editor is the task form.
import { Box, Chip, Paper, Stack, Typography } from '@mui/material';
import { usePlatformHost } from '@marinoscar/platform-web/core';
import { useEffect, useState } from 'react';

import type { Connection } from '../connections/api';
import { listConnections } from '../connections/api';
import { ACCESS_WORDS, type ConnectionSelectionView } from '../taskConnections/model';
import { draftFromDelivery, KIND_ADD_LABEL, summarize, type TaskDelivery } from './drafts';

export function TaskDeliveriesSummary({ taskId, accounts, canReadRuns, canReadConnections, refreshKey }: { taskId: string; accounts: readonly ConnectionSelectionView[]; canReadRuns: boolean; canReadConnections: boolean; refreshKey?: string }) {
  const { api } = usePlatformHost();
  const [deliveries, setDeliveries] = useState<TaskDelivery[] | null>(null);
  const [connections, setConnections] = useState<Connection[]>([]);
  useEffect(() => {
    if (!canReadRuns) return;
    let stale = false;
    api
      .get<TaskDelivery[]>(`/tasks/${taskId}/deliveries`)
      .then((rows) => !stale && setDeliveries(Array.isArray(rows) ? rows : []))
      .catch(() => !stale && setDeliveries([]));
    return () => {
      stale = true;
    };
  }, [api, taskId, canReadRuns, refreshKey]);
  useEffect(() => {
    if (!canReadConnections) return;
    let stale = false;
    listConnections(api)
      .then((rows) => !stale && setConnections(rows))
      .catch(() => undefined);
    return () => {
      stale = true;
    };
  }, [api, canReadConnections]);
  if ((deliveries?.length ?? 0) === 0 && accounts.length === 0) return null;
  return (
    <Paper variant="outlined" sx={{ p: 2 }} data-testid="task-wiring">
      {accounts.length > 0 && (
        <Box sx={{ mb: deliveries && deliveries.length > 0 ? 2 : 0 }}>
          <Typography variant="subtitle2" component="h3">
            Accounts it may use
          </Typography>
          <Stack direction="row" spacing={0.5} useFlexGap sx={{ flexWrap: 'wrap', mt: 0.5 }}>
            {accounts.map((a) => (
              <Chip key={a.connectionId} size="small" color={a.status === 'active' ? 'default' : 'warning'} label={`${a.label}: ${a.status === 'active' ? ACCESS_WORDS[a.access].toLowerCase() : a.status === 'paused' ? 'paused' : 'needs reconnect'}`} />
            ))}
          </Stack>
        </Box>
      )}
      {deliveries && deliveries.length > 0 && (
        <Box>
          <Typography variant="subtitle2" component="h3">
            Sent when a run ends
          </Typography>
          <Stack component="ul" spacing={0.75} sx={{ m: 0, mt: 0.5, p: 0, listStyle: 'none' }}>
            {deliveries.map((d) => (
              <Box component="li" key={d.id} sx={{ display: 'flex', gap: 1, alignItems: 'baseline', flexWrap: 'wrap' }}>
                <Typography variant="body2" sx={{ overflowWrap: 'anywhere' }}>
                  {summarize(draftFromDelivery(d), connections)}
                </Typography>
                {!d.enabled && <Chip size="small" color="warning" variant="outlined" label="Switched off" />}
                <Chip size="small" variant="outlined" label={KIND_ADD_LABEL[d.kind]} />
              </Box>
            ))}
          </Stack>
        </Box>
      )}
    </Paper>
  );
}
