import LinkOffOutlinedIcon from '@mui/icons-material/LinkOffOutlined';
import { Alert, Box, Button, Checkbox, Divider, FormControlLabel, InputAdornment, ListItemText, MenuItem, Paper, Stack, Switch, TextField, Typography } from '@mui/material';
import { usePlatformHost } from '@marinoscar/platform-web/core';
import { useCallback, useEffect, useMemo, useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';

import { ScopeChips } from '../aiApps/ScopeChips';
import { draftErrors, draftPatch, toDraft, type AppLimits, type ConnectedApp, type LimitsDraft } from '../aiApps/types';
import { AllowedSitesInput } from '../components/AllowedSitesInput';
import { AppActivityList } from '../components/AppActivityList';
import { RunList } from '../components/RunList';
import { PolicySelect } from '../policies/PolicySelect';
import { usePolicyCatalog } from '../policies/usePolicyCatalog';
import { CardSkeleton, ErrorBanner, PageContainer, PageHeader, RelativeTime, aboveBottomBar, formatCost, useApiAction, useConfirm } from '../ui';
import { AppName, usageText } from './AiAppsPage';

/**
 * `/settings/ai-apps/:clientId` (#464): one AI app. What it may do (its
 * scopes with the consent text), its limits (policy, allowed policies, sites,
 * runs at once, runs and spend per day, confirm purchases, confirm sensitive
 * browser actions, #465), its activity (the audit trail, #465), its recent runs,
 * Pause, and Disconnect (the platform's `DELETE /api/oauth/grants/:id`, the
 * same grant the "Connected apps" page revokes). A limit only narrows what the
 * app may do: it never widens a task's own allowed sites or confirmation.
 */
export function AiAppDetailPage() {
  const { clientId = '' } = useParams();
  const { api, viewer } = usePlatformHost();
  const navigate = useNavigate();
  const confirm = useConfirm();
  const canWrite = viewer.hasPermission('connected_apps:write');
  const canReadRuns = viewer.hasPermission('runs:read');
  const catalog = usePolicyCatalog({ withTiers: false });
  const action = useApiAction('Could not save the limits');
  const [app, setApp] = useState<ConnectedApp | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [draft, setDraft] = useState<LimitsDraft | null>(null);
  const [saved, setSaved] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoadError(null);
    try {
      const a = await api.get<ConnectedApp>(`/connected-apps/${encodeURIComponent(clientId)}`);
      setApp(a);
      setDraft(toDraft(a.limits));
    } catch (e) {
      setLoadError(e instanceof Error ? e.message : 'Could not load the app');
    }
  }, [api, clientId]);
  useEffect(() => {
    void load();
  }, [load]);

  const errors = useMemo(() => (draft ? draftErrors(draft) : {}), [draft]);
  const patch = useMemo(() => (draft && app && Object.keys(errors).length === 0 ? draftPatch(draft, app.limits) : {}), [draft, app, errors]);
  const dirty = Object.keys(patch).length > 0;

  const applyLimits = (limits: AppLimits) => {
    setApp((a) => (a ? { ...a, limits } : a));
    setDraft(toDraft(limits));
  };

  const save = () =>
    void action.run('save', async () => {
      applyLimits(await api.patch<AppLimits>(`/connected-apps/${encodeURIComponent(clientId)}/settings`, patch));
      setSaved('Limits saved.');
    });

  const setPaused = (paused: boolean) =>
    void action.run('pause', async () => {
      const limits = await api.patch<AppLimits>(`/connected-apps/${encodeURIComponent(clientId)}/settings`, { paused });
      setApp((a) => (a ? { ...a, limits: { ...a.limits, paused: limits.paused } } : a));
    });

  const disconnect = async () => {
    if (!app?.grantId) return;
    const ok = await confirm({
      title: `Disconnect ${app.displayName}?`,
      body: `${app.displayName} is signed out on its next call and can no longer start runs or read your inbox. Runs it started stay, with its name. You can connect it again later.`,
      confirmLabel: 'Disconnect',
      destructive: true,
    });
    if (!ok) return;
    const done = await action.run('disconnect', async () => {
      await api.delete(`/oauth/grants/${encodeURIComponent(app.grantId!)}`);
      return true;
    }, 'Could not disconnect the app');
    if (done) navigate('/settings/ai-apps', { replace: true });
  };

  if (!app || !draft) {
    return (
      <PageContainer>
        <PageHeader title="AI app" back={{ to: '/settings/ai-apps', label: 'AI apps' }} />
        <ErrorBanner error={loadError} onRetry={() => void load()} />
        {!loadError && <CardSkeleton />}
      </PageContainer>
    );
  }

  const set = (next: Partial<LimitsDraft>) => {
    setSaved(null);
    setDraft((d) => (d ? { ...d, ...next } : d));
  };
  const policies = catalog.policies;
  const disabled = !canWrite || action.busy !== null;

  return (
    <PageContainer>
      <PageHeader
        title={app.displayName}
        back={{ to: '/settings/ai-apps', label: 'AI apps' }}
        actions={[{ key: 'disconnect', label: 'Disconnect', Icon: LinkOffOutlinedIcon, color: 'error', onClick: () => void disconnect(), hidden: !app.grantId || !canWrite }]}
      />
      <ErrorBanner error={action.error} onClose={action.clearError} />
      {!app.grantId && <Alert severity="info" sx={{ mb: 2 }}>{app.removed ? 'This app was removed by an administrator.' : 'This app is no longer connected.'} Its runs stay, with its name.</Alert>}

      <Paper variant="outlined" sx={{ p: { xs: 2, sm: 3 }, mb: 3 }}>
        <AppName app={app} />
        <Typography variant="body2" color="text.secondary" sx={{ mt: 1 }}>
          {app.connectedAt ? (
            <>
              Connected <RelativeTime iso={app.connectedAt} />
            </>
          ) : (
            'Not connected'
          )}
          {' · '}
          {app.lastUsedAt ? <RelativeTime iso={app.lastUsedAt} prefix="last used " /> : 'never used'}
          {' · '}
          {usageText(app)} in 30 days{app.usage.liveRuns > 0 ? ` · ${app.usage.liveRuns} working now` : ''} · today {app.usage.runsToday} {app.usage.runsToday === 1 ? 'run' : 'runs'}
          {app.usage.costTodayUsd > 0 ? `, ${formatCost(app.usage.costTodayUsd)}` : ''}
        </Typography>
        {app.scopes.length > 0 && (
          <>
            <Typography variant="subtitle2" component="h2" sx={{ mt: 2, mb: 1 }}>
              What it may do
            </Typography>
            <ScopeChips scopes={app.scopes} />
            <Box component="ul" sx={{ pl: 2.5, mt: 1, mb: 0 }}>
              {app.scopes
                .filter((s) => s.id !== 'offline_access')
                .map((s) => (
                  <Typography key={s.id} component="li" variant="body2" color={s.risk === 'low' ? 'text.secondary' : 'warning.main'}>
                    {s.consent}
                  </Typography>
                ))}
            </Box>
          </>
        )}
      </Paper>

      <Paper variant="outlined" component="section" aria-labelledby="app-limits-title" sx={{ p: { xs: 2, sm: 3 }, mb: 3 }}>
        <Typography id="app-limits-title" variant="h6" component="h2">
          Limits
        </Typography>
        <Typography variant="body2" color="text.secondary" sx={{ mb: 2 }}>
          What this app may do with your agent. A limit only narrows: it never widens a task's own sites or confirmation.
        </Typography>
        <FormControlLabel
          control={<Switch checked={app.limits.paused} disabled={disabled} onChange={(e) => setPaused(e.target.checked)} />}
          label={app.limits.paused ? 'Paused: it cannot start runs or browser sessions. Runs already working continue.' : 'Paused'}
          sx={{ mb: 2 }}
        />
        <Divider sx={{ mb: 2 }} />
        <Stack spacing={2.5}>
          <PolicySelect
            catalog={catalog}
            value={draft.policyId}
            onChange={(policyId) => set({ policyId })}
            label="Agent policy"
            nullLabel="Your default"
            manageLink
            disabled={disabled}
            error={errors.policyId}
            id="app-policy"
          />
          <TextField
            select
            fullWidth
            label="Policies it may choose"
            value={draft.allowedPolicyIds}
            disabled={disabled}
            onChange={(e) => {
              const v = e.target.value as unknown as string[] | string;
              set({ allowedPolicyIds: (Array.isArray(v) ? v : v.split(',')).filter(Boolean) });
            }}
            helperText="Leave empty to let it name any policy. A policy it names outside this list is refused."
            slotProps={{
              select: { multiple: true, displayEmpty: true, renderValue: (v) => ((v as string[]).length ? (v as string[]).map((id) => catalog.byId(id)?.name ?? id).join(', ') : 'Any') },
              inputLabel: { shrink: true },
              htmlInput: { 'data-testid': 'allowed-policies' },
            }}
          >
            {policies.map((p) => (
              <MenuItem key={p.id} value={p.id}>
                <Checkbox size="small" checked={draft.allowedPolicyIds.includes(p.id)} sx={{ py: 0 }} />
                <ListItemText primary={p.name} />
              </MenuItem>
            ))}
          </TextField>
          <Box>
            <Typography variant="body2" sx={{ mb: 0.5 }}>
              Sites it may visit
            </Typography>
            <AllowedSitesInput value={draft.allowedDomains} onChange={(allowedDomains) => set({ allowedDomains })} disabled={disabled} id="app-sites" />
            <Typography variant="caption" color="text.secondary">
              A task's own sites still apply: the app's runs may visit only sites both allow.
            </Typography>
          </Box>
          <Stack direction={{ xs: 'column', sm: 'row' }} spacing={2}>
            <TextField
              label="Runs at once"
              type="number"
              value={draft.maxConcurrentRuns}
              onChange={(e) => set({ maxConcurrentRuns: e.target.value })}
              error={Boolean(errors.maxConcurrentRuns)}
              helperText={errors.maxConcurrentRuns ?? 'Runs and browser sessions working at the same time'}
              disabled={disabled}
              fullWidth
              slotProps={{ htmlInput: { min: 1, inputMode: 'numeric' } }}
            />
            <TextField
              label="Runs per day"
              type="number"
              value={draft.dailyRunLimit}
              onChange={(e) => set({ dailyRunLimit: e.target.value })}
              error={Boolean(errors.dailyRunLimit)}
              helperText={errors.dailyRunLimit ?? 'In your time zone'}
              disabled={disabled}
              fullWidth
              slotProps={{ htmlInput: { min: 1, inputMode: 'numeric' } }}
            />
            <TextField
              label="Spend per day"
              value={draft.dailyCostLimitUsd}
              onChange={(e) => set({ dailyCostLimitUsd: e.target.value })}
              error={Boolean(errors.dailyCostLimitUsd)}
              helperText={errors.dailyCostLimitUsd ?? 'Empty: no limit'}
              disabled={disabled}
              fullWidth
              placeholder="No limit"
              slotProps={{ input: { startAdornment: <InputAdornment position="start">$</InputAdornment> }, htmlInput: { inputMode: 'decimal' } }}
            />
          </Stack>
          <FormControlLabel
            control={<Switch checked={draft.confirmPurchases} disabled={disabled} onChange={(e) => set({ confirmPurchases: e.target.checked })} />}
            label="Always ask me before purchases and other irreversible steps, even when the task does not"
          />
          <Box>
            <FormControlLabel
              control={<Switch checked={draft.confirmSensitiveActions} disabled={disabled} onChange={(e) => set({ confirmSensitiveActions: e.target.checked })} />}
              label="Ask me before its sensitive browser actions"
            />
            <Typography variant="caption" color="text.secondary" component="p" sx={{ ml: { xs: 0, sm: 6 } }}>
              When it drives a browser itself: typing a code or password you gave, acting on a page with a password or payment field, opening a sensitive site, using the desktop, or running JavaScript that can send data away. You approve in your Hexactra inbox; the app cannot approve for you.
            </Typography>
          </Box>
          <Box>
            <FormControlLabel
              control={<Switch checked={draft.allowSavedLogins} disabled={disabled} onChange={(e) => set({ allowSavedLogins: e.target.checked })} />}
              label="Let it sign in with my saved logins"
            />
            <Typography variant="caption" color="text.secondary" component="p" sx={{ ml: { xs: 0, sm: 6 } }}>
              Off by default. When on, its runs may sign in to a site you saved a login for, without asking you, if the task or chat also allows it and your Secrets switches are on. The app never sees the login, the password or the code: it only gets the run's answer.
            </Typography>
          </Box>
          <Box>
            <FormControlLabel
              control={<Switch checked={draft.allowSavedIdentity} disabled={disabled || !draft.allowSavedLogins} onChange={(e) => set({ allowSavedIdentity: e.target.checked })} />}
              label="Let it fill my saved identity details"
            />
            <Typography variant="caption" color="text.secondary" component="p" sx={{ ml: { xs: 0, sm: 6 } }}>
              Off by default, and it needs the switch above. When on, its runs may fill a form with details you saved (a date of birth, an ID number, an address) if the task or chat also allows it. The app never sees them: it only gets the run&apos;s answer.
            </Typography>
          </Box>
          <Box>
            <FormControlLabel
              control={<Switch checked={draft.allowWebSearch} disabled={disabled} onChange={(e) => set({ allowWebSearch: e.target.checked })} />}
              label="Let its runs search the web"
            />
            <Typography variant="caption" color="text.secondary" component="p" sx={{ ml: { xs: 0, sm: 6 } }} data-testid="app-web-search-help">
              On by default: when you set up web search and switched it on, this app&apos;s runs can search the web and read public pages without the browser, like every task and chat. The app itself never calls the search provider.
            </Typography>
          </Box>
          <Box>
            <FormControlLabel
              control={<Switch checked={draft.allowSavedCards} disabled={disabled || !draft.allowSavedLogins} onChange={(e) => set({ allowSavedCards: e.target.checked })} />}
              label="Let it pay with my saved cards"
            />
            <Typography variant="caption" color="text.secondary" component="p" sx={{ ml: { xs: 0, sm: 6 } }}>
              Off by default, and it needs the first switch above. When on, its runs may pay with a card you saved if the task or chat also allows it, at a shop and an amount you approved. The app never sees the card. With &quot;ask me before purchases&quot; on, every card use still asks you.
            </Typography>
          </Box>
          <Box>
            <FormControlLabel
              control={<Switch checked={draft.allowConnections} disabled={disabled} onChange={(e) => set({ allowConnections: e.target.checked })} />}
              label="Let its runs use my connected accounts and tools"
            />
            <Typography variant="caption" color="text.secondary" component="p" sx={{ ml: { xs: 0, sm: 6 } }} data-testid="app-connections-help">
              On by default for a new app: its runs can use what you switched on in Connections and tools, like every task and chat. An app you added before keeps the setting it had. Sending or changing something still asks you first, and the app itself never sees or calls your accounts: it only gets the run&apos;s answer.
            </Typography>
          </Box>
        </Stack>
        {canWrite && (
          <Box sx={{ position: { xs: 'sticky', sm: 'static' }, bottom: aboveBottomBar(0), bgcolor: 'background.paper', pt: 2, display: 'flex', gap: 1, alignItems: 'center', flexWrap: 'wrap' }}>
            <Button variant="contained" onClick={save} disabled={!dirty || action.busy !== null} sx={{ minHeight: 44 }}>
              Save limits
            </Button>
            <Button onClick={() => setDraft(toDraft(app.limits))} disabled={!dirty && Object.keys(errors).length === 0} sx={{ minHeight: 44 }}>
              Reset
            </Button>
            <Typography role="status" variant="body2" color="success.main">
              {saved}
            </Typography>
          </Box>
        )}
      </Paper>

      {canReadRuns && (
        <Box component="section" aria-labelledby="app-activity-title" sx={{ mb: 3 }}>
          <Typography id="app-activity-title" variant="h6" component="h2" sx={{ mb: 0.5 }}>
            Activity
          </Typography>
          <Typography variant="body2" color="text.secondary" sx={{ mb: 1 }}>
            Every tool call this app made, and what was refused. Never what was typed, a script or a result.
          </Typography>
          <AppActivityList path="/connected-apps/activity" clientId={app.clientId} />
        </Box>
      )}

      {canReadRuns && (
        <Box component="section" aria-labelledby="app-runs-title">
          <Typography id="app-runs-title" variant="h6" component="h2" sx={{ mb: 1 }}>
            Runs by this app
          </Typography>
          <RunList scope={{ clientId: app.clientId }} compact />
        </Box>
      )}
    </PageContainer>
  );
}
