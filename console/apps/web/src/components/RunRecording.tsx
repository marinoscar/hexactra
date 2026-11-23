import { useCallback, useEffect, useRef, useState } from 'react';
import { Alert, Box, Button, Chip, Paper, Stack, Typography } from '@mui/material';
import DeleteOutlinedIcon from '@mui/icons-material/DeleteOutlined';
import { usePlatformHost } from '@marinoscar/platform-web/core';

import { formatDateTime, toast, useConfirm } from '../ui';

/** `GET /api/runs/:id/recording` (epic #755). */
export interface RunRecordingView {
  status: 'recording' | 'processing' | 'ready' | 'failed';
  bytes: number;
  durationMs: number;
  mime: string;
  droppedFrames: number;
  note: string | null;
  startedAt: string;
  endedAt: string | null;
  expiresAt: string | null;
  masked: false;
}

/** The card's anchor: `/runs/:id#recording` opens the run page at the video. */
export const RECORDING_ANCHOR = 'recording';

const NOTES: Record<string, string> = {
  max_minutes: 'It stopped at the longest length your administrator allows; the run went on.',
  tab_closed: 'It ended when the tab it recorded was closed.',
  detached: 'It ended when the browser stopped sharing the tab.',
  restarted: 'The browser restarted during the run, so the video skips that moment.',
  encoder_unavailable: "This browser can't record video.",
  encoder_failed: 'The browser stopped recording part-way.',
  storage_error: 'Part of the video could not be saved.',
  empty: 'Nothing was recorded.',
  node_outdated: "The browser node that ran this can't record video yet: its agent or extension is older than this console. On that machine run `hexactra agent update`, then restart its browser (or wait for Chrome to update the extension), and run again.",
  start_failed: 'The browser node did not start recording. If this repeats, run `hexactra agent update` on the node and restart its browser.',
  unreadable: 'The recorded video could not be read.',
  no_storage: 'This console has no file storage, so the video could not be saved.',
};

const STATUS: Record<RunRecordingView['status'], { label: string; tone: 'info' | 'success' | 'error' }> = {
  recording: { label: 'Recording', tone: 'info' },
  processing: { label: 'Preparing the video', tone: 'info' },
  ready: { label: 'Ready', tone: 'success' },
  failed: { label: 'No video', tone: 'error' },
};

function duration(ms: number): string {
  const s = Math.round(ms / 1000);
  return s < 60 ? `${s} s` : `${Math.floor(s / 60)} min ${s % 60} s`;
}

function size(bytes: number): string {
  return bytes >= 1_000_000 ? `${(bytes / 1_000_000).toFixed(1)} MB` : `${Math.max(1, Math.round(bytes / 1000))} kB`;
}

export interface RunRecordingProps {
  runId: string;
  /** `runs:delete`: the owner may delete the video. */
  canDelete?: boolean;
  /** How often to look again while the video is not ready. */
  pollMs?: number;
}

/**
 * "Recording" on the run page (epic #755): the video of a run its owner chose to record, its status, the date it will be deleted, and
 * Delete. Nothing for a run without a recording. The video is NOT masked, and the card says so. It plays through a 15-minute signed link
 * (the browser's video player cannot send the session's token), fetched again when it runs out.
 */
export function RunRecording({ runId, canDelete = false, pollMs = 5_000 }: RunRecordingProps) {
  const { api } = usePlatformHost();
  const confirm = useConfirm();
  const [rec, setRec] = useState<RunRecordingView | null>(null);
  const [src, setSrc] = useState<string | null>(null);
  const [deleting, setDeleting] = useState(false);
  const alive = useRef(true);

  const load = useCallback(async () => {
    try {
      const got = await api.get<RunRecordingView>(`/runs/${runId}/recording`);
      if (alive.current) setRec(got);
      return got;
    } catch {
      // No recording (the run was not recorded), or no permission: nothing to show.
      if (alive.current) setRec(null);
      return null;
    }
  }, [api, runId]);

  const link = useCallback(async () => {
    try {
      const got = await api.post<{ url: string }>(`/runs/${runId}/recording/link`, {});
      if (alive.current) setSrc(got.url);
    } catch {
      if (alive.current) setSrc(null);
    }
  }, [api, runId]);

  useEffect(() => {
    alive.current = true;
    void load();
    return () => {
      alive.current = false;
    };
  }, [load]);

  // While it records or is being prepared, look again.
  useEffect(() => {
    if (!rec || rec.status === 'ready' || rec.status === 'failed') return;
    const t = setTimeout(() => void load(), pollMs);
    return () => clearTimeout(t);
  }, [rec, load, pollMs]);

  useEffect(() => {
    if (rec?.status === 'ready' && !src) void link();
  }, [rec?.status, src, link]);

  // `/runs/:id#recording` (the benchmark trial list's "Recording" link, #846): once the card is there, bring it into view, once.
  const card = useRef<HTMLElement | null>(null);
  const scrolled = useRef(false);
  const hasCard = rec !== null;
  useEffect(() => {
    if (!hasCard || scrolled.current || window.location.hash !== `#${RECORDING_ANCHOR}`) return;
    scrolled.current = true;
    card.current?.scrollIntoView?.({ block: 'start' });
  }, [hasCard]);

  if (!rec) return null;

  const remove = async () => {
    const ok = await confirm({ title: 'Delete this video?', body: 'The run and its steps stay. The video cannot be recovered.', confirmLabel: 'Delete video', destructive: true });
    if (!ok) return;
    setDeleting(true);
    try {
      await api.delete(`/runs/${runId}/recording`);
      setRec(null);
      toast('Video deleted.', 'success');
    } catch {
      toast('Could not delete the video. Try again.', 'error');
    } finally {
      setDeleting(false);
    }
  };

  const status = STATUS[rec.status];
  const note = rec.note ? NOTES[rec.note] : null;
  return (
    <Paper ref={card} id={RECORDING_ANCHOR} variant="outlined" component="section" aria-labelledby={`recording-${runId}`} sx={{ p: 2, my: 2, scrollMarginTop: 80 }} data-testid="run-recording">
      <Stack direction="row" spacing={1} useFlexGap sx={{ alignItems: 'center', flexWrap: 'wrap', mb: 1 }}>
        <Typography variant="subtitle1" component="h2" id={`recording-${runId}`} sx={{ mr: 'auto' }}>
          Recording
        </Typography>
        <Chip size="small" color={status.tone} label={status.label} data-status={rec.status} />
      </Stack>
      <Alert severity="warning" sx={{ mb: 1.5 }}>
        This video is not masked. Anything that was on the page is visible in it. Only you can watch it.
      </Alert>
      {rec.status === 'ready' && src && (
        <Box
          component="video"
          controls
          preload="metadata"
          src={src}
          onError={() => setSrc(null)}
          aria-label="Video of the run"
          sx={{ display: 'block', width: '100%', maxHeight: '70vh', bgcolor: 'common.black', borderRadius: 1 }}
        />
      )}
      {rec.status === 'recording' && <Typography variant="body2">The run is being recorded. The video is ready a minute after the run ends.</Typography>}
      {rec.status === 'processing' && <Typography variant="body2">The run ended. The video will be ready in about a minute.</Typography>}
      {note && (
        <Typography variant="body2" sx={{ color: 'text.secondary', mt: 1 }}>
          {note}
        </Typography>
      )}
      <Stack direction={{ xs: 'column', sm: 'row' }} spacing={1} useFlexGap sx={{ mt: 1.5, alignItems: { sm: 'center' } }}>
        <Typography variant="body2" sx={{ color: 'text.secondary', mr: 'auto' }}>
          {rec.status === 'ready' && `${duration(rec.durationMs)} · ${size(rec.bytes)} · `}
          {rec.expiresAt ? `Deleted on ${formatDateTime(rec.expiresAt)}` : rec.status === 'ready' || rec.status === 'failed' ? 'Kept until you delete it' : ''}
        </Typography>
        {canDelete && (rec.status === 'ready' || rec.status === 'failed') && (
          <Button color="error" variant="outlined" startIcon={<DeleteOutlinedIcon />} disabled={deleting} onClick={() => void remove()} sx={{ minHeight: 44 }}>
            {deleting ? 'Deleting…' : 'Delete video'}
          </Button>
        )}
      </Stack>
    </Paper>
  );
}
