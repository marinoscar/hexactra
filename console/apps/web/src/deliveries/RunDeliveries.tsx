import { useCallback, useEffect, useRef, useState } from 'react';
import { Alert, Box, Button, Chip, Stack, Typography } from '@mui/material';
import { usePlatformHost } from '@marinoscar/platform-web/core';

import { getFile } from '../connections/files';
import { RelativeTime, toast } from '../ui';
import { canRetry, destinationLabel, detailLine, isMoving, linkTarget, statusColor, statusLabel, type DeliveryDestination, type RunDelivery } from './model';

export interface RunDeliveriesProps {
  runId: string;
  /** Only an owner who may start and stop runs may retry a delivery. */
  canRetryDelivery?: boolean;
  /** How often to look again while a delivery is still moving. */
  pollMs?: number;
  /** The run's task: its deliveries name where each log row went, and where a file or folder opens. */
  taskId?: string | null;
  /** `connections:read`: a sent spreadsheet or folder can be opened at the provider. */
  canOpenLinks?: boolean;
}

/**
 * "Deliveries" on the run page (E39.6, #603): what was sent when the run ended (an email, a spreadsheet row, files, a webhook) with each
 * one's status and the reason it failed (a fixed sentence), and a Retry for one that failed. Nothing for a run without deliveries, and
 * nothing when the deployment has none. It looks again while one is still moving.
 */
export function RunDeliveries({ runId, canRetryDelivery = false, pollMs = 4_000, taskId = null, canOpenLinks = false }: RunDeliveriesProps) {
  const { api } = usePlatformHost();
  const [rows, setRows] = useState<RunDelivery[]>([]);
  const [busy, setBusy] = useState<string | null>(null);
  const [destinations, setDestinations] = useState<Map<string, DeliveryDestination>>(new Map());
  const alive = useRef(true);

  const load = useCallback(async () => {
    try {
      const got = await api.get<RunDelivery[]>(`/runs/${runId}/deliveries`);
      if (alive.current && Array.isArray(got)) setRows(got);
    } catch {
      // No deliveries on this deployment, or no permission: nothing to show.
    }
  }, [api, runId]);

  useEffect(() => {
    alive.current = true;
    void load();
    return () => {
      alive.current = false;
    };
  }, [load]);

  // Where each delivery goes, from the task's own list (the log holds no address or file name). A task that cannot be read leaves the kinds.
  useEffect(() => {
    if (!taskId) return;
    let stale = false;
    api
      .get<DeliveryDestination[]>(`/tasks/${taskId}/deliveries`)
      .then((list) => !stale && Array.isArray(list) && setDestinations(new Map(list.map((d) => [d.id, d]))))
      .catch(() => undefined);
    return () => {
      stale = true;
    };
  }, [api, taskId]);

  const open = async (target: { connectionId: string; fileId: string }) => {
    try {
      const f = await getFile(api, target.connectionId, target.fileId);
      if (f.webUrl) window.open(f.webUrl, '_blank', 'noopener,noreferrer');
      else toast('The provider has no address to open it at.', 'warning');
    } catch {
      toast('Could not open it. It may have been moved or deleted.', 'error');
    }
  };

  const moving = isMoving(rows);
  useEffect(() => {
    if (!moving) return;
    const t = setInterval(() => void load(), pollMs);
    return () => clearInterval(t);
  }, [moving, load, pollMs]);

  const retry = async (r: RunDelivery) => {
    setBusy(r.id);
    try {
      await api.post(`/runs/${runId}/deliveries/${r.id}/retry`, {});
      await load();
    } catch {
      toast('Could not retry that delivery.', 'error');
    } finally {
      setBusy(null);
    }
  };

  if (rows.length === 0) return null;
  const failed = rows.filter((r) => r.status === 'failed').length;
  return (
    <Box component="section" aria-label="Deliveries" data-testid="run-deliveries" sx={{ my: 2 }}>
      <Typography variant="subtitle2" component="h2" sx={{ mb: 0.5 }}>
        Deliveries
      </Typography>
      {failed > 0 && (
        <Alert severity="warning" sx={{ mb: 1 }}>
          {failed === 1 ? 'One delivery' : `${failed} deliveries`} could not be sent. The run itself is not affected.
        </Alert>
      )}
      <Stack component="ul" spacing={1} sx={{ listStyle: 'none', m: 0, p: 0 }}>
        {rows.map((r) => {
          const line = detailLine(r);
          const dest = r.deliveryId ? destinations.get(r.deliveryId) : undefined;
          const link = canOpenLinks ? linkTarget(r, dest) : null;
          return (
            <Box component="li" key={r.id} data-testid="run-delivery" sx={{ display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: 1 }}>
              <Typography variant="body2" sx={{ minWidth: 140 }}>
                {destinationLabel(r, dest)}
              </Typography>
              <Chip size="small" color={statusColor(r.status)} variant="outlined" label={statusLabel(r.status)} />
              {line && (
                <Typography variant="body2" color="text.secondary" sx={{ overflowWrap: 'anywhere' }}>
                  {line}
                </Typography>
              )}
              <Typography variant="caption" color="text.secondary">
                <RelativeTime iso={r.sentAt ?? r.createdAt} />
              </Typography>
              {link && (
                <Button size="small" onClick={() => void open(link)} sx={{ minHeight: { xs: 44, sm: 'auto' } }}>
                  {link.what === 'spreadsheet' ? 'Open the spreadsheet' : 'Open the folder'}
                </Button>
              )}
              {canRetryDelivery && canRetry(r) && (
                <Button size="small" variant="outlined" disabled={busy === r.id} onClick={() => void retry(r)} sx={{ minHeight: { xs: 44, sm: 'auto' } }}>
                  {busy === r.id ? 'Retrying…' : 'Retry'}
                </Button>
              )}
            </Box>
          );
        })}
      </Stack>
    </Box>
  );
}
