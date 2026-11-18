import AddLinkOutlinedIcon from '@mui/icons-material/AddLinkOutlined';
import SmartToyOutlinedIcon from '@mui/icons-material/SmartToyOutlined';
import VerifiedOutlinedIcon from '@mui/icons-material/VerifiedOutlined';
import { Box, CardActionArea, FormControlLabel, Link, Paper, Stack, Switch, Tooltip, Typography } from '@mui/material';
import { usePlatformHost } from '@marinoscar/platform-web/core';
import { useCallback, useEffect, useState } from 'react';
import { Link as RouterLink, useNavigate } from 'react-router-dom';

import { ScopeChips } from '../aiApps/ScopeChips';
import type { AppLimits, ConnectedApp } from '../aiApps/types';
import { EmptyState, ErrorBanner, ListSkeleton, PageContainer, PageHeader, RelativeTime, ResponsiveList, formatCost, useApiAction, type Column } from '../ui';

/** The guide's route. */
export const CONNECT_PATH = '/settings/ai-apps/connect';

/** "3 runs · $0.42" over the last 30 days. */
export function usageText(a: ConnectedApp): string {
  const runs = `${a.usage.runs30d} ${a.usage.runs30d === 1 ? 'run' : 'runs'}`;
  const cost = a.usage.runs30d > 0 ? formatCost(a.usage.costUsd30d, a.usage.costKnown) : null;
  return cost ? `${runs} · ${cost}` : runs;
}

/** The app's name, its host and a verified mark. */
export function AppName({ app }: { app: ConnectedApp }) {
  return (
    <Box sx={{ minWidth: 0 }}>
      <Stack direction="row" spacing={0.5} sx={{ alignItems: 'center', minWidth: 0 }}>
        <SmartToyOutlinedIcon fontSize="small" color="action" aria-hidden />
        <Typography sx={{ fontWeight: 500, overflowWrap: 'anywhere' }}>{app.displayName}</Typography>
        {app.verified && (
          <Tooltip title="A sign-in your console knows: the name comes from where the app signs in, not from the app itself.">
            <VerifiedOutlinedIcon fontSize="small" color="success" aria-label="Verified" data-testid="app-verified" />
          </Tooltip>
        )}
      </Stack>
      <Typography variant="caption" color="text.secondary" sx={{ display: 'block', overflowWrap: 'anywhere' }}>
        {[app.host ?? app.name, app.selfName && app.selfName !== app.displayName ? `calls itself "${app.selfName}"` : null, app.removed ? 'removed app' : null].filter(Boolean).join(' · ')}
      </Typography>
    </Box>
  );
}

/**
 * `/settings/ai-apps` (#464): the AI apps connected to the signed-in user's
 * account (ChatGPT, Claude, ...), what each may do, when it was connected and
 * last used, its runs and spend over 30 days, and a Paused switch. The detail
 * page holds its limits and Disconnect. Disconnecting anything OAuth is also
 * on the platform's "Connected apps" page; both use the same grants.
 */
export function AiAppsPage() {
  const { api, viewer } = usePlatformHost();
  const navigate = useNavigate();
  const canWrite = viewer.hasPermission('connected_apps:write');
  const [apps, setApps] = useState<ConnectedApp[] | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const action = useApiAction('Could not change the app');

  const load = useCallback(async () => {
    setLoadError(null);
    try {
      setApps(await api.get<ConnectedApp[]>('/connected-apps'));
    } catch (e) {
      setLoadError(e instanceof Error ? e.message : 'Could not load your AI apps');
    }
  }, [api]);
  useEffect(() => {
    void load();
  }, [load]);

  const setPaused = (app: ConnectedApp, paused: boolean) =>
    void action.run(app.clientId, async () => {
      const limits = await api.patch<AppLimits>(`/connected-apps/${app.clientId}/settings`, { paused });
      setApps((list) => list?.map((a) => (a.clientId === app.clientId ? { ...a, limits } : a)) ?? list);
    });

  const pausedSwitch = (a: ConnectedApp, withLabel = true) =>
    canWrite ? (
      <FormControlLabel
        onClick={(e) => e.stopPropagation()}
        control={<Switch checked={a.limits.paused} disabled={action.busy === a.clientId} onChange={(e) => setPaused(a, e.target.checked)} slotProps={{ input: { 'aria-label': `Pause ${a.displayName}` } }} />}
        label={withLabel ? 'Paused' : ''}
        sx={{ m: 0 }}
      />
    ) : a.limits.paused ? (
      <Typography variant="body2" color="warning.main">
        Paused
      </Typography>
    ) : null;

  const columns: Column<ConnectedApp>[] = [
    { key: 'app', header: 'App', width: 220, render: (a) => <AppName app={a} /> },
    { key: 'scopes', header: 'May', grow: true, render: (a) => <ScopeChips scopes={a.scopes} /> },
    { key: 'connected', header: 'Connected', hideBelow: 'lg', render: (a) => (a.connectedAt ? <RelativeTime iso={a.connectedAt} /> : '—') },
    { key: 'used', header: 'Last used', render: (a) => (a.lastUsedAt ? <RelativeTime iso={a.lastUsedAt} /> : 'Never') },
    { key: 'usage', header: '30 days', align: 'right', render: (a) => <Box component="span" sx={{ fontVariantNumeric: 'tabular-nums', whiteSpace: 'nowrap' }}>{usageText(a)}</Box> },
    { key: 'paused', header: 'Paused', render: (a) => pausedSwitch(a, false) },
  ];

  const card = (a: ConnectedApp) => (
    <Paper variant="outlined" sx={{ display: 'flex', alignItems: 'flex-start', minWidth: 0 }} data-testid={`app-row-${a.clientId}`}>
      <CardActionArea component={RouterLink} to={`/settings/ai-apps/${a.clientId}`} sx={{ p: 1.5, flexGrow: 1, minWidth: 0 }}>
        <AppName app={a} />
        <Box sx={{ my: 1 }}>
          <ScopeChips scopes={a.scopes} />
        </Box>
        <Typography variant="caption" color="text.secondary" sx={{ display: 'block' }}>
          {usageText(a)} in 30 days · last used {a.lastUsedAt ? <RelativeTime iso={a.lastUsedAt} /> : 'never'}
        </Typography>
      </CardActionArea>
      <Box sx={{ p: 1 }}>{pausedSwitch(a)}</Box>
    </Paper>
  );

  return (
    <PageContainer width="wide">
      <PageHeader
        title="AI apps"
        subtitle="ChatGPT, Claude and other AI apps you connected to your account: what each may do, what it spent, and its limits."
        back={{ to: '/settings', label: 'Settings' }}
        primary={{ key: 'connect', label: 'Connect an AI app', Icon: AddLinkOutlinedIcon, to: CONNECT_PATH }}
      />
      <ErrorBanner error={loadError ?? action.error} onRetry={loadError ? () => void load() : undefined} onClose={loadError ? undefined : action.clearError} />
      {apps === null && !loadError && <ListSkeleton rows={3} />}
      {apps !== null && apps.length === 0 && (
        <EmptyState
          Icon={SmartToyOutlinedIcon}
          title="No AI apps are connected"
          body="Use your Hexactra agent from ChatGPT, Claude or Claude Code: the guide shows what to paste where."
          action={{ key: 'connect', label: 'Connect an AI app', Icon: AddLinkOutlinedIcon, to: CONNECT_PATH }}
        />
      )}
      {apps !== null && apps.length > 0 && (
        <ResponsiveList items={apps} columns={columns} renderCard={card} getKey={(a) => a.clientId} getLabel={(a) => a.displayName} onRowClick={(a) => navigate(`/settings/ai-apps/${a.clientId}`)} />
      )}
      <Typography variant="body2" color="text.secondary" sx={{ mt: 3 }}>
        Every app you signed in to with your account, AI or not, is also on{' '}
        <Link component={RouterLink} to="/settings/connected-apps">
          Connected apps
        </Link>
        . Disconnecting it there or here is the same.
      </Typography>
    </PageContainer>
  );
}
