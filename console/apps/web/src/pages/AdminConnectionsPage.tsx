import ContentCopyIcon from '@mui/icons-material/ContentCopy';
import { Alert, Box, Button, FormControlLabel, FormHelperText, IconButton, InputAdornment, Paper, Stack, Switch, TextField, Typography } from '@mui/material';
import { usePlatformHost } from '@marinoscar/platform-web/core';
import { useCallback, useEffect, useId, useState, type FormEvent } from 'react';

import { getAdminApps, getAdminMcp, removeAdminApp, saveAdminApp, saveAdminMcp, type AdminProvider, type McpAdmin } from '../connections/api';
import { CardSkeleton, ErrorBanner, PageContainer, PageHeader, toast, useApiAction, useConfirm } from '../ui';

const TOUCH = { minHeight: { xs: 44, sm: 'auto' } } as const;

/** One provider's app: the switch, the client id, the write-only secret, the tenant (Microsoft), the redirect URI to copy and the setup checklist. */
function ProviderCard({ provider, canWrite, onChange }: { provider: AdminProvider; canWrite: boolean; onChange: (all: AdminProvider[]) => void }) {
  const { api } = usePlatformHost();
  const confirm = useConfirm();
  const action = useApiAction(`Could not save ${provider.displayName}`);
  const id = useId();
  const [enabled, setEnabled] = useState(provider.enabled);
  const [clientId, setClientId] = useState(provider.clientId ?? '');
  const [clientSecret, setClientSecret] = useState('');
  const [tenant, setTenant] = useState(provider.tenant ?? 'common');
  useEffect(() => {
    setEnabled(provider.enabled);
    setClientId(provider.clientId ?? '');
    setClientSecret('');
    setTenant(provider.tenant ?? 'common');
  }, [provider]);

  const complete = clientId.trim().length > 0 && (provider.hasClientSecret || clientSecret.length > 0);

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    const all = await action.run('save', () =>
      saveAdminApp(api, provider.provider, { enabled: enabled && complete, clientId: clientId.trim() || null, ...(clientSecret ? { clientSecret } : {}), ...(provider.provider === 'microsoft' ? { tenant: tenant.trim() || 'common' } : {}) }),
    );
    if (all) {
      onChange(all);
      toast(`${provider.displayName} saved`);
    }
  };

  const remove = async () => {
    const ok = await confirm({
      title: `Remove the ${provider.displayName} app?`,
      body: 'This removes the client id and secret and switches the provider off. Connected accounts stay, but cannot refresh their sign-in until an app is set again.',
      confirmLabel: 'Remove',
      destructive: true,
    });
    if (!ok) return;
    const all = await action.run('remove', () => removeAdminApp(api, provider.provider));
    if (all) {
      onChange(all);
      toast(`${provider.displayName} app removed`);
    }
  };

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(provider.redirectUri);
      toast('Redirect URI copied');
    } catch {
      toast('Select the address and copy it', 'info');
    }
  };

  return (
    <Paper variant="outlined" component="section" aria-labelledby={`${id}-title`} sx={{ p: { xs: 2, sm: 3 } }}>
      <Typography id={`${id}-title`} variant="h6" component="h2">
        {provider.displayName}
      </Typography>
      <Typography variant="body2" color="text.secondary" sx={{ mt: 0.5 }}>
        Your own app at {provider.displayName}: users connect their accounts through it. Their accounts and tokens are never visible here.
      </Typography>
      {!provider.installed && (
        <Alert severity="info" sx={{ mt: 1.5 }}>
          The code for {provider.displayName} is not installed on this deployment yet, so users cannot connect it even when it is switched on.
        </Alert>
      )}
      <ErrorBanner error={action.error} onClose={action.clearError} />

      <Typography variant="subtitle2" component="h3" sx={{ mt: 2 }}>
        Setup checklist
      </Typography>
      <Box component="ol" sx={{ m: 0, mt: 0.5, pl: 2.5 }}>
        {provider.setupSteps.map((s, i) => (
          <li key={i}>
            <Typography variant="body2">{s}</Typography>
          </li>
        ))}
      </Box>

      <TextField
        label="Redirect URI"
        value={provider.redirectUri}
        margin="normal"
        fullWidth
        slotProps={{
          input: {
            readOnly: true,
            endAdornment: (
              <InputAdornment position="end">
                <IconButton aria-label={`Copy the ${provider.displayName} redirect URI`} onClick={() => void copy()} edge="end" sx={{ minWidth: 44, minHeight: 44 }}>
                  <ContentCopyIcon />
                </IconButton>
              </InputAdornment>
            ),
          },
        }}
        helperText="Register exactly this address at the provider."
      />

      <Box component="form" onSubmit={(e: FormEvent) => void submit(e)} sx={{ mt: 1 }}>
        <Stack spacing={2}>
          <TextField label="Client ID" value={clientId} onChange={(e) => setClientId(e.target.value)} disabled={!canWrite} fullWidth autoComplete="off" />
          <TextField
            label="Client secret"
            type="password"
            value={clientSecret}
            onChange={(e) => setClientSecret(e.target.value)}
            disabled={!canWrite}
            fullWidth
            autoComplete="new-password"
            placeholder={provider.hasClientSecret ? '•••••••• (stored)' : ''}
            helperText={provider.hasClientSecret ? 'A secret is stored. Leave this blank to keep it.' : 'Write-only: it is never shown again.'}
          />
          {provider.provider === 'microsoft' && (
            <TextField label="Tenant" value={tenant} onChange={(e) => setTenant(e.target.value)} disabled={!canWrite} fullWidth helperText="common (work, school and personal accounts), organizations, consumers, or a tenant id." />
          )}
          <div>
            <FormControlLabel control={<Switch checked={enabled} onChange={(e) => setEnabled(e.target.checked)} disabled={!canWrite || !complete} />} label={`Let users connect ${provider.displayName}`} />
            {!complete && <FormHelperText>Set the client id and secret first.</FormHelperText>}
          </div>
          {canWrite && (
            <Stack direction={{ xs: 'column', sm: 'row' }} spacing={1}>
              <Button type="submit" variant="contained" disabled={action.busy !== null} sx={TOUCH}>
                Save
              </Button>
              <Button color="error" onClick={() => void remove()} disabled={action.busy !== null || (!provider.clientId && !provider.hasClientSecret)} sx={TOUCH}>
                Remove the app
              </Button>
            </Stack>
          )}
        </Stack>
      </Box>
    </Paper>
  );
}

const toLines = (v: string): string[] => [...new Set(v.split(/[\s,]+/).map((x) => x.trim().toLowerCase()).filter(Boolean))];

/** MCP servers (E39.9): the deployment switch (off by default) and the allow-list and block-list of hosts. */
function McpCard({ settings, canWrite, onChange }: { settings: McpAdmin; canWrite: boolean; onChange: (s: McpAdmin) => void }) {
  const { api } = usePlatformHost();
  const action = useApiAction('Could not save the MCP settings');
  const id = useId();
  const [enabled, setEnabled] = useState(settings.enabled);
  const [allowed, setAllowed] = useState(settings.allowedHosts.join('\n'));
  const [blocked, setBlocked] = useState(settings.blockedHosts.join('\n'));
  useEffect(() => {
    setEnabled(settings.enabled);
    setAllowed(settings.allowedHosts.join('\n'));
    setBlocked(settings.blockedHosts.join('\n'));
  }, [settings]);

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    const saved = await action.run('save', () => saveAdminMcp(api, { enabled, allowedHosts: toLines(allowed), blockedHosts: toLines(blocked) }));
    if (saved) {
      onChange(saved);
      toast('MCP settings saved');
    }
  };

  return (
    <Paper variant="outlined" component="section" aria-labelledby={`${id}-title`} sx={{ p: { xs: 2, sm: 3 } }}>
      <Typography id={`${id}-title`} variant="h6" component="h2">
        MCP servers
      </Typography>
      <Typography variant="body2" color="text.secondary" sx={{ mt: 0.5 }}>
        Lets users add an MCP server (Streamable HTTP only) as a connection, so the agent can use its tools. Every tool starts off, a tool that changes something asks the user first, and nothing runs on this server or a node: Hexactra only makes https requests. Their servers, tools and sign-ins are never visible here.
      </Typography>
      <ErrorBanner error={action.error} onClose={action.clearError} />
      <Box component="form" onSubmit={(e: FormEvent) => void submit(e)} sx={{ mt: 2 }}>
        <Stack spacing={2}>
          <FormControlLabel control={<Switch checked={enabled} onChange={(e) => setEnabled(e.target.checked)} disabled={!canWrite} />} label="Let users add and use MCP servers" />
          <TextField
            label="Allowed hosts"
            value={allowed}
            onChange={(e) => setAllowed(e.target.value)}
            disabled={!canWrite}
            multiline
            minRows={2}
            fullWidth
            placeholder={'mcp.example.test\n*.example.test'}
            helperText="One per line: a host name or *.domain. Empty: any public host. Private and internal addresses are never allowed."
          />
          <TextField label="Blocked hosts" value={blocked} onChange={(e) => setBlocked(e.target.value)} disabled={!canWrite} multiline minRows={2} fullWidth helperText="One per line. A blocked host is refused even when the allowed list names it." />
          {canWrite && (
            <Stack direction={{ xs: 'column', sm: 'row' }} spacing={1}>
              <Button type="submit" variant="contained" disabled={action.busy !== null} sx={TOUCH}>
                Save
              </Button>
            </Stack>
          )}
        </Stack>
      </Box>
    </Paper>
  );
}

/** `/admin/settings/connections` (E39.2, #599): the deployment's apps at Google and Microsoft. It never shows a user's connections. */
export function AdminConnectionsPage() {
  const { api, viewer } = usePlatformHost();
  const action = useApiAction('Could not load the providers');
  const canWrite = viewer.hasPermission('system_settings:write');
  const [providers, setProviders] = useState<AdminProvider[] | null>(null);
  const [mcp, setMcp] = useState<McpAdmin | null>(null);
  const { setError } = action;

  const load = useCallback(async () => {
    try {
      const [apps, mcpSettings] = await Promise.all([getAdminApps(api), getAdminMcp(api).catch(() => null)]);
      setProviders(apps);
      setMcp(mcpSettings);
    } catch (e) {
      setError(e instanceof Error && e.message ? e.message : 'Could not load the providers');
      setProviders([]);
    }
  }, [api, setError]);
  useEffect(() => {
    void load();
  }, [load]);

  return (
    <PageContainer width="narrow">
      <PageHeader title="Connections" subtitle="The apps your users connect their Google and Microsoft accounts through (create each at the provider, then set it here), and whether they may add MCP servers." back={{ to: '/admin/settings', label: 'Administration' }} />
      <ErrorBanner error={action.error} onClose={action.clearError} onRetry={() => void load()} />
      {providers === null && <CardSkeleton />}
      <Stack spacing={3}>
        {providers?.map((p) => (
          <ProviderCard key={p.provider} provider={p} canWrite={canWrite} onChange={setProviders} />
        ))}
        {mcp && <McpCard settings={mcp} canWrite={canWrite} onChange={setMcp} />}
      </Stack>
    </PageContainer>
  );
}
