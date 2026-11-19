import PauseCircleOutlinedIcon from '@mui/icons-material/PauseCircleOutlined';
import { Alert, Button, Stack } from '@mui/material';

import type { RunStatus } from '../types/runs';

/** What the banner says while a run is paused (E38.2). */
export const PAUSED_TEXT = 'Paused. Nothing happens until you resume.';

type PauseFacts = { status: RunStatus | string; pauseRequested?: boolean };

/** Pause is offered while the run can still go on: queued, running, or waiting for an answer (it pauses once answered). */
export function canPauseRun(run: Pick<PauseFacts, 'status'>): boolean {
  return run.status === 'queued' || run.status === 'running' || run.status === 'waiting_human';
}

/** Pause was pressed and the run has not paused yet: the button says "Pausing…" until the status changes. `sent` is the page's own, before the server says so. */
export function isPausing(run: PauseFacts, sent = false): boolean {
  return canPauseRun(run) && (run.pauseRequested === true || sent);
}

/**
 * The banner of a paused run: "Paused. Nothing happens until you resume." with Resume and Stop. The run's browser stays open
 * beside it, so the owner can look at the page (and take over) before continuing. A control the viewer may not use is absent.
 */
export function PausedBanner({ onResume, onStop, resuming = false, stopping = false }: { onResume?: () => void; onStop?: () => void; resuming?: boolean; stopping?: boolean }) {
  return (
    <Alert
      severity="info"
      icon={<PauseCircleOutlinedIcon fontSize="inherit" />}
      role="status"
      sx={{ my: 1.5, alignItems: 'center', '& .MuiAlert-message': { flex: 1, minWidth: 0 } }}
      data-testid="paused-banner"
    >
      <Stack direction="row" useFlexGap sx={{ flexWrap: 'wrap', alignItems: 'center', gap: 1 }}>
        <span style={{ flex: '1 1 12rem', overflowWrap: 'anywhere' }}>{PAUSED_TEXT}</span>
        {onResume && (
          <Button size="small" variant="contained" onClick={onResume} disabled={resuming} sx={{ minHeight: 44 }}>
            {resuming ? 'Resuming…' : 'Resume'}
          </Button>
        )}
        {onStop && (
          <Button size="small" color="error" variant="outlined" onClick={onStop} disabled={stopping} sx={{ minHeight: 44 }}>
            {stopping ? 'Stopping…' : 'Stop'}
          </Button>
        )}
      </Stack>
    </Alert>
  );
}
