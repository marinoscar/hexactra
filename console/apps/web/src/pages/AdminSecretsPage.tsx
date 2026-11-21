import { Alert, Box, Button, FormControlLabel, FormHelperText, Paper, Stack, Switch, TextField, Typography } from '@mui/material';
import { isPlatformApiError, usePlatformHost } from '@marinoscar/platform-web/core';
import { useCallback, useEffect, useId, useState, type FormEvent } from 'react';

import { getAdminSummary, getDefaultClient, getDeploymentSwitch, setDeploymentSwitch, type AdminSummary, type DefaultClient } from '../secrets/api';
import { BuiltinStoreCard } from '../secrets/BuiltinStoreCard';
import { CardSkeleton, ErrorBanner, PageContainer, PageHeader, useApiAction } from '../ui';

const TOUCH = { minHeight: { xs: 44, sm: 'auto' } } as const;

function Count({ label, value }: { label: string; value: number }) {
  return (
    <Paper variant="outlined" sx={{ p: 2, flex: '1 1 140px', minWidth: 0 }}>
      <Typography variant="h5" component="p" data-testid={`count-${label}`}>
        {value}
      </Typography>
      <Typography variant="body2" color="text.secondary">
        {label}
      </Typography>
    </Paper>
  );
}

/** The default Vault address and OAuth client of the deployment: owners then only press Connect. */
function DefaultClientCard({ canWrite }: { canWrite: boolean }) {
  const { api } = usePlatformHost();
  const action = useApiAction('Could not save the default Vault');
  const [stored, setStored] = useState<DefaultClient | null>(null);
  const [baseUrl, setBaseUrl] = useState('');
  const [clientId, setClientId] = useState('');
  const [clientSecret, setClientSecret] = useState('');
  const [saved, setSaved] = useState(false);
  const { setError } = action;

  const apply = (d: DefaultClient) => {
    setStored(d);
    setBaseUrl(d.baseUrl ?? '');
    setClientId(d.clientId ?? '');
    setClientSecret('');
  };

  useEffect(() => {
    let live = true;
    getDefaultClient(api).then(
      (d) => live && apply(d),
      (e) => live && setError(e instanceof Error && e.message ? e.message : 'Could not load the default Vault'),
    );
    return () => {
      live = false;
    };
  }, [api, setError]);

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setSaved(false);
    const d = await action.run('save', () => api.put<DefaultClient>('/secrets/vault/default-client', { baseUrl: baseUrl.trim() || null, clientId: clientId.trim() || null, ...(clientSecret ? { clientSecret } : {}) }));
    if (d) {
      apply(d);
      setSaved(true);
    }
  };
  const remove = async () => {
    setSaved(false);
    const d = await action.run('remove', () => api.delete<DefaultClient>('/secrets/vault/default-client'));
    if (d) {
      apply(d);
      setSaved(true);
    }
  };

  return (
    <Paper variant="outlined" component="section" aria-labelledby="default-title" sx={{ p: { xs: 2, sm: 3 } }}>
      <Typography id="default-title" variant="h6" component="h2">
        Default Vault
      </Typography>
      <Typography variant="body2" color="text.secondary" sx={{ mt: 0.5 }}>
        The Vault your users connect to. When this is set, they only press Connect; a user&rsquo;s own entries take precedence.
      </Typography>
      <ErrorBanner error={action.error} onClose={action.clearError} />
      {!stored && !action.error && <CardSkeleton />}
      {stored && (
        <Box component="form" onSubmit={(e) => void submit(e)} noValidate sx={{ mt: 2 }}>
          <Stack spacing={2}>
            <TextField label="Vault address" type="url" value={baseUrl} onChange={(e) => setBaseUrl(e.target.value)} placeholder="https://vault.example.test" disabled={!canWrite} fullWidth />
            <TextField label="Client ID" value={clientId} onChange={(e) => setClientId(e.target.value)} disabled={!canWrite} fullWidth />
            <TextField
              label="Client secret"
              type="password"
              value={clientSecret}
              onChange={(e) => setClientSecret(e.target.value)}
              disabled={!canWrite}
              autoComplete="off"
              fullWidth
              helperText={stored.hasClientSecret ? 'A secret is stored. Leave this empty to keep it.' : 'Stored encrypted and never shown again.'}
            />
            <Typography variant="body2" color="text.secondary" sx={{ overflowWrap: 'anywhere' }}>
              Register this redirect address in Vault: <code>{stored.redirectUri}</code>
            </Typography>
            {canWrite && (
              <Box sx={{ display: 'flex', gap: 1, flexWrap: 'wrap' }}>
                <Button type="submit" variant="contained" disabled={action.busy !== null} sx={TOUCH}>
                  Save default
                </Button>
                {(stored.baseUrl || stored.clientId || stored.hasClientSecret) && (
                  <Button color="error" onClick={() => void remove()} disabled={action.busy !== null} sx={TOUCH}>
                    Remove default
                  </Button>
                )}
              </Box>
            )}
            <Box role="status" aria-live="polite">
              {saved && <Alert severity="success">Saved.</Alert>}
            </Box>
          </Stack>
        </Box>
      )}
    </Paper>
  );
}

/**
 * `/admin/settings/secrets` (E37.4, #593): the deployment's kill switch for saved secrets (`secrets.agentUse.enabled`,
 * off by default), the default Vault, and counts. An administrator sees no one's logins, sites or activity: the
 * counts have no owner in them.
 */
export function AdminSecretsPage() {
  const { api, viewer } = usePlatformHost();
  const canWrite = viewer.hasPermission('system_settings:write');
  const action = useApiAction('Could not change the switch');
  const [enabled, setEnabled] = useState<boolean | null>(null);
  const [version, setVersion] = useState(0);
  const [summary, setSummary] = useState<AdminSummary | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const { setError } = action;
  const helpId = useId();

  const load = useCallback(async () => {
    try {
      const sw = await getDeploymentSwitch(api);
      setEnabled(sw.enabled);
      setVersion(sw.version);
      setSummary(await getAdminSummary(api));
    } catch (e) {
      setError(e instanceof Error && e.message ? e.message : 'Could not load the secrets settings');
    }
  }, [api, setError]);
  useEffect(() => {
    void load();
  }, [load]);

  const toggle = async (on: boolean) => {
    setNotice(null);
    try {
      const r = await setDeploymentSwitch(api, on, version);
      setEnabled(r.enabled);
      setVersion(r.version);
      setNotice(r.enabled ? 'Saved secrets are on for this deployment. Each user still chooses whether the agent may use theirs.' : 'Saved secrets are off. The agent uses no one’s saved logins.');
      setSummary(await getAdminSummary(api));
    } catch (e) {
      setError(isPlatformApiError(e) && e.status === 409 ? 'The settings changed elsewhere; reload the page and try again.' : e instanceof Error && e.message ? e.message : 'Could not change the switch');
    }
  };

  return (
    <PageContainer width="narrow">
      <PageHeader title="Secrets" subtitle="Whether the agent may use saved logins on this deployment, whether Hexactra's own store is offered, and which Vault your users connect to." back={{ to: '/admin/settings', label: 'Settings' }} />
      <ErrorBanner error={action.error} onClose={action.clearError} />
      {enabled === null && !action.error && <CardSkeleton />}
      {enabled !== null && (
        <Stack spacing={3}>
          <Paper variant="outlined" component="section" aria-labelledby="switch-title" sx={{ p: { xs: 2, sm: 3 } }}>
            <Typography id="switch-title" variant="h6" component="h2" sx={{ mb: 1 }}>
              Kill switch
            </Typography>
            <FormControlLabel
              sx={{ m: 0, minHeight: { xs: 44, sm: 'auto' } }}
              control={<Switch checked={enabled} disabled={!canWrite} onChange={(e) => void toggle(e.target.checked)} slotProps={{ input: { 'aria-describedby': helpId } }} />}
              label="Let the agent use saved logins"
            />
            <FormHelperText id={helpId} sx={{ mt: 0, ml: { xs: 0, sm: 6 } }}>
              Off by default. While it is off, nothing is looked up or typed for anyone, whatever their own setting or their Vault allows. Turning it on lets each user choose.
            </FormHelperText>
            <Box role="status" aria-live="polite" sx={{ mt: notice ? 1.5 : 0 }}>
              {notice && <Alert severity="info">{notice}</Alert>}
            </Box>
          </Paper>

          {summary && (
            <Box component="section" aria-labelledby="counts-title">
              <Typography id="counts-title" variant="h6" component="h2" sx={{ mb: 1 }}>
                Use
              </Typography>
              <Box sx={{ display: 'flex', gap: 1.5, flexWrap: 'wrap' }}>
                <Count label="Users connected" value={summary.usersConnected} />
                <Count label="Need to reconnect" value={summary.usersNeedingReconnect} />
                <Count label="Fields typed this week" value={summary.usesThisWeek} />
                <Count label="Refused this week" value={summary.refusalsThisWeek} />
              </Box>
              <Typography variant="body2" color="text.secondary" sx={{ mt: 1 }}>
                Counts only. You cannot see anyone&rsquo;s logins, sites or what they typed.
              </Typography>
            </Box>
          )}

          <BuiltinStoreCard canWrite={canWrite} />

          <DefaultClientCard canWrite={canWrite} />
        </Stack>
      )}
    </PageContainer>
  );
}
