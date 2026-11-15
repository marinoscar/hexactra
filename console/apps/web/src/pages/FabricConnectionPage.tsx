import { useCallback, useEffect, useState, type FormEvent } from 'react';
import { Alert, Box, Button, Chip, Container, Stack, TextField, Typography } from '@mui/material';
import { usePlatformHost } from '@marinoscar/platform-web/core';
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

/**
 * `/admin/settings/fabric`: the Hexactra Fabric control plane this console
 * drives (its URL and an `hxs_` service token). The token is write-only.
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

  const load = useCallback(async () => {
    try {
      const v = await api.get<FabricConnectionView>('/fabric/connection');
      setView(v);
      setUrl(v.url ?? '');
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not load the fabric connection');
    }
  }, [api]);

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
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not save');
    }
  };

  const runTest = async () => {
    setTesting(true);
    try {
      setTest(await api.post<FabricConnectionTest>('/fabric/connection/test', {}));
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not test the connection');
    } finally {
      setTesting(false);
    }
  };

  return (
    <Container maxWidth="sm" sx={{ py: 4 }}>
      <Typography variant="h4" component="h1" gutterBottom>
        Fabric connection
      </Typography>
      <Typography color="text.secondary" sx={{ mb: 3 }}>
        The Hexactra Fabric control plane that runs browsers for this console. Keep it on a private network; only the
        console needs to reach it.
      </Typography>
      {error && (
        <Alert severity="error" sx={{ mb: 2 }}>
          {error}
        </Alert>
      )}
      {saved && (
        <Alert severity="success" sx={{ mb: 2 }}>
          Saved.
        </Alert>
      )}
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
            <Button variant="outlined" onClick={() => void runTest()} disabled={!view?.configured || testing}>
              Test connection
            </Button>
          </Stack>
        </Stack>
      </Box>
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
    </Container>
  );
}
