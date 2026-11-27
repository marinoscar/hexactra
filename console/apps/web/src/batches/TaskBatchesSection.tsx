import ExpandMoreIcon from '@mui/icons-material/ExpandMore';
import { Alert, Box, Button, Collapse, IconButton, Link, Paper, Stack, Typography } from '@mui/material';
import { usePlatformHost } from '@marinoscar/platform-web/core';
import { useCallback, useEffect, useId, useRef, useState } from 'react';
import { Link as RouterLink } from 'react-router-dom';

import { RelativeTime, StatusChip, useConfirm } from '../ui';
import { BatchRows } from './BatchRows';
import { BATCH_POLL_MS, batchChipStatus, isLiveBatch, stopReasonWords, type Batch, type BatchPage } from './model';

const WRAP = { overflowWrap: 'anywhere', wordBreak: 'break-word', minWidth: 0 } as const;
const PAGE = 10;

/** One batch: when, its summary and status; its rows (with **Open run**) unfold under it. */
function BatchEntry({ batch, defaultOpen, canWrite, onCancel }: { batch: Batch; defaultOpen: boolean; canWrite: boolean; onCancel: (b: Batch) => void }) {
  const [open, setOpen] = useState(defaultOpen);
  const bodyId = useId();
  const why = stopReasonWords(batch);
  return (
    <Paper variant="outlined" component="li" data-batch={batch.id} sx={{ p: 1.5, listStyle: 'none' }}>
      <Stack direction="row" spacing={1} sx={{ alignItems: 'center', minWidth: 0 }}>
        <Box sx={{ flex: 1, ...WRAP }}>
          <Typography variant="body2" sx={WRAP}>
            {batch.summary}
          </Typography>
          <Typography variant="caption" color="text.secondary">
            <RelativeTime iso={batch.createdAt} /> · {batch.total} rows
          </Typography>
        </Box>
        <StatusChip status={batchChipStatus(batch.status)} />
        <IconButton aria-label={open ? 'Hide the rows' : 'Show the rows'} aria-expanded={open} aria-controls={bodyId} onClick={() => setOpen((o) => !o)} sx={{ width: 44, height: 44 }}>
          <ExpandMoreIcon sx={{ transform: open ? 'rotate(180deg)' : 'none', transition: 'transform 150ms' }} />
        </IconButton>
      </Stack>
      <Collapse in={open} id={bodyId} unmountOnExit>
        <Box sx={{ mt: 1 }}>
          {why && (
            <Typography variant="body2" color="text.secondary" sx={{ mb: 0.5, ...WRAP }}>
              {why}
            </Typography>
          )}
          <BatchRows items={batch.items} showResult />
          <Stack direction="row" useFlexGap sx={{ mt: 1, flexWrap: 'wrap', gap: 1, alignItems: 'center' }}>
            <Link component={RouterLink} to={`/runs?batchId=${batch.id}`} variant="body2" sx={{ display: 'inline-flex', alignItems: 'center', minHeight: { xs: 44, md: 'auto' } }}>
              Open in Runs
            </Link>
            {canWrite && isLiveBatch(batch.status) && (
              <Button color="error" variant="outlined" size="small" onClick={() => onCancel(batch)} sx={{ minHeight: { xs: 44, md: 'auto' } }}>
                {batch.status === 'review' ? 'Cancel' : 'Stop'}
              </Button>
            )}
          </Stack>
        </Box>
      </Collapse>
    </Paper>
  );
}

/**
 * A task's batches (E51.1, #1006), newest first (`GET /tasks/{id}/batches`): when each ran, its summary and status, and its
 * rows with a link to each run. Read again every few seconds while one is live, and when `refreshKey` changes. Renders
 * nothing while the task has none.
 */
export function TaskBatchesSection({ taskId, refreshKey, openBatchId }: { taskId: string; refreshKey?: string | number; openBatchId?: string | null }) {
  const { api, viewer } = usePlatformHost();
  const confirm = useConfirm();
  const canWrite = viewer.hasPermission('runs:write');
  const headingId = useId();
  const [items, setItems] = useState<Batch[] | null>(null);
  const [cursor, setCursor] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  /** Older pages loaded with "Show older batches": a refresh reads the first page again and keeps them. */
  const loadedMore = useRef(false);
  const load = useCallback(async () => {
    try {
      const page = await api.get<BatchPage>(`/tasks/${encodeURIComponent(taskId)}/batches?limit=${PAGE}`);
      const oldest = page.items.at(-1)?.createdAt ?? null;
      setItems((prev) => (loadedMore.current && prev && oldest ? [...page.items, ...prev.filter((b) => b.createdAt < oldest && !page.items.some((p) => p.id === b.id))] : page.items));
      if (!loadedMore.current) setCursor(page.nextCursor);
      setError(null);
    } catch (e) {
      setError(e instanceof Error && e.message ? e.message : 'Could not load the batches');
    }
  }, [api, taskId]);

  useEffect(() => {
    void load();
  }, [load, refreshKey]);

  const live = (items ?? []).some((b) => isLiveBatch(b.status));
  useEffect(() => {
    if (!live) return;
    const timer = setInterval(() => {
      if (typeof document === 'undefined' || document.visibilityState !== 'hidden') void load();
    }, BATCH_POLL_MS);
    return () => clearInterval(timer);
  }, [live, load]);

  const more = async () => {
    if (!cursor) return;
    try {
      const page = await api.get<BatchPage>(`/tasks/${encodeURIComponent(taskId)}/batches?limit=${PAGE}&cursor=${encodeURIComponent(cursor)}`);
      loadedMore.current = true;
      setItems((prev) => [...(prev ?? []), ...page.items.filter((b) => !(prev ?? []).some((p) => p.id === b.id))]);
      setCursor(page.nextCursor);
    } catch (e) {
      setError(e instanceof Error && e.message ? e.message : 'Could not load more batches');
    }
  };

  const cancel = async (batch: Batch) => {
    const ok = await confirm(
      batch.status === 'review'
        ? { title: 'Cancel this batch?', body: 'None of its rows will run.', confirmLabel: 'Cancel the batch', cancelLabel: 'Keep it', destructive: true }
        : { title: 'Stop this batch?', body: `Stop ends this run and the ${batch.counts.pending} that have not started. What already happened is not undone.`, confirmLabel: 'Stop', destructive: true },
    );
    if (!ok) return;
    try {
      const next = await api.post<Batch>(`/batches/${encodeURIComponent(batch.id)}/cancel`, {});
      setItems((prev) => (prev ?? []).map((b) => (b.id === next.id ? next : b)));
    } catch (e) {
      setError(e instanceof Error && e.message ? e.message : 'Could not stop the batch');
    }
  };

  // No batches, or the list could not be read at all (an older console has no such route): the section is left out.
  if (!items?.length) return null;
  return (
    <Box component="section" id="batches" aria-labelledby={headingId} sx={{ scrollMarginTop: '72px', minWidth: 0 }}>
      <Typography variant="h6" component="h2" id={headingId} sx={{ mb: 1 }}>
        Batches
      </Typography>
      {error && (
        <Alert severity="error" sx={{ mb: 1, ...WRAP }} onClose={() => setError(null)}>
          {error}
        </Alert>
      )}
      <Stack component="ol" spacing={1} sx={{ m: 0, p: 0 }}>
        {(items ?? []).map((b, i) => (
          <BatchEntry key={b.id} batch={b} defaultOpen={b.id === openBatchId || (i === 0 && isLiveBatch(b.status))} canWrite={canWrite} onCancel={(x) => void cancel(x)} />
        ))}
      </Stack>
      {cursor && (
        <Button onClick={() => void more()} sx={{ mt: 1, minHeight: { xs: 44, md: 'auto' } }}>
          Show older batches
        </Button>
      )}
    </Box>
  );
}
