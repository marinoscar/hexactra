import { Alert, Box, Button, Dialog, DialogActions, DialogContent, DialogTitle, Stack, TextField, Typography } from '@mui/material';
import { useEffect, useId, useState } from 'react';

import { useBreakpoint } from '../ui';
import { tryMcpTool, type McpTool, type McpTryResult } from './api';
import { mcpErrorWords } from './mcpWords';
import type { PlatformApiClient } from '@marinoscar/platform-web/core';

interface Props {
  open: boolean;
  api: PlatformApiClient;
  connection: { id: string; label: string } | null;
  tool: McpTool | null;
  onClose: () => void;
}

const TOUCH = { minHeight: { xs: 44, sm: 'auto' } } as const;

/** A starting point for the arguments: each parameter the tool takes, empty. */
export function argumentsTemplate(tool: Pick<McpTool, 'parameters'>): string {
  const out: Record<string, unknown> = {};
  for (const p of tool.parameters) out[p.name] = p.type === 'number' || p.type === 'integer' ? 0 : p.type === 'boolean' ? false : p.type === 'array' ? [] : p.type === 'object' ? {} : '';
  return JSON.stringify(out, null, 2);
}

/**
 * "Try" (E50.12): calls one tool the owner set to Read, with arguments they type, exactly as a run would, and shows the server's answer
 * as PLAIN TEXT (never markup): cleaned, redacted of credentials and capped by the API. A Write tool cannot be tried. Nothing is kept.
 */
export function McpTryDialog({ open, api, connection, tool, onClose }: Props) {
  const { isPhone } = useBreakpoint();
  const titleId = useId();
  const [args, setArgs] = useState('{}');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<McpTryResult | null>(null);

  useEffect(() => {
    if (open && tool) {
      setArgs(argumentsTemplate(tool));
      setBusy(false);
      setError(null);
      setResult(null);
    }
  }, [open, tool]);

  let parsed: Record<string, unknown> | null = null;
  try {
    const v: unknown = JSON.parse(args);
    parsed = v !== null && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : null;
  } catch {
    parsed = null;
  }

  const run = async () => {
    if (!connection || !tool || !parsed) return;
    setBusy(true);
    setError(null);
    setResult(null);
    try {
      setResult(await tryMcpTool(api, connection.id, tool.id, parsed));
    } catch (e) {
      const err = e as { code?: string; details?: unknown; message?: string };
      setError(mcpErrorWords(err.code, err.details) ?? (err.message || 'Could not try the tool'));
    } finally {
      setBusy(false);
    }
  };

  const name = tool ? (tool.title ?? tool.name) : '';
  return (
    <Dialog open={open} onClose={busy ? undefined : onClose} fullWidth maxWidth="sm" fullScreen={isPhone} aria-labelledby={titleId}>
      <DialogTitle id={titleId} sx={{ overflowWrap: 'anywhere' }}>
        Try {name}
      </DialogTitle>
      <DialogContent>
        <Stack spacing={2} sx={{ pt: 0.5 }}>
          <Typography variant="body2" color="text.secondary">
            Calls this Read tool once on {connection?.label}, exactly as a run would. What comes back is the server&apos;s answer, shown as plain text; it is not kept.
          </Typography>
          <TextField
            label="Arguments (JSON)"
            value={args}
            onChange={(e) => setArgs(e.target.value)}
            multiline
            minRows={4}
            fullWidth
            error={parsed === null}
            helperText={parsed === null ? 'Arguments are a JSON object, for example {"query": "invoices"}.' : 'Checked against the tool\'s own parameters before anything is sent.'}
            slotProps={{ htmlInput: { spellCheck: false, style: { fontFamily: 'monospace' }, maxLength: 32000 } }}
          />
          {error && (
            <Alert severity="error" onClose={() => setError(null)} role="alert">
              {error}
            </Alert>
          )}
          {result && (
            <Stack spacing={1} role="status" aria-label="The server's answer">
              <Typography variant="body2">
                {result.ok ? 'The server answered' : result.code === 'TOOL_ERROR' ? 'The server reported an error' : 'The call did not complete'} in {result.ms} ms{result.truncated ? '; the answer was cut at 4,000 characters' : ''}.
              </Typography>
              <Box component="pre" sx={{ m: 0, p: 1.5, bgcolor: 'action.hover', borderRadius: 1, whiteSpace: 'pre-wrap', overflowWrap: 'anywhere', maxHeight: 320, overflow: 'auto', fontSize: '0.8125rem' }}>
                {result.text || '(no text)'}
              </Box>
            </Stack>
          )}
        </Stack>
      </DialogContent>
      <DialogActions sx={{ flexDirection: { xs: 'column-reverse', sm: 'row' }, gap: 1, '& > :not(style)': { m: 0 } }}>
        <Button onClick={onClose} disabled={busy} sx={TOUCH}>
          Close
        </Button>
        <Button variant="contained" onClick={() => void run()} disabled={busy || parsed === null} sx={TOUCH}>
          {busy ? 'Trying…' : 'Try it'}
        </Button>
      </DialogActions>
    </Dialog>
  );
}
