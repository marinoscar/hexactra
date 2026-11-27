import PlaylistPlayIcon from '@mui/icons-material/PlaylistPlay';
import { Alert, Box, Button, Checkbox, FormControlLabel, Paper, Stack, Typography } from '@mui/material';
import { usePlatformHost } from '@marinoscar/platform-web/core';
import { useCallback, useEffect, useState } from 'react';

import { BrowserCard } from '../components/ChatBrowser';
import type { ThreadCards } from '../components/ChatMessages';
import type { ChatMessage } from '../types/chat';
import { StatusChip, useConfirm } from '../ui';
import { BatchRows } from './BatchRows';
import { BATCH_POLL_MS, batchChipStatus, isLiveBatch, stopReasonWords, valuesLine, type Batch } from './model';

const CARD_MAX = { xs: '100%', sm: 480 } as const;
const WRAP = { overflowWrap: 'anywhere', wordBreak: 'break-word', minWidth: 0 } as const;
const TAP = { minHeight: { xs: 44, sm: 36 }, borderRadius: 3 } as const;

/** The batch id a `batch` (or a batch summary) message carries, or null. */
export function batchIdOf(message: Pick<ChatMessage, 'meta'>): string | null {
  const id = (message.meta as { batchId?: unknown } | null)?.batchId;
  return typeof id === 'string' && id ? id : null;
}

/** A chat's batch summary (`kind: result`, `meta.batchSummary`): the API's one message at a batch's end. */
export function isBatchSummary(message: Pick<ChatMessage, 'kind' | 'meta'>): boolean {
  return message.kind === 'result' && (message.meta as { batchSummary?: unknown } | null)?.batchSummary === true;
}

/** The batch's end in the thread: its summary as plain text (the rows and their runs are on the batch card above). */
export function BatchSummaryCard({ message }: { message: ChatMessage }) {
  const status = (message.meta as { status?: unknown } | null)?.status;
  return (
    <Paper variant="outlined" component="article" aria-label="Batch result" sx={{ p: 1.5, width: '100%', maxWidth: CARD_MAX, borderRadius: 3, bgcolor: 'background.paper' }}>
      <Stack direction="row" spacing={1} sx={{ alignItems: 'center', mb: 0.5 }}>
        <Typography variant="subtitle2" component="p" sx={{ flex: 1, ...WRAP }}>
          Batch finished
        </Typography>
        {typeof status === 'string' && <StatusChip status={batchChipStatus(status)} />}
      </Stack>
      <Typography variant="body1" sx={{ whiteSpace: 'pre-wrap', ...WRAP }}>
        {message.text}
      </Typography>
    </Paper>
  );
}

export interface BatchCardProps {
  message: ChatMessage;
  /** The thread's run card props: the live row's Browser card is the one the `run` message renders. */
  cards?: ThreadCards;
}

/**
 * A chat's batch (E51.1, #1006). In `review`: one line per row with a checkbox (ticked), **Start N runs** with the ticked rows
 * and **Cancel**; nothing runs before Start, and it is the owner's act. Once running: each row's status, the live run's Browser
 * card, **Stop** (the live run and the rows not started); at the end the summary and **Open run** per row.
 */
export function BatchCard({ message, cards }: BatchCardProps) {
  const { api, viewer } = usePlatformHost();
  const confirm = useConfirm();
  const canWrite = viewer.hasPermission('runs:write');
  const batchId = batchIdOf(message);
  const [batch, setBatch] = useState<Batch | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<'start' | 'cancel' | null>(null);
  /** The rows left unticked at review (all ticked to begin with). */
  const [unticked, setUnticked] = useState<ReadonlySet<number>>(new Set());

  const load = useCallback(async () => {
    if (!batchId) return;
    try {
      setBatch(await api.get<Batch>(`/batches/${encodeURIComponent(batchId)}`));
    } catch (e) {
      setError(e instanceof Error && e.message ? e.message : 'Could not load the batch');
    }
  }, [api, batchId]);
  useEffect(() => {
    void load();
  }, [load]);

  // A live batch is read again every few seconds, and whenever the chat's run changes.
  const live = batch !== null && isLiveBatch(batch.status);
  useEffect(() => {
    if (!live) return;
    const timer = setInterval(() => {
      if (typeof document === 'undefined' || document.visibilityState !== 'hidden') void load();
    }, BATCH_POLL_MS);
    return () => clearInterval(timer);
  }, [live, load]);
  const chatRunKey = cards?.run ? `${cards.run.id}:${cards.run.status}` : '';
  useEffect(() => {
    if (live && chatRunKey) void load();
  }, [chatRunKey, live, load]);

  if (!batchId) return null;
  const title = batch?.taskName || message.text || 'A batch of runs';
  const ticked = batch ? batch.items.filter((i) => !unticked.has(i.seq)).map((i) => i.seq) : [];

  const act = async (kind: 'start' | 'cancel') => {
    if (!batch) return;
    if (kind === 'cancel' && batch.status === 'running') {
      const ok = await confirm({ title: 'Stop this batch?', body: `Stop ends this run and the ${batch.counts.pending} that have not started. What already happened is not undone.`, confirmLabel: 'Stop', destructive: true });
      if (!ok) return;
    }
    setBusy(kind);
    setError(null);
    try {
      const id = encodeURIComponent(batch.id);
      setBatch(kind === 'start' ? await api.post<Batch>(`/batches/${id}/start`, { rows: ticked }) : await api.post<Batch>(`/batches/${id}/cancel`, {}));
    } catch (e) {
      setError(e instanceof Error && e.message ? e.message : kind === 'start' ? 'Could not start the runs' : 'Could not cancel the batch');
      void load();
    } finally {
      setBusy(null);
    }
  };

  const liveItem = batch?.status === 'running' ? batch.items.find((i) => i.status === 'running' && i.runId) : undefined;
  const runMessage: ChatMessage | null = liveItem?.runId ? { ...message, kind: 'run', runId: liveItem.runId, text: cards?.run?.id === liveItem.runId ? cards.run.goal : valuesLine(liveItem), meta: null } : null;
  const why = batch ? stopReasonWords(batch) : null;

  return (
    <Stack spacing={1} sx={{ width: '100%', maxWidth: CARD_MAX, alignItems: 'stretch' }}>
      <Paper variant="outlined" component="article" aria-label="Batch" data-batch={batchId} data-status={batch?.status} sx={{ p: 1.5, borderRadius: 3, bgcolor: 'background.paper' }}>
        <Stack direction="row" spacing={1} sx={{ alignItems: 'center', mb: 1 }}>
          <PlaylistPlayIcon fontSize="small" color="primary" aria-hidden />
          <Typography variant="subtitle2" component="p" sx={{ flex: 1, ...WRAP }}>
            {title}
          </Typography>
          {batch && <StatusChip status={batchChipStatus(batch.status)} />}
        </Stack>
        {error && (
          <Alert severity="error" sx={{ mb: 1, ...WRAP }} onClose={() => setError(null)}>
            {error}
          </Alert>
        )}
        {!batch && !error && (
          <Typography variant="body2" color="text.secondary" role="status">
            Loading the rows…
          </Typography>
        )}
        {batch?.status === 'review' && (
          <>
            <Typography variant="body2" color="text.secondary" sx={{ mb: 0.5 }}>
              Nothing starts until you press Start. Untick a row to leave it out.
            </Typography>
            <Box component="ol" aria-label="Rows to run" sx={{ listStyle: 'none', m: 0, p: 0 }}>
              {batch.items.map((item) => (
                <Box component="li" key={item.seq} sx={{ borderTop: 1, borderColor: 'divider', '&:first-of-type': { borderTop: 0 } }}>
                  <FormControlLabel
                    sx={{ alignItems: 'flex-start', mx: 0, py: 0.25, width: '100%', ...WRAP }}
                    control={
                      <Checkbox
                        checked={!unticked.has(item.seq)}
                        disabled={!canWrite || busy !== null}
                        onChange={(e) =>
                          setUnticked((prev) => {
                            const next = new Set(prev);
                            if (e.target.checked) next.delete(item.seq);
                            else next.add(item.seq);
                            return next;
                          })
                        }
                        slotProps={{ input: { 'aria-label': `Row ${item.seq}` } }}
                        sx={{ mt: -0.5 }}
                      />
                    }
                    label={
                      <Typography variant="body2" sx={{ pt: 0.5, ...WRAP }}>
                        {valuesLine(item)}
                      </Typography>
                    }
                  />
                </Box>
              ))}
            </Box>
            <Stack direction={{ xs: 'column', sm: 'row' }} spacing={1} sx={{ mt: 1 }}>
              <Button variant="contained" disabled={!canWrite || ticked.length === 0 || busy !== null} onClick={() => void act('start')} sx={TAP}>
                {busy === 'start' ? 'Starting…' : `Start ${ticked.length} ${ticked.length === 1 ? 'run' : 'runs'}`}
              </Button>
              <Button variant="outlined" disabled={!canWrite || busy !== null} onClick={() => void act('cancel')} sx={TAP}>
                Cancel
              </Button>
            </Stack>
          </>
        )}
        {batch && batch.status !== 'review' && (
          <>
            <BatchRows items={batch.items} showResult={!live} />
            {batch.status === 'running' && canWrite && (
              <Box sx={{ mt: 1 }}>
                <Typography variant="body2" color="text.secondary" sx={{ mb: 0.5 }}>
                  {`Stop ends this run and the ${batch.counts.pending} that have not started.`}
                </Typography>
                <Button variant="outlined" color="error" disabled={busy !== null} onClick={() => void act('cancel')} sx={TAP}>
                  {busy === 'cancel' ? 'Stopping…' : 'Stop'}
                </Button>
              </Box>
            )}
            {!live && (
              <Box role="status" sx={{ mt: 1 }}>
                <Typography variant="body1" sx={WRAP}>
                  {batch.summary}
                </Typography>
                {why && (
                  <Typography variant="body2" color="text.secondary" sx={WRAP}>
                    {why}
                  </Typography>
                )}
              </Box>
            )}
          </>
        )}
      </Paper>
      {runMessage && cards && (
        <BrowserCard
          message={runMessage}
          run={cards.run && cards.run.id === runMessage.runId ? cards.run : null}
          frame={cards.frame}
          frameHidden={cards.frameHidden}
          now={cards.now}
          paneOpen={cards.paneOpen}
          onOpen={cards.onOpenBrowser}
          onResume={cards.onResumeRun}
          onVisible={cards.onCardVisible}
        />
      )}
    </Stack>
  );
}
