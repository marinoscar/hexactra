import KeyOutlinedIcon from '@mui/icons-material/KeyOutlined';
import OpenInNewIcon from '@mui/icons-material/OpenInNew';
import { Alert, Box, Button, Chip, FormControlLabel, FormHelperText, Link, Paper, Stack, Switch, TextField, Typography } from '@mui/material';
import { usePlatformHost } from '@marinoscar/platform-web/core';
import { useCallback, useEffect, useId, useState, type FormEvent, type ReactNode } from 'react';
import { Link as RouterLink, useSearchParams } from 'react-router-dom';

import {
  connect,
  disconnect,
  getActivity,
  getDefaultUseSavedLogins,
  getReach,
  getStatus,
  saveClient,
  setAgentUse,
  setDefaultUseSavedLogins,
  type ActivityItem,
  type ActivityList,
  type Reach,
  type SecretsStatus,
  type VaultStatus,
} from '../secrets/api';
import { CONNECT_RESULT_WORDS, fieldsWords, hasWriteScope, outcomeWords, permissionWords, whatWords } from '../secrets/words';
import { CardSkeleton, EmptyState, ErrorBanner, ListSkeleton, PageContainer, PageHeader, RelativeTime, ResponsiveList, useApiAction, useConfirm, type Column } from '../ui';

const TOUCH = { minHeight: { xs: 44, sm: 'auto' } } as const;

/** The host of the Vault, for a sentence. */
function hostOf(url: string | null): string {
  if (!url) return '';
  try {
    return new URL(url).host;
  } catch {
    return url;
  }
}

/** A switch with its label and help, at least 44 px tall below `sm`, its help read with it. */
function SwitchRow({ label, help, checked, disabled, busy, onChange }: { label: string; help: ReactNode; checked: boolean; disabled?: boolean; busy?: boolean; onChange: (on: boolean) => void }) {
  const helpId = useId();
  return (
    <Box>
      <FormControlLabel
        sx={{ m: 0, minHeight: { xs: 44, sm: 'auto' }, alignItems: 'center' }}
        control={<Switch checked={checked} disabled={disabled || busy} onChange={(e) => onChange(e.target.checked)} slotProps={{ input: { 'aria-describedby': helpId } }} />}
        label={label}
      />
      <FormHelperText id={helpId} sx={{ mt: 0, ml: { xs: 0, sm: 6 } }}>
        {help}
      </FormHelperText>
    </Box>
  );
}

/** The address, client id and client secret form of a Vault that is not configured (or whose settings the owner changes). */
function ClientForm({ vault, busy, onSubmit, onCancel }: { vault: VaultStatus; busy: boolean; onSubmit: (v: { baseUrl: string; clientId: string; clientSecret?: string }) => void; onCancel?: () => void }) {
  const [baseUrl, setBaseUrl] = useState(vault.baseUrl ?? '');
  const [clientId, setClientId] = useState(vault.source === 'user' ? (vault.clientId ?? '') : '');
  const [clientSecret, setClientSecret] = useState('');
  const keepSecret = vault.source === 'user' && vault.hasClientSecret;
  const valid = baseUrl.trim() !== '' && clientId.trim() !== '' && (clientSecret !== '' || keepSecret);
  const submit = (e: FormEvent) => {
    e.preventDefault();
    if (valid) onSubmit({ baseUrl: baseUrl.trim(), clientId: clientId.trim(), ...(clientSecret ? { clientSecret } : {}) });
  };
  return (
    <Box component="form" onSubmit={submit} noValidate>
      <Stack spacing={2} sx={{ mt: 2 }}>
        <TextField label="Vault address" type="url" value={baseUrl} onChange={(e) => setBaseUrl(e.target.value)} placeholder="https://vault.example.test" required fullWidth helperText="Where your Vault runs. Only https addresses on the public internet are accepted." />
        <TextField label="Client ID" value={clientId} onChange={(e) => setClientId(e.target.value)} required fullWidth helperText="From the client your Vault administrator registered for Hexactra." />
        <TextField
          label="Client secret"
          type="password"
          value={clientSecret}
          onChange={(e) => setClientSecret(e.target.value)}
          required={!keepSecret}
          fullWidth
          autoComplete="off"
          helperText={keepSecret ? 'A secret is stored. Leave this empty to keep it.' : 'Stored encrypted and never shown again.'}
        />
        <Box sx={{ display: 'flex', gap: 1, flexWrap: 'wrap' }}>
          <Button type="submit" variant="contained" disabled={!valid || busy} sx={TOUCH}>
            Save and connect
          </Button>
          {onCancel && (
            <Button onClick={onCancel} sx={TOUCH}>
              Cancel
            </Button>
          )}
        </Box>
      </Stack>
    </Box>
  );
}

/** The provider card, in each of its states. */
function ProviderCard({ vault, canWrite, busy, onConnect, onSaveAndConnect, onDisconnect }: { vault: VaultStatus; canWrite: boolean; busy: string | null; onConnect: () => void; onSaveAndConnect: (v: { baseUrl: string; clientId: string; clientSecret?: string }) => void; onDisconnect: () => void }) {
  const [editing, setEditing] = useState(false);
  const permissions = permissionWords(vault.scopes);
  const working = busy !== null;

  let body: ReactNode;
  if (vault.status === 'connected' || vault.status === 'needs_reconnect') {
    const needs = vault.status === 'needs_reconnect';
    body = (
      <>
        <Stack direction="row" spacing={1} sx={{ alignItems: 'center', flexWrap: 'wrap', rowGap: 0.5 }}>
          <Typography variant="h6" component="h2">
            Vault
          </Typography>
          <Chip size="small" color={needs ? 'warning' : 'success'} label={needs ? 'Needs reconnecting' : 'Connected'} data-testid="provider-state" />
        </Stack>
        {needs && (
          <Alert severity="warning" sx={{ mt: 1.5 }}>
            Vault no longer accepts the saved connection (you may have removed Hexactra there, or the secret was changed). Until you reconnect, runs ask you to sign in by hand.
          </Alert>
        )}
        {vault.agentAccess === 'off' && !needs && (
          <Alert severity="info" sx={{ mt: 1.5 }}>
            Agent access is switched off in Vault. Ask its administrator to turn it on: until then nothing is released.
          </Alert>
        )}
        <Box component="dl" sx={{ m: 0, mt: 1.5, display: 'grid', gridTemplateColumns: { xs: '1fr', sm: 'max-content 1fr' }, columnGap: 3, rowGap: { xs: 0.25, sm: 0.75 }, '& dd': { m: 0, mb: { xs: 1, sm: 0 }, overflowWrap: 'anywhere' }, '& dt': { color: 'text.secondary' } }}>
          <dt>Vault address</dt>
          <dd data-testid="vault-address">{vault.baseUrl}</dd>
          <dt>Account</dt>
          <dd>{vault.vaultUserId ? `Your Vault account (${vault.vaultUserId.slice(0, 8)})` : 'Your Vault account'}</dd>
          <dt>Allowed to</dt>
          <dd>{permissions.length ? permissions.join(', ') : 'Nothing yet'}</dd>
          <dt>Last used</dt>
          <dd>{vault.lastUsedAt ? <RelativeTime iso={vault.lastUsedAt} /> : 'Never'}</dd>
        </Box>
        {canWrite && (
          <Box sx={{ display: 'flex', gap: 1, flexWrap: 'wrap', mt: 2 }}>
            {needs && (
              <Button variant="contained" onClick={onConnect} disabled={working} sx={TOUCH}>
                Reconnect
              </Button>
            )}
            <Button color="error" variant={needs ? 'text' : 'outlined'} onClick={onDisconnect} disabled={working} sx={TOUCH}>
              Disconnect
            </Button>
          </Box>
        )}
      </>
    );
  } else {
    const ready = vault.configured && !editing;
    body = (
      <>
        <Typography variant="h6" component="h2">
          Connect a secrets provider
        </Typography>
        <Typography sx={{ mt: 0.5 }} color="text.secondary">
          A secrets provider keeps your logins and one-time codes safe. Connect yours and the agent can sign in for you without ever seeing a password: Hexactra types it into the page and no one reads it on the way.
        </Typography>
        {vault.connecting && (
          <Alert severity="info" sx={{ mt: 1.5 }}>
            A connection was started and has not finished. Finish it in Vault, or start again.
          </Alert>
        )}
        {ready && (
          <Box sx={{ mt: 2 }}>
            <Typography variant="body2" color="text.secondary" data-testid="vault-address">
              Vault at {hostOf(vault.baseUrl)}
              {vault.source === 'deployment' ? ' (set by your administrator)' : ''}
            </Typography>
            {canWrite && (
              <Box sx={{ display: 'flex', gap: 1, flexWrap: 'wrap', mt: 1 }}>
                <Button variant="contained" onClick={onConnect} disabled={working} sx={TOUCH}>
                  Connect Vault
                </Button>
                <Button onClick={() => setEditing(true)} disabled={working} sx={TOUCH}>
                  Change Vault settings
                </Button>
              </Box>
            )}
          </Box>
        )}
        {!ready && canWrite && <ClientForm vault={vault} busy={working} onSubmit={onSaveAndConnect} onCancel={vault.configured ? () => setEditing(false) : undefined} />}
        {!ready && !canWrite && <Typography sx={{ mt: 2 }}>You can see this page but not change it.</Typography>}
      </>
    );
  }
  return (
    <Paper variant="outlined" component="section" aria-label="Secrets provider" sx={{ p: { xs: 2, sm: 3 } }}>
      {body}
    </Paper>
  );
}

const ACTIVITY_COLUMNS = (links: { runHref: (id: string) => string }): Column<ActivityItem>[] => [
  { key: 'at', header: 'When', width: 170, render: (i) => <RelativeTime iso={i.at} /> },
  { key: 'site', header: 'Site', render: (i) => i.site ?? 'Unknown site' },
  { key: 'what', header: 'What', hideBelow: 'lg', render: (i) => whatWords(i) },
  {
    key: 'run',
    header: 'Run',
    hideBelow: 'lg',
    render: (i) =>
      i.runId ? (
        <Link component={RouterLink} to={links.runHref(i.runId)}>
          Open run
        </Link>
      ) : (
        'n/a'
      ),
  },
  { key: 'outcome', header: 'Outcome', width: 270, render: (i) => <OutcomeChip item={i} /> },
];

function OutcomeChip({ item }: { item: ActivityItem }) {
  const text = outcomeWords(item.outcome);
  return <Chip size="small" variant={item.refused ? 'filled' : 'outlined'} color={item.refused ? 'warning' : 'success'} label={text} sx={{ height: 'auto', '& .MuiChip-label': { whiteSpace: 'normal', py: 0.5 } }} />;
}

function ActivitySection({ activity }: { activity: ActivityList }) {
  const columns = ACTIVITY_COLUMNS({ runHref: (id) => `/runs/${id}` });
  return (
    <Box component="section" aria-labelledby="activity-title">
      <Typography id="activity-title" variant="h6" component="h2" sx={{ mb: 0.5 }}>
        Activity
      </Typography>
      <Typography variant="body2" color="text.secondary" sx={{ mb: 1.5 }}>
        The last {activity.items.length === 100 ? '100 ' : ''}times the agent used your saved logins, including the ones it was refused. It never shows what was typed.
        {activity.providerActivityUrl && (
          <>
            {' '}
            <Link href={activity.providerActivityUrl} target="_blank" rel="noopener noreferrer">
              See your provider&rsquo;s own activity
              <OpenInNewIcon aria-hidden sx={{ fontSize: 14, ml: 0.5, verticalAlign: 'text-bottom' }} />
            </Link>
          </>
        )}
      </Typography>
      {activity.items.length === 0 ? (
        <EmptyState Icon={KeyOutlinedIcon} title="Nothing yet" body="When the agent signs in with a saved login, it shows up here with the site and what it typed." />
      ) : (
        <ResponsiveList
          aria-label="Saved login activity"
          items={activity.items}
          columns={columns}
          getKey={(i) => i.id}
          renderCard={(i) => (
            <Paper variant="outlined" sx={{ p: 1.5 }} data-testid={`activity-${i.id}`}>
              <Stack spacing={0.5}>
                <Typography sx={{ fontWeight: 500, overflowWrap: 'anywhere' }}>{i.site ?? 'Unknown site'}</Typography>
                <Typography variant="body2" color="text.secondary">
                  {whatWords(i)} · <RelativeTime iso={i.at} />
                </Typography>
                <Box>
                  <OutcomeChip item={i} />
                </Box>
                {i.runId && (
                  <Link component={RouterLink} to={`/runs/${i.runId}`} sx={{ ...TOUCH, display: 'inline-flex', alignItems: 'center' }}>
                    Open run
                  </Link>
                )}
              </Stack>
            </Paper>
          )}
        />
      )}
    </Box>
  );
}

function ReachSection({ reach, manageUrl }: { reach: Reach; manageUrl: string | null }) {
  return (
    <Box component="section" aria-labelledby="reach-title">
      <Typography id="reach-title" variant="h6" component="h2" sx={{ mb: 0.5 }}>
        What the agent can reach
      </Typography>
      <Typography variant="body2" color="text.secondary" sx={{ mb: 1.5 }}>
        Which logins are open to the agent is decided in your provider, not here. Vault can look logins up only for the page on screen, so the full list is in Vault; these are the ones the agent has used so far.
      </Typography>
      {reach.items.length === 0 ? (
        <Typography color="text.secondary">The agent has not used a saved login yet.</Typography>
      ) : (
        <Stack spacing={1} component="ul" sx={{ listStyle: 'none', p: 0, m: 0 }} aria-label="Logins used so far">
          {reach.items.map((r, i) => (
            <Paper key={`${r.site}-${i}`} component="li" variant="outlined" sx={{ p: 1.5, display: 'flex', flexDirection: { xs: 'column', sm: 'row' }, alignItems: { sm: 'center' }, gap: 1 }}>
              <Box sx={{ flexGrow: 1, minWidth: 0 }}>
                <Typography sx={{ fontWeight: 500, overflowWrap: 'anywhere' }}>{r.site ?? 'Unknown site'}</Typography>
                <Typography variant="body2" color="text.secondary">
                  Typed: {fieldsWords(r.fields)} · used {r.uses === 1 ? 'once' : `${r.uses} times`}, last <RelativeTime iso={r.lastUsedAt} />
                </Typography>
              </Box>
              {manageUrl && (
                <Link href={manageUrl} target="_blank" rel="noopener noreferrer" sx={{ ...TOUCH, display: 'inline-flex', alignItems: 'center' }} aria-label={`Manage ${r.site ?? 'this login'} in Vault`}>
                  Manage in Vault
                </Link>
              )}
            </Paper>
          ))}
        </Stack>
      )}
    </Box>
  );
}

/**
 * `/settings/secrets` (E37.4, #593): the owner's view of saved secrets. The provider card (connect, reconnect,
 * disconnect), the switches that turn the agent's use off, what the agent can reach, and what it used. Nothing here
 * shows or edits a login: that is the provider's job.
 */
export function SecretsSettingsPage() {
  const { api, viewer } = usePlatformHost();
  const confirm = useConfirm();
  const canWrite = viewer.hasPermission('secrets:write');
  const [params, setParams] = useSearchParams();
  const [status, setStatus] = useState<SecretsStatus | null>(null);
  const [activity, setActivity] = useState<ActivityList | null>(null);
  const [reach, setReach] = useState<Reach | null>(null);
  const [defaultOn, setDefaultOn] = useState(false);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [message, setMessage] = useState<{ severity: 'success' | 'info' | 'warning' | 'error'; text: string } | null>(null);
  const action = useApiAction('Could not change this');

  const load = useCallback(async () => {
    setLoadError(null);
    try {
      setStatus(await getStatus(api));
      // The lists are secondary: a failure of one does not hide the provider card.
      getActivity(api).then(setActivity, () => setActivity({ items: [], providerActivityUrl: null }));
      getReach(api).then(setReach, () => setReach({ listing: 'per_origin', items: [] }));
      getDefaultUseSavedLogins(api).then(setDefaultOn, () => setDefaultOn(false));
    } catch (e) {
      setLoadError(e instanceof Error && e.message ? e.message : 'Could not load your secrets settings');
    }
  }, [api]);
  useEffect(() => {
    void load();
  }, [load]);

  // Coming back from Vault's consent screen: say what happened once, then clean the address.
  const result = params.get('vault');
  useEffect(() => {
    if (!result) return;
    setMessage(CONNECT_RESULT_WORDS[result] ?? { severity: 'error', text: 'The connection did not finish.' });
    setParams(
      (p) => {
        p.delete('vault');
        return p;
      },
      { replace: true },
    );
  }, [result, setParams]);

  const vault = status?.providers.vault ?? null;

  const startConnect = (allowWrite: boolean) =>
    action.run('connect', async () => {
      const r = await connect(api, { allowWrite, returnTo: '/settings/secrets' });
      window.location.assign(r.authorizeUrl);
    });

  const saveAndConnect = (v: { baseUrl: string; clientId: string; clientSecret?: string }) =>
    action.run('connect', async () => {
      await saveClient(api, v);
      const r = await connect(api, { allowWrite: vault ? hasWriteScope(vault.scopes) : false, returnTo: '/settings/secrets' });
      window.location.assign(r.authorizeUrl);
    });

  const doDisconnect = async () => {
    const ok = await confirm({ title: 'Disconnect Vault?', body: 'Runs will ask you to sign in again.', confirmLabel: 'Disconnect', destructive: true });
    if (!ok) return;
    const r = await action.run('disconnect', () => disconnect(api));
    if (!r) return;
    setStatus(r.status);
    setMessage(r.revoked ? { severity: 'success', text: 'Vault is disconnected.' } : { severity: 'warning', text: 'Vault is disconnected here, but Vault could not be asked to forget Hexactra. Remove Hexactra in Vault under Connected apps.' });
  };

  const toggleUse = async (on: boolean) => {
    const saved = await action.run('use', () => setAgentUse(api, on));
    if (saved === undefined) return;
    setStatus((s) => (s ? { ...s, agentUse: { ...s.agentUse, user: saved, effective: s.agentUse.deployment && saved } } : s));
    setMessage({ severity: 'info', text: saved ? 'The agent may use your saved logins.' : 'The agent will not use your saved logins.' });
  };

  const toggleDefault = async (on: boolean) => {
    const saved = await action.run('default', () => setDefaultUseSavedLogins(api, on));
    if (saved === undefined) return;
    setDefaultOn(saved);
    setMessage({ severity: 'info', text: saved ? 'New tasks and chats will start with saved logins on.' : 'New tasks and chats will start with saved logins off.' });
  };

  const toggleWrite = async (on: boolean) => {
    if (!on) {
      const ok = await confirm({ title: 'Stop letting the agent save and change logins?', body: 'You will go to Vault to approve a connection without that permission.', confirmLabel: 'Continue' });
      if (!ok) return;
    }
    await startConnect(on);
  };

  const deploymentOff = status !== null && !status.agentUse.deployment;
  const connected = vault?.status === 'connected';
  const manageUrl = vault?.status === 'connected' && vault.baseUrl ? vault.baseUrl : null;

  return (
    <PageContainer>
      <PageHeader title="Secrets" subtitle="Let the agent sign in with the logins in your own provider, without it ever seeing them." back={{ to: '/settings', label: 'Settings' }} />
      <ErrorBanner error={loadError ?? action.error} onRetry={loadError ? () => void load() : undefined} onClose={loadError ? undefined : action.clearError} />
      {/* One polite live region: every outcome of a switch, connect or disconnect is announced here. */}
      <Box role="status" aria-live="polite" sx={{ mb: message ? 2 : 0 }}>
        {message && (
          <Alert severity={message.severity} onClose={() => setMessage(null)}>
            {message.text}
          </Alert>
        )}
      </Box>
      {deploymentOff && (
        <Alert severity="info" sx={{ mb: 2 }} data-testid="deployment-off">
          An administrator has turned off saved secrets for this deployment. The agent will not use your saved logins, whatever you choose here.
        </Alert>
      )}
      {!status && !loadError && (
        <Stack spacing={2}>
          <CardSkeleton />
          <ListSkeleton rows={3} />
        </Stack>
      )}
      {status && vault && (
        <Stack spacing={4}>
          <ProviderCard vault={vault} canWrite={canWrite} busy={action.busy} onConnect={() => void startConnect(hasWriteScope(vault.scopes))} onSaveAndConnect={(v) => void saveAndConnect(v)} onDisconnect={() => void doDisconnect()} />

          <Paper variant="outlined" component="section" aria-labelledby="switches-title" sx={{ p: { xs: 2, sm: 3 } }}>
            <Typography id="switches-title" variant="h6" component="h2" sx={{ mb: 1 }}>
              What the agent may do
            </Typography>
            <Stack spacing={1.5}>
              <SwitchRow
                label="Let the agent use saved logins"
                help={deploymentOff ? 'Turned off by an administrator for this deployment.' : 'When it reaches a sign-in page for a site you have a saved login for, it signs in and does not ask. It never sees the password or code. Off by default.'}
                checked={status.agentUse.user}
                disabled={!canWrite || deploymentOff}
                busy={action.busy === 'use'}
                onChange={(on) => void toggleUse(on)}
              />
              <SwitchRow
                label="Use saved logins in new tasks and chats"
                help="Each task and chat has its own switch, “Use my saved logins”. This sets where a new one starts and changes nothing that already exists. Off by default."
                checked={defaultOn}
                disabled={!canWrite}
                busy={action.busy === 'default'}
                onChange={(on) => void toggleDefault(on)}
              />
              <SwitchRow
                label="Let the agent save and change logins"
                help={
                  !connected
                    ? 'Connect your provider first.'
                    : 'Asks Vault for permission to save and change logins. You approve it in Vault. Saving a sign-in from a run is not available yet.'
                }
                checked={connected && hasWriteScope(vault.scopes)}
                disabled={!canWrite || !connected}
                busy={action.busy === 'connect'}
                onChange={(on) => void toggleWrite(on)}
              />
            </Stack>
          </Paper>

          {reach && <ReachSection reach={reach} manageUrl={manageUrl} />}
          {activity ? <ActivitySection activity={activity} /> : <ListSkeleton rows={3} />}
        </Stack>
      )}
    </PageContainer>
  );
}
