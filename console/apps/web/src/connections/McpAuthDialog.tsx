import { Alert, Button, Dialog, DialogActions, DialogContent, DialogTitle, Stack, Typography } from '@mui/material';
import { useEffect, useId, useState } from 'react';

import { useBreakpoint } from '../ui';
import { reauthMcp, type Connection } from './api';
import { McpAuthFields, useMcpAuthForm } from './McpAuthFields';
import { mcpErrorWords } from './mcpWords';
import type { PlatformApiClient } from '@marinoscar/platform-web/core';

interface Props {
  connection: Connection | null;
  api: PlatformApiClient;
  returnTo: string;
  onClose: () => void;
  onDone: () => void;
}

/** "Update sign-in": a new token or header (tested before it is kept) or a new OAuth consent. How a server that stopped accepting the sign-in comes back. */
export function McpAuthDialog({ connection, api, returnTo, onClose, onDone }: Props) {
  const { isPhone } = useBreakpoint();
  const titleId = useId();
  const form = useMcpAuthForm();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (connection) {
      form.reset(connection.mcp?.auth ?? 'none');
      setBusy(false);
      setError(null);
    }
  }, [connection]);

  const submit = async () => {
    if (!connection || !form.input) return;
    setBusy(true);
    setError(null);
    try {
      const r = await reauthMcp(api, connection.id, form.input, returnTo);
      if (r.consent) {
        window.location.assign(r.consent.authorizeUrl);
        return;
      }
      onDone();
    } catch (e) {
      const err = e as { code?: string; details?: unknown; message?: string };
      setError(mcpErrorWords(err.code, err.details) ?? (err.message || 'Could not update the sign-in'));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Dialog open={connection !== null} onClose={busy ? undefined : onClose} fullWidth maxWidth="sm" fullScreen={isPhone} aria-labelledby={titleId}>
      <DialogTitle id={titleId} sx={{ overflowWrap: 'anywhere' }}>
        Update the sign-in for {connection?.label}
      </DialogTitle>
      <DialogContent>
        <Stack spacing={3} sx={{ pt: 1 }}>
          <Typography variant="body2" color="text.secondary">
            Hexactra tests the new sign-in with the server before it keeps it. The old one is replaced.
          </Typography>
          {error && (
            <Alert severity="error" onClose={() => setError(null)} role="alert">
              {error}
            </Alert>
          )}
          <McpAuthFields form={form} labelId={`${titleId}-auth`} />
        </Stack>
      </DialogContent>
      <DialogActions sx={{ flexDirection: { xs: 'column-reverse', sm: 'row' }, gap: 1, '& > :not(style)': { m: 0 } }}>
        <Button onClick={onClose} disabled={busy} sx={{ minHeight: { xs: 44, sm: 'auto' } }}>
          Cancel
        </Button>
        <Button variant="contained" onClick={() => void submit()} disabled={!form.input || busy} sx={{ minHeight: { xs: 44, sm: 'auto' } }}>
          {busy ? 'Testing…' : form.kind === 'oauth' ? 'Continue to the server' : 'Save'}
        </Button>
      </DialogActions>
    </Dialog>
  );
}
