import { Alert, Button, Chip, Dialog, DialogActions, DialogContent, DialogTitle, Link, Stack, TextField, Typography } from '@mui/material';
import { useEffect, useId, useState } from 'react';

import { useBreakpoint } from '../ui';
import { addMcpServer, getMcpPresets, setMcpToolMode, type Connection, type McpCatalog, type McpPreset, type McpTool, type McpToolMode } from './api';
import { McpAuthFields, useMcpAuthForm } from './McpAuthFields';
import { McpToolList } from './McpToolList';
import { AUTH_WORDS, mcpErrorWords } from './mcpWords';
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
  const [presets, setPresets] = useState<McpPreset[]>([]);
  const [preset, setPreset] = useState<McpPreset | null>(null);

  useEffect(() => {
    if (open) {
      setUrl('');
      setLabel('');
      form.reset();
      setBusy(false);
      setError(null);
      setAdded(null);
      setSaving(null);
      setPreset(null);
      // The presets only fill the form; a list that does not load leaves the form as it was.
      getMcpPresets(api)
        .then(setPresets)
        .catch(() => setPresets([]));
    }
  }, [open]);

  const pick = (p: McpPreset) => {
    setPreset(p);
    setUrl(p.url);
    setLabel(p.name);
    form.reset(p.auth);
    if (p.auth === 'header' && p.headerName) form.setHeader(p.headerName);
  };

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
              Switch on only what the agent may use. A server describes its own tools, so what is written here is its claim. <strong>Read</strong> is called without asking; <strong>Write</strong> asks you first. Every task and chat can use a tool once you switch it on here.
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
            {presets.length > 0 && (
              <Stack spacing={1}>
                <Typography variant="subtitle2" component="h3">
                  Pick one or enter an address
                </Typography>
                <Stack direction="row" spacing={1} useFlexGap sx={{ flexWrap: 'wrap' }} role="group" aria-label="Well-known servers">
                  {presets.map((p) => (
                    <Chip key={p.id} label={`${p.name} · ${AUTH_WORDS[p.auth]}`} clickable color={preset?.id === p.id ? 'primary' : 'default'} variant={preset?.id === p.id ? 'filled' : 'outlined'} onClick={() => pick(p)} sx={{ minHeight: 36, maxWidth: '100%' }} />
                  ))}
                  <Chip
                    label="Other server"
                    clickable
                    color={preset === null ? 'primary' : 'default'}
                    variant={preset === null ? 'filled' : 'outlined'}
                    onClick={() => {
                      setPreset(null);
                      setUrl('');
                      setLabel('');
                    }}
                    sx={{ minHeight: 36 }}
                  />
                </Stack>
                {preset && (
                  <Typography variant="body2" color="text.secondary" sx={{ overflowWrap: 'anywhere' }}>
                    {preset.notes}{' '}
                    <Link href={preset.docsUrl} target="_blank" rel="noopener noreferrer">
                      Its documentation
                    </Link>{' '}
                    (address checked {preset.verified}). It is still tested before anything is kept, and every tool starts off.
                  </Typography>
                )}
              </Stack>
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
