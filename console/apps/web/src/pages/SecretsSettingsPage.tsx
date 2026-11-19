import KeyOutlinedIcon from '@mui/icons-material/KeyOutlined';
import { Alert, Box, Button, FormControlLabel, Paper, Radio, RadioGroup, Stack, Switch, Typography } from '@mui/material';
import { usePlatformHost } from '@marinoscar/platform-web/core';
import { useCallback, useEffect, useState } from 'react';
import { Link as RouterLink } from 'react-router-dom';

import { ErrorBanner, ListSkeleton, PageContainer, PageHeader, useApiAction } from '../ui';

/** `GET /api/secrets/status`: the two switches and the Vault connection (never a token). */
export interface SecretsStatus {
  agentUse: { deployment: boolean; user: boolean; effective: boolean };
  providers: { vault: { status: 'not_configured' | 'disconnected' | 'connected' | 'needs_reconnect'; baseUrl: string | null } };
}

/** `GET /api/secrets/store/status`: present only when the deployment switched the built-in store on. */
export interface StoreStatus {
  enabled: true;
  provider: 'vault' | 'builtin';
  logins: number;
  openToAgent: number;
}

const VAULT_STATUS_TEXT: Record<SecretsStatus['providers']['vault']['status'], string> = {
  not_configured: 'Not set up yet',
  disconnected: 'Not connected',
  connected: 'Connected',
  needs_reconnect: 'Needs to be connected again',
};

/**
 * Settings → Secrets: which store the agent uses for your saved logins (E37.4 and E37.5, epic #579). One is
 * active at a time and switching does not move data. The built-in store is offered only when the deployment
 * switched it on; your saved logins are managed at `/secrets` (Vault's own pages, in this shell).
 */
export function SecretsSettingsPage() {
  const { api, viewer } = usePlatformHost();
  const canWrite = viewer.hasPermission('secrets:write');
  const action = useApiAction('Could not save the change');
  const [status, setStatus] = useState<SecretsStatus | null>(null);
  const [store, setStore] = useState<StoreStatus | null | undefined>(undefined);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      setStatus(await api.get<SecretsStatus>('/secrets/status'));
    } catch (e) {
      setError(e instanceof Error && e.message ? e.message : 'Could not load your secrets settings');
      return;
    }
    // The built-in store's route exists only while the slice is on: a 404 means "not offered here".
    try {
      setStore(await api.get<StoreStatus>('/secrets/store/status'));
    } catch {
      setStore(null);
    }
  }, [api]);

  useEffect(() => {
    void load();
  }, [load]);

  if (error) return <ErrorBanner error={error} onRetry={() => { setError(null); void load(); }} />;
  if (!status || store === undefined) return <ListSkeleton rows={3} />;

  const chosen = store?.provider ?? 'vault';
  const choose = (provider: 'vault' | 'builtin') =>
    action.run('provider', async () => {
      await api.patch('/user-settings', { secrets: { provider } });
      await load();
    });
  const toggleUse = (enabled: boolean) =>
    action.run('use', async () => {
      await api.patch('/user-settings', { secrets: { agentUse: { enabled } } });
      await load();
    });
  const vault = status.providers.vault;

  return (
    <PageContainer>
      <PageHeader title="Secrets" subtitle="Logins the agent can use on a page without ever seeing them. Choose where they are kept." />
      <Stack spacing={2}>
        {action.error && <Alert severity="error">{action.error}</Alert>}
        <Paper variant="outlined" sx={{ p: 2 }}>
          <FormControlLabel
            sx={{ alignItems: 'flex-start', m: 0, gap: 1 }}
            control={<Switch checked={status.agentUse.user} disabled={!canWrite || action.busy !== null} onChange={(e) => void toggleUse(e.target.checked)} slotProps={{ input: { 'aria-label': 'Let the agent use my saved logins' } }} />}
            label={
              <Box>
                <Typography sx={{ fontWeight: 600, pt: 0.75 }}>Let the agent use my saved logins</Typography>
                <Typography variant="body2" color="text.secondary">
                  Off by default. The agent never sees a login: it asks, and Hexactra types it. {status.agentUse.deployment ? '' : 'An administrator has not switched this on for the deployment yet.'}
                </Typography>
              </Box>
            }
          />
        </Paper>

        <Paper variant="outlined" sx={{ p: 2 }}>
          <Typography variant="h6" component="h2" sx={{ mb: 1 }}>
            Where your logins are kept
          </Typography>
          <RadioGroup value={chosen} onChange={(e) => void choose(e.target.value as 'vault' | 'builtin')} aria-label="Secrets provider">
            {store && (
              <FormControlLabel
                value="builtin"
                disabled={!canWrite || action.busy !== null}
                control={<Radio />}
                label={
                  <Box>
                    <Typography sx={{ fontWeight: 600 }}>Store in Hexactra</Typography>
                    <Typography variant="body2" color="text.secondary">
                      Saved logins live encrypted in this deployment's database. {store.logins} saved, {store.openToAgent} open to the agent. Good for logins; for more than logins, use your own Vault.
                    </Typography>
                  </Box>
                }
                sx={{ alignItems: 'flex-start', mb: 1 }}
              />
            )}
            <FormControlLabel
              value="vault"
              disabled={!canWrite || action.busy !== null}
              control={<Radio />}
              label={
                <Box>
                  <Typography sx={{ fontWeight: 600 }}>Connect Vault</Typography>
                  <Typography variant="body2" color="text.secondary">
                    Your own Vault keeps them; Hexactra never sees a value. {VAULT_STATUS_TEXT[vault.status]}
                    {vault.baseUrl ? ` (${vault.baseUrl})` : ''}.
                  </Typography>
                </Box>
              }
              sx={{ alignItems: 'flex-start' }}
            />
          </RadioGroup>
          <Typography variant="caption" color="text.secondary" component="p" sx={{ mt: 1 }}>
            One is active at a time. Switching does not move your logins.
          </Typography>
        </Paper>

        {store && chosen === 'builtin' && (
          <Button component={RouterLink} to="/secrets" variant="contained" startIcon={<KeyOutlinedIcon />} sx={{ alignSelf: 'flex-start' }}>
            My saved logins
          </Button>
        )}
      </Stack>
    </PageContainer>
  );
}
