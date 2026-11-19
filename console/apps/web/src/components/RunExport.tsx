// Export a run (#544): the JSON trace (#542) or the PDF report (#543), from the
// run page, the chat's result card and the run list. The file is downloaded
// with the session (`GET /runs/{id}/export`) and handed to the browser under
// the server's name; a live run's file is partial.
import DataObjectIcon from '@mui/icons-material/DataObject';
import FileDownloadOutlinedIcon from '@mui/icons-material/FileDownloadOutlined';
import PictureAsPdfOutlinedIcon from '@mui/icons-material/PictureAsPdfOutlined';
import { Box, Button, Checkbox, CircularProgress, Divider, ListItemIcon, ListItemText, Menu, MenuItem, Typography, type ButtonProps } from '@mui/material';
import { useCallback, useId, useState } from 'react';
import { isPlatformApiError, useOptionalPlatformHost } from '@marinoscar/platform-web/core';

import { exportRun, saveDownload } from '../api';
import type { RunExportFormat } from '../types/runs';
import { ErrorBanner } from '../ui';

/** Where the viewer's "Include screenshots" choice is remembered (this browser only). */
export const EXPORT_SCREENSHOTS_KEY = 'hexactra.runs.exportScreenshots';

/** The note every export menu carries. */
export const EXPORT_NOTE = 'Sensitive data is masked. Pictures can still show personal details: turn them off before sharing outside.';

/** What the menu items say. */
export const EXPORT_LABEL: Record<RunExportFormat, string> = { pdf: 'PDF report', json: 'JSON trace' };

function savedScreenshots(): boolean {
  try {
    return localStorage.getItem(EXPORT_SCREENSHOTS_KEY) !== 'false';
  } catch {
    return true;
  }
}

function saveScreenshots(on: boolean) {
  try {
    localStorage.setItem(EXPORT_SCREENSHOTS_KEY, on ? 'true' : 'false');
  } catch {
    // a convenience only
  }
}

/** The message of a failed export; a file too large with its pictures suggests leaving them out. */
export function exportErrorText(e: unknown): string {
  const message = e instanceof Error && e.message ? e.message : 'Could not export the run';
  if (isPlatformApiError(e) && e.code === 'EXPORT_TOO_LARGE') return `${message} Turn off "Include screenshots" and export again.`;
  return message;
}

export interface RunExporter {
  /** The viewer holds `runs:read` (and the client can download): otherwise nothing is shown. */
  canExport: boolean;
  /** "Include screenshots", remembered per browser. */
  screenshots: boolean;
  setScreenshots: (on: boolean) => void;
  /** The format being prepared, or null. */
  busy: RunExportFormat | null;
  error: string | null;
  clearError: () => void;
  /** Download the file; a second press while one is prepared does nothing. Never rejects. */
  start: (runId: string, format: RunExportFormat) => Promise<void>;
}

/** The export state of a page or a card: the remembered choice, the file in progress and the last failure. */
export function useRunExport(): RunExporter {
  const host = useOptionalPlatformHost();
  const client = host?.api ?? null;
  const canExport = Boolean(host?.viewer.hasPermission('runs:read') && client?.getBlob);
  const [screenshots, setShots] = useState(savedScreenshots);
  const [busy, setBusy] = useState<RunExportFormat | null>(null);
  const [error, setError] = useState<string | null>(null);
  const setScreenshots = useCallback((on: boolean) => {
    setShots(on);
    saveScreenshots(on);
  }, []);
  const start = useCallback(
    async (runId: string, format: RunExportFormat) => {
      if (!client || busy) return;
      setBusy(format);
      setError(null);
      try {
        saveDownload(await exportRun(client, runId, { format, screenshots }));
      } catch (e) {
        setError(exportErrorText(e));
      } finally {
        setBusy(null);
      }
    },
    [client, busy, screenshots],
  );
  return { canExport, screenshots, setScreenshots, busy, error, clearError: useCallback(() => setError(null), []), start };
}

export interface RunExportMenuProps {
  anchorEl: HTMLElement | null;
  onClose: () => void;
  exporter: RunExporter;
  runId: string;
  /** The run is still going: the file is partial. */
  live?: boolean;
  id?: string;
}

/** The menu: "PDF report", "JSON trace", "Include screenshots" and the note. Operable with the keyboard. */
export function RunExportMenu({ anchorEl, onClose, exporter, runId, live = false, id }: RunExportMenuProps) {
  const choose = (format: RunExportFormat) => {
    onClose();
    void exporter.start(runId, format);
  };
  return (
    <Menu id={id} anchorEl={anchorEl} open={Boolean(anchorEl)} onClose={onClose} slotProps={{ paper: { sx: { maxWidth: 340 } } }}>
      <MenuItem onClick={() => choose('pdf')} disabled={exporter.busy !== null} sx={{ minHeight: 44 }}>
        <ListItemIcon>
          <PictureAsPdfOutlinedIcon fontSize="small" />
        </ListItemIcon>
        <ListItemText>{EXPORT_LABEL.pdf}</ListItemText>
      </MenuItem>
      <MenuItem onClick={() => choose('json')} disabled={exporter.busy !== null} sx={{ minHeight: 44 }}>
        <ListItemIcon>
          <DataObjectIcon fontSize="small" />
        </ListItemIcon>
        <ListItemText>{EXPORT_LABEL.json}</ListItemText>
      </MenuItem>
      <Divider />
      <MenuItem role="menuitemcheckbox" aria-checked={exporter.screenshots} onClick={() => exporter.setScreenshots(!exporter.screenshots)} sx={{ minHeight: 44 }}>
        <ListItemIcon>
          <Checkbox edge="start" size="small" checked={exporter.screenshots} tabIndex={-1} disableRipple slotProps={{ input: { 'aria-hidden': true } }} sx={{ p: 0 }} />
        </ListItemIcon>
        <ListItemText>Include screenshots</ListItemText>
      </MenuItem>
      <Box sx={{ px: 2, pt: 1, pb: 0.5 }}>
        <Typography variant="caption" component="p" color="text.secondary" sx={{ whiteSpace: 'normal' }}>
          {EXPORT_NOTE}
        </Typography>
        {live && (
          <Typography variant="caption" component="p" color="text.secondary" sx={{ mt: 0.5, whiteSpace: 'normal' }}>
            The run is still going: the file is partial.
          </Typography>
        )}
      </Box>
    </Menu>
  );
}

export interface RunExportButtonProps {
  runId: string;
  live?: boolean;
  /** Shared with the page (its error line); without it the button keeps its own and shows the error under itself. */
  exporter?: RunExporter;
  variant?: ButtonProps['variant'];
  sx?: ButtonProps['sx'];
}

/** "Export" with its menu; "Preparing…" and disabled while the file is made. Hidden without `runs:read`. */
export function RunExportButton({ runId, live, exporter: shared, variant = 'outlined', sx }: RunExportButtonProps) {
  const own = useRunExport();
  const exporter = shared ?? own;
  const [anchor, setAnchor] = useState<HTMLElement | null>(null);
  const menuId = useId();
  if (!exporter.canExport) return null;
  const busy = exporter.busy !== null;
  return (
    <>
      <Button
        variant={variant}
        aria-haspopup="menu"
        aria-controls={anchor ? menuId : undefined}
        aria-expanded={anchor ? 'true' : undefined}
        aria-busy={busy || undefined}
        disabled={busy}
        startIcon={busy ? <CircularProgress size={16} color="inherit" aria-hidden /> : <FileDownloadOutlinedIcon />}
        onClick={(e) => setAnchor(e.currentTarget)}
        sx={sx}
      >
        {busy ? 'Preparing…' : 'Export'}
      </Button>
      <RunExportMenu id={menuId} anchorEl={anchor} onClose={() => setAnchor(null)} exporter={exporter} runId={runId} live={live} />
      {!shared && exporter.error && (
        <Box sx={{ flexBasis: '100%', mt: 1 }}>
          <ErrorBanner error={exporter.error} onClose={exporter.clearError} />
        </Box>
      )}
    </>
  );
}
