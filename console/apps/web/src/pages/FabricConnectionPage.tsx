import { useCallback, useEffect, useState, type FormEvent } from 'react';
import { Alert, Box, Button, Chip, Collapse, Stack, TextField, Typography } from '@mui/material';
import { usePlatformHost } from '@marinoscar/platform-web/core';

import { ErrorBanner, PageContainer, PageHeader } from '../ui';
import { SecretField } from '@marinoscar/platform-web/credentials/ui';

/** `GET /api/fabric/connection`. */
export interface FabricConnectionView {
  configured: boolean;
  url: string | null;
  token: { hint: string | null; updatedAt: string } | null;
}

/** `POST /api/fabric/connection/test`. */
export interface FabricConnectionTest {
  reachable: boolean;
  authenticated: boolean;
  version: string | null;
  latencyMs: number | null;
  hosts: number;
  onlineHosts: number;
  error: string | null;
}

/** The fabric bundled with the console's stack; `hexactra deploy` connects and repairs it (#309). */
export const BUNDLED_FABRIC_URL = 'http://fabric-control:8787';

/** `managed`: the bundled fabric, kept by deploy; `custom`: another fabric; `missing`: nothing stored. */
export type FabricConnectionMode = 'managed' | 'custom' | 'missing';

export function connectionMode(view: FabricConnectionView): FabricConnectionMode {
  if (!view.configured) return 'missing';
  return view.url?.replace(/\/+$/, '') === BUNDLED_FABRIC_URL ? 'managed' : 'custom';
}

/**
 * `/admin/settings/fabric`: the Hexactra Fabric control plane this console
 * drives (its URL and an `hxs_` service token). The token is write-only.
 *
 * Deploy connects the bundled fabric on its own (#474), so in the managed
 * case the page shows the status and keeps the form behind "Use a different
 * fabric…". A custom or missing connection shows the form open.
 */
export function FabricConnectionPage() {
  const { api, viewer } = usePlatformHost();
  const canWrite = viewer.hasPermission('fabric_config:write');
  const [view, setView] = useState<FabricConnectionView | null>(null);
  const [url, setUrl] = useState('');
  const [token, setToken] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);
  const [test, setTest] = useState<FabricConnectionTest | null>(null);
  const [testing, setTesting] = useState(false);
  const [editing, setEditing] = useState(false);

  const runTest = useCallback(async () => {
    setTesting(true);
    try {
      setTest(await api.post<FabricConnectionTest>('/fabric/connection/test', {}));
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not test the connection');
    } finally {
      setTesting(false);
    }
  }, [api]);

  const load = useCallback(async () => {
    try {
      const v = await api.get<FabricConnectionView>('/fabric/connection');
      setView(v);
      setUrl(v.url ?? '');
      if (v.configured) void runTest();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not load the fabric connection');
    }
  }, [api, runTest]);

  useEffect(() => {
    void load();
  }, [load]);

  const save = async (event: FormEvent) => {
    event.preventDefault();
    setError(null);
    setSaved(false);
    try {
      const v = await api.put<FabricConnectionView>('/fabric/connection', token ? { url, token } : { url });
      setView(v);
      setToken('');
      setSaved(true);
      setEditing(false);
      if (v.configured) void runTest();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not save');
    }
  };

  const mode = view ? connectionMode(view) : null;
  const formOpen = mode !== null && (mode !== 'managed' || editing);

  return (
    <PageContainer width="narrow">
      <PageHeader
        title="Fabric connection"
        subtitle="The Hexactra Fabric control plane that runs browsers for this console. Keep it on a private network; only the console needs to reach it."
      />
      <ErrorBanner error={error} />
      {saved && (
        <Alert severity="success" sx={{ mb: 2 }}>
          Saved.
        </Alert>
      )}
      {mode === 'managed' && (
        <Box sx={{ mb: 2 }}>
          <Stack direction="row" spacing={1} sx={{ mb: 1, flexWrap: 'wrap' }}>
            <Chip color="primary" label="Managed by deploy" />
          </Stack>
          <Typography variant="body2" color="text.secondary" sx={{ mb: 2 }}>
            This console uses its bundled fabric. Deploy connects it and repairs the connection on each deploy update, so there is
            nothing to set here.
          </Typography>
          <Typography variant="body2">
            <strong>URL:</strong> {view?.url}
          </Typography>
          {view?.token?.hint && (
            <Typography variant="body2">
              <strong>Service token:</strong> {view.token.hint}
            </Typography>
          )}
          <Stack direction="row" spacing={1} sx={{ mt: 2, flexWrap: 'wrap', gap: 1 }}>
            <Button variant="outlined" onClick={() => void runTest()} disabled={testing}>
              Test connection
            </Button>
            {canWrite && !editing && (
              <Button onClick={() => setEditing(true)}>Use a different fabric…</Button>
            )}
          </Stack>
        </Box>
      )}
      {mode === 'custom' && (
        <Stack spacing={1} sx={{ mb: 2 }}>
          <Box>
            <Chip variant="outlined" label="Custom fabric" />
          </Box>
          <Typography variant="body2" color="text.secondary">
            Deploy leaves this connection alone. To go back to the bundled fabric, set the URL to {BUNDLED_FABRIC_URL}.
          </Typography>
        </Stack>
      )}
      {mode === 'missing' && (
        <Alert severity="info" sx={{ mb: 2 }}>
          Not connected. Running deploy update connects the bundled fabric. To use another fabric, enter its URL and an hxs_
          service token.
        </Alert>
      )}
      <Collapse in={formOpen} unmountOnExit>
      <Box component="form" onSubmit={save}>
        <Stack spacing={2}>
          <TextField
            label="Fabric URL"
            placeholder="http://fabric-control:8787"
            value={url}
            onChange={(e) => setUrl(e.target.value)}
            disabled={!canWrite}
            required
            fullWidth
          />
          <SecretField
            label="Service token"
            noun="token"
            value={token}
            onChange={setToken}
            saved={view?.token ?? null}
            emptyHelp="An hxs_ token from POST /v1/admin/service-tokens on the fabric."
            disabled={!canWrite}
          />
          <Stack direction="row" spacing={1}>
            {canWrite && (
              <Button type="submit" variant="contained">
                Save
              </Button>
            )}
            {mode === 'managed' ? (
              <Button onClick={() => setEditing(false)}>Cancel</Button>
            ) : (
              <Button variant="outlined" onClick={() => void runTest()} disabled={!view?.configured || testing}>
                Test connection
              </Button>
            )}
          </Stack>
        </Stack>
      </Box>
      </Collapse>
      {test && (
        <Stack direction="row" spacing={1} sx={{ mt: 3, flexWrap: 'wrap' }} aria-label="Connection test">
          <Chip color={test.reachable ? 'success' : 'error'} label={test.reachable ? `Reachable${test.latencyMs !== null ? ` (${test.latencyMs} ms)` : ''}` : 'Unreachable'} />
          <Chip color={test.authenticated ? 'success' : 'error'} label={test.authenticated ? 'Token accepted' : 'Token refused'} />
          {test.authenticated && <Chip label={`${test.onlineHosts} of ${test.hosts} hosts online`} />}
          {test.version && <Chip variant="outlined" label={`Fabric ${test.version}`} />}
          {test.error && (
            <Alert severity="warning" sx={{ mt: 1, width: '100%' }}>
              {test.error}
            </Alert>
          )}
        </Stack>
      )}
    </PageContainer>
  );
}
