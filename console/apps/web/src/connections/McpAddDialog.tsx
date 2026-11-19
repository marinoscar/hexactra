import { Alert, Button, Dialog, DialogActions, DialogContent, DialogTitle, Stack, TextField, Typography } from '@mui/material';
import { useEffect, useId, useState } from 'react';

import { useBreakpoint } from '../ui';
import { addMcpServer, setMcpToolMode, type Connection, type McpCatalog, type McpTool, type McpToolMode } from './api';
import { McpAuthFields, useMcpAuthForm } from './McpAuthFields';
import { McpToolList } from './McpToolList';
import { mcpErrorWords } from './mcpWords';
import type { PlatformApiClient } from '@marinoscar/platform-web/core';

interface Props {
  open: boolean;
  api: PlatformApiClient;
  returnTo: string;
  onClose: () => void;
  /** A connection exists (the server answered): the page reloads. */
  onAdded: () => void;
}

const TOUCH = { minHeight: { xs: 44, sm: 'auto' } } as const;

/**
 * "Add an MCP server": the address, a name, how the server signs you in. Hexactra tests the server first (it must answer, and list its
 * tools) and keeps nothing otherwise. Then the tool review: every tool starts off, and the owner switches on the ones the agent may use.
 */
export function McpAddDialog({ open, api, returnTo, onClose, onAdded }: Props) {
  const { isPhone } = useBreakpoint();
  const titleId = useId();
  const [url, setUrl] = useState('');
  const [label, setLabel] = useState('');
  const form = useMcpAuthForm();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [added, setAdded] = useState<{ connection: Connection; catalog: McpCatalog } | null>(null);
  const [saving, setSaving] = useState<string | null>(null);

  useEffect(() => {
    if (open) {
      setUrl('');
      setLabel('');
      form.reset();
      setBusy(false);
      setError(null);
      setAdded(null);
      setSaving(null);
    }
  }, [open]);

  const input = form.input;
  const canAdd = url.trim().length >= 8 && input !== null && !busy;

  const submit = async () => {
    if (!input) return;
    setBusy(true);
    setError(null);
    try {
      const r = await addMcpServer(api, { url: url.trim(), ...(label.trim() ? { label: label.trim() } : {}), auth: input, returnTo });
      if (r.consent) {
        // OAuth: the server's own sign-in opens in this tab and returns to the page.
        window.location.assign(r.consent.authorizeUrl);
        return;
      }
      if (r.connection && r.catalog) {
        setAdded({ connection: r.connection, catalog: r.catalog });
        onAdded();
      }
    } catch (e) {
      const err = e as { code?: string; details?: unknown; message?: string };
      setError(mcpErrorWords(err.code, err.details) ?? (err.message || 'Could not add the server'));
    } finally {
      setBusy(false);
    }
  };

  const decide = async (tool: McpTool, mode: McpToolMode) => {
    if (!added) return;
    setSaving(tool.id);
    try {
      const updated = await setMcpToolMode(api, added.connection.id, tool.id, mode);
      setAdded({ ...added, catalog: { ...added.catalog, tools: added.catalog.tools.map((t) => (t.id === updated.id ? updated : t)) } });
      onAdded();
    } catch (e) {
      setError((e as { message?: string }).message || 'Could not save the choice');
    } finally {
      setSaving(null);
    }
  };

  return (
    <Dialog open={open} onClose={busy ? undefined : onClose} fullWidth maxWidth="md" fullScreen={isPhone} aria-labelledby={titleId}>
      <DialogTitle id={titleId}>{added ? `Choose what ${added.connection.label} may do` : 'Add an MCP server'}</DialogTitle>
      <DialogContent>
        {added ? (
          <Stack spacing={2} sx={{ pt: 0.5 }}>
            <Alert severity="success" role="status">
              Connected {added.connection.label}
              {added.connection.mcp?.serverName ? ` (${added.connection.mcp.serverName})` : ''}. It offers {added.catalog.tools.length} tool{added.catalog.tools.length === 1 ? '' : 's'}, and every one is off.
            </Alert>
            <Typography variant="body2" color="text.secondary">
              Switch on only what the agent may use. A server describes its own tools, so what is written here is its claim. <strong>Read</strong> is called without asking; <strong>Write</strong> asks you first. Nothing uses this server until a task or chat is told to.
            </Typography>
            {error && (
              <Alert severity="error" onClose={() => setError(null)} role="alert">
                {error}
              </Alert>
            )}
            <McpToolList tools={added.catalog.tools} busyId={saving} onChange={(t, m) => void decide(t, m)} />
          </Stack>
        ) : (
          <Stack spacing={3} sx={{ pt: 1 }}>
            <Alert severity="info" icon={false}>
              An MCP server gives the agent tools (a notes app, a task tracker, a home system). Hexactra talks to it over the internet (https). It never starts a program from a connection, and every tool starts off until you switch it on.
            </Alert>
            {error && (
              <Alert severity="error" onClose={() => setError(null)} role="alert">
                {error}
              </Alert>
            )}
            <TextField label="Server address" type="url" value={url} onChange={(e) => setUrl(e.target.value)} placeholder="https://mcp.example.test/mcp" required fullWidth autoComplete="off" helperText="Its Streamable HTTP endpoint. https only; no user name, password or ?query in it." slotProps={{ htmlInput: { maxLength: 2000 } }} />
            <TextField label="Name (optional)" value={label} onChange={(e) => setLabel(e.target.value)} placeholder="Notes, Home" fullWidth helperText="What you call it. Tasks and chats can name it, and its tools are listed under it." slotProps={{ htmlInput: { maxLength: 60 } }} />
            <McpAuthFields form={form} labelId={`${titleId}-auth`} />
          </Stack>
        )}
      </DialogContent>
      <DialogActions sx={{ flexDirection: { xs: 'column-reverse', sm: 'row' }, gap: 1, '& > :not(style)': { m: 0 } }}>
        {added ? (
          <Button variant="contained" onClick={onClose} sx={TOUCH}>
            Done
          </Button>
        ) : (
          <>
            <Button onClick={onClose} disabled={busy} sx={TOUCH}>
              Cancel
            </Button>
            <Button variant="contained" onClick={() => void submit()} disabled={!canAdd} sx={TOUCH}>
              {busy ? 'Connecting…' : form.kind === 'oauth' ? 'Continue to the server' : 'Connect'}
            </Button>
          </>
        )}
      </DialogActions>
    </Dialog>
  );
}
