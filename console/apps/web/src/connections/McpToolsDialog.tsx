import RefreshIcon from '@mui/icons-material/Refresh';
import { Alert, Button, Dialog, DialogActions, DialogContent, DialogTitle, Skeleton, Stack, Typography } from '@mui/material';
import { useCallback, useEffect, useId, useState } from 'react';

import { useBreakpoint } from '../ui';
import { getMcpTools, refreshMcpTools, setMcpToolMode, type McpCatalog, type McpTool, type McpToolMode } from './api';
import { McpToolList } from './McpToolList';
import { mcpErrorWords } from './mcpWords';
import type { PlatformApiClient } from '@marinoscar/platform-web/core';

interface Props {
  open: boolean;
  api: PlatformApiClient;
  connection: { id: string; label: string } | null;
  canWrite: boolean;
  onClose: () => void;
  /** The owner decided something or refreshed: the page reloads its counts. */
  onChanged: () => void;
}

const message = (e: unknown, fallback: string): string => {
  const err = e as { code?: string; details?: unknown; message?: string };
  return mcpErrorWords(err.code, err.details) ?? (err.message || fallback);
};

/** The tool review of one MCP server: every tool with the owner's switch, "Refresh tools", and the "changed tools" state. */
export function McpToolsDialog({ open, api, connection, canWrite, onClose, onChanged }: Props) {
  const { isPhone } = useBreakpoint();
  const titleId = useId();
  const [catalog, setCatalog] = useState<McpCatalog | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);

  const load = useCallback(async () => {
    if (!connection) return;
    try {
      setCatalog(await getMcpTools(api, connection.id));
    } catch (e) {
      setError(message(e, 'Could not load the tools'));
      setCatalog({ tools: [], needsReview: 0, fetchedAt: null });
    }
  }, [api, connection]);

  useEffect(() => {
    if (open && connection) {
      setCatalog(null);
      setError(null);
      void load();
    }
  }, [open, connection, load]);

  const refresh = async () => {
    if (!connection) return;
    setBusy('refresh');
    setError(null);
    try {
      setCatalog(await refreshMcpTools(api, connection.id));
      onChanged();
    } catch (e) {
      setError(message(e, 'Could not refresh the tools'));
    } finally {
      setBusy(null);
    }
  };

  const decide = async (tool: McpTool, mode: McpToolMode) => {
    if (!connection) return;
    setBusy(tool.id);
    setError(null);
    try {
      const updated = await setMcpToolMode(api, connection.id, tool.id, mode);
      setCatalog((c) => {
        if (!c) return c;
        const tools = c.tools.map((t) => (t.id === updated.id ? updated : t));
        return { ...c, tools, needsReview: tools.filter((t) => t.review !== null).length };
      });
      onChanged();
    } catch (e) {
      setError(message(e, 'Could not save the choice'));
    } finally {
      setBusy(null);
    }
  };

  const review = catalog?.tools.filter((t) => t.review !== null) ?? [];
  return (
    <Dialog open={open} onClose={onClose} fullWidth maxWidth="md" fullScreen={isPhone} aria-labelledby={titleId}>
      <DialogTitle id={titleId} sx={{ overflowWrap: 'anywhere' }}>
        Tools of {connection?.label}
      </DialogTitle>
      <DialogContent>
        <Stack spacing={2} sx={{ pt: 0.5 }}>
          <Typography variant="body2" color="text.secondary">
            Every tool starts off. A server describes its own tools, so what is written here is its claim, not Hexactra&apos;s. Choose <strong>Read</strong> only for a tool that just looks things up; a <strong>Write</strong> tool asks you before it runs.
          </Typography>
          {error && (
            <Alert severity="error" onClose={() => setError(null)} role="alert">
              {error}
            </Alert>
          )}
          {review.length > 0 && (
            <Alert severity="warning" role="status">
              {review.length === 1 ? '1 tool is' : `${review.length} tools are`} new or changed since you last decided. {review.length === 1 ? 'It is' : 'They are'} off until you choose: {review.map((t) => t.title ?? t.name).join(', ')}.
            </Alert>
          )}
          {catalog === null ? (
            <Skeleton variant="rounded" height={120} />
          ) : (
            <McpToolList tools={catalog.tools} busyId={busy} disabled={!canWrite} onChange={(t, m) => void decide(t, m)} />
          )}
        </Stack>
      </DialogContent>
      <DialogActions sx={{ flexDirection: { xs: 'column-reverse', sm: 'row' }, gap: 1, '& > :not(style)': { m: 0 } }}>
        {canWrite && (
          <Button startIcon={<RefreshIcon />} onClick={() => void refresh()} disabled={busy !== null} sx={{ minHeight: { xs: 44, sm: 'auto' }, mr: { sm: 'auto !important' } }}>
            {busy === 'refresh' ? 'Refreshing…' : 'Refresh tools'}
          </Button>
        )}
        <Button variant="contained" onClick={onClose} sx={{ minHeight: { xs: 44, sm: 'auto' } }}>
          Done
        </Button>
      </DialogActions>
    </Dialog>
  );
}
