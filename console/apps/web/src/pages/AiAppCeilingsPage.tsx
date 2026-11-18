import OpenInNewOutlinedIcon from '@mui/icons-material/OpenInNewOutlined';
import { Alert, Box, Button, Chip, CircularProgress, Divider, FormControlLabel, Paper, Stack, Switch, TextField, Typography } from '@mui/material';
import { isPlatformApiError, usePlatformHost } from '@marinoscar/platform-web/core';
import { useCallback, useEffect, useState } from 'react';
import { Link as RouterLink } from 'react-router-dom';

import { ScopeChips } from '../aiApps/ScopeChips';
import type { AppScope } from '../aiApps/types';
import { AppActivityList } from '../components/AppActivityList';
import { errorText } from '../policies/usePolicyCatalog';
import { EmptyState, ErrorBanner, ListSkeleton, PageContainer, PageHeader, RelativeTime, ResponsiveList, aboveBottomBar, useApiAction, useConfirm, type Column } from '../ui';

/** The platform's admin page of the OAuth server: the hosts AI apps may connect from and the OAuth on/off switch. */
export const OAUTH_CLIENTS_PATH = '/admin/settings/oauth-clients';

/**
 * The numbers of the `mcp` system settings (#464, #465), their defaults and
 * ranges: the per-app ceilings, then the rate limits of /api/mcp.
 */
export const APP_CEILINGS = [
  { key: 'maxConcurrentRunsPerApp', label: 'Runs at once per app', help: 'The most runs and browser sessions one AI app may have working at once.', min: 1, max: 20, fallback: 5 },
  { key: 'maxDailyRunsPerApp', label: 'Runs per day per app', help: 'The most runs and sessions one AI app may start in a day.', min: 1, max: 1000, fallback: 200 },
  { key: 'rateLimitPerCredential', label: 'Requests per minute per connection', help: 'All MCP requests of one app, personal access token or console session.', min: 10, max: 6000, fallback: 120 },
  { key: 'rateLimitWritesPerApp', label: 'Actions per minute per app', help: 'Tool calls that change something (start, click, type, ...) by one app signed in with OAuth.', min: 1, max: 600, fallback: 30 },
  { key: 'rateLimitPerUser', label: 'Requests per minute per user', help: 'Across all of one user\'s apps and tokens.', min: 10, max: 20000, fallback: 600 },
  { key: 'rateLimitUnauthenticated', label: 'Sign-in probes per minute per address', help: 'Calls without a valid credential (discovery, expired tokens) from one address.', min: 5, max: 600, fallback: 30 },
] as const;
type NumberKey = (typeof APP_CEILINGS)[number]['key'];

/** The switches of the `mcp` namespace, with their defaults. */
const SWITCHES = [
  { key: 'externalAppsEnabled', label: 'AI apps signed in with OAuth (ChatGPT, Claude, ...)', help: 'Off: every such app is refused (HTTP 503) until you turn it back on. Personal access tokens and the console are not affected.', fallback: true },
  { key: 'patMcpEnabled', label: 'Personal access tokens over MCP', help: 'Off: agent frameworks using a token (Hermes, OpenClaw, Pi) are refused on /api/mcp. The same tokens keep working on the REST API.', fallback: true },
] as const;
const BEHAVIOUR = [
  { key: 'advertiseStepUpTools', label: 'Show apps the tools they need more permission for', help: 'The app sees them marked "Needs extra permission" and can ask the user to allow them.', fallback: true },
  { key: 'elicitation', label: "Ask a run's questions through the app's own form", help: "Where the app supports MCP forms; otherwise it relays the question in the chat.", fallback: true },
] as const;
type SwitchKey = (typeof SWITCHES)[number]['key'] | (typeof BEHAVIOUR)[number]['key'];

interface McpSettingsDoc {
  version: number;
  mcp?: Partial<Record<NumberKey, number> & Record<SwitchKey, boolean>> & { sensitiveHosts?: string[] } & Record<string, unknown>;
}

interface Draft {
  numbers: Record<NumberKey, string>;
  switches: Record<SwitchKey, boolean>;
  sensitiveHosts: string;
}

/** Every user's connected app (`GET /api/admin/connected-apps`). */
interface AdminApp {
  grantId: string;
  clientId: string;
  name: string;
  displayName: string;
  user: { id: string; email: string; displayName: string | null };
  scopes: AppScope[];
  connectedAt: string;
  lastUsedAt: string | null;
  runs30d: number;
}

const HOST_RE = /^[a-z0-9.-]+$/;

/** The hosts of the text field: one per line or comma, lower-cased, without a scheme or path. */
export function parseHosts(text: string): { hosts: string[]; invalid: string[] } {
  const parts = text
    .split(/[\s,;]+/)
    .map((h) => h.trim().toLowerCase().replace(/^https?:\/\//, '').replace(/\/.*$/, ''))
    .filter(Boolean);
  const hosts = [...new Set(parts)];
  return { hosts, invalid: hosts.filter((h) => !HOST_RE.test(h) || h.length > 253) };
}

function toDraft(doc: McpSettingsDoc): Draft {
  const m = doc.mcp ?? {};
  return {
    numbers: Object.fromEntries(APP_CEILINGS.map((c) => [c.key, String((m[c.key] as number | undefined) ?? c.fallback)])) as Record<NumberKey, string>,
    switches: Object.fromEntries([...SWITCHES, ...BEHAVIOUR].map((s) => [s.key, (m[s.key] as boolean | undefined) ?? s.fallback])) as Record<SwitchKey, boolean>,
    sensitiveHosts: (m.sensitiveHosts ?? []).join('\n'),
  };
}

function fieldError(c: (typeof APP_CEILINGS)[number], text: string): string | null {
  const n = Number(text);
  if (!text.trim() || !Number.isInteger(n)) return 'A whole number';
  if (n < c.min || n > c.max) return `From ${c.min.toLocaleString('en')} to ${c.max.toLocaleString('en')}`;
  return null;
}

/** Every user's connected apps with Disconnect (`oauth_clients:read`, Disconnect `oauth_clients:write`). */
function ConnectedAppsAdmin() {
  const { api, viewer } = usePlatformHost();
  const confirm = useConfirm();
  const action = useApiAction('Could not disconnect the app');
  const canWrite = viewer.hasPermission('oauth_clients:write');
  const [apps, setApps] = useState<AdminApp[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const load = useCallback(async () => {
    setError(null);
    try {
      setApps(await api.get<AdminApp[]>('/admin/connected-apps'));
    } catch (e) {
      setError(errorText(e, 'Could not load the connected apps'));
    }
  }, [api]);
  useEffect(() => {
    void load();
  }, [load]);

  const disconnect = async (a: AdminApp) => {
    const ok = await confirm({
      title: `Disconnect ${a.displayName} from ${a.user.email}?`,
      body: `${a.displayName} is signed out on its next call. The user can connect it again unless you also block its host in OAuth clients.`,
      confirmLabel: 'Disconnect',
      destructive: true,
    });
    if (!ok) return;
    const done = await action.run(a.grantId, async () => {
      await api.delete(`/admin/connected-apps/grants/${encodeURIComponent(a.grantId)}`);
      return true;
    });
    if (done) setApps((list) => (list ?? []).filter((x) => x.grantId !== a.grantId));
  };

  if (!apps) return error ? <ErrorBanner error={error} onRetry={() => void load()} /> : <ListSkeleton />;
  if (apps.length === 0) return <EmptyState title="No AI app is connected" body="When a user connects ChatGPT, Claude or another app, it appears here." />;
  const disconnectButton = (a: AdminApp) =>
    canWrite ? (
      <Button color="error" size="small" onClick={() => void disconnect(a)} disabled={action.busy !== null} sx={{ minHeight: 40 }}>
        Disconnect
      </Button>
    ) : null;
  const columns: Column<AdminApp>[] = [
    { key: 'app', header: 'App', width: 150, render: (a) => a.displayName },
    { key: 'user', header: 'User', grow: true, render: (a) => <Typography variant="body2" sx={{ wordBreak: 'break-all' }}>{a.user.email}</Typography> },
    { key: 'scopes', header: 'May', width: 260, hideBelow: 'lg', render: (a) => <ScopeChips scopes={a.scopes} /> },
    { key: 'used', header: 'Last used', width: 130, render: (a) => (a.lastUsedAt ? <RelativeTime iso={a.lastUsedAt} /> : 'never') },
    { key: 'runs', header: 'Runs 30 d', width: 90, align: 'right', render: (a) => a.runs30d },
    { key: 'actions', header: '', width: 120, render: disconnectButton },
  ];
  const card = (a: AdminApp) => (
    <Paper variant="outlined" sx={{ p: 1.5 }}>
      <Typography variant="subtitle2">{a.displayName}</Typography>
      <Typography variant="body2" color="text.secondary" sx={{ wordBreak: 'break-all' }}>
        {a.user.email}
      </Typography>
      <Box sx={{ my: 1 }}>
        <ScopeChips scopes={a.scopes} />
      </Box>
      <Typography variant="body2" color="text.secondary">
        {a.lastUsedAt ? <RelativeTime iso={a.lastUsedAt} prefix="last used " /> : 'never used'} · {a.runs30d} runs in 30 days
      </Typography>
      {disconnectButton(a)}
    </Paper>
  );
  return (
    <>
      <ErrorBanner error={action.error} onClose={action.clearError} />
      <ResponsiveList aria-label="Connected AI apps" items={apps} columns={columns} renderCard={card} getKey={(a) => a.grantId} getLabel={(a) => `${a.displayName} (${a.user.email})`} />
    </>
  );
}

/**
 * `/admin/settings/ai-app-limits`, the "External AI apps" card (#464, #465):
 * the kill switches of OAuth apps and of personal access tokens over MCP; the
 * per-app ceilings and the rate limits of /api/mcp; whether apps see the tools
 * they need more permission for and get questions as forms; the hosts whose
 * pages need the user's approval; every user's connected apps with
 * Disconnect; every user's AI app activity; a link to the platform's OAuth
 * clients page. One page edits the `mcp` namespace, so no second page can
 * disagree with it. Reading needs `system_settings:read` (the card), saving
 * `system_settings:write`.
 */
export function AiAppCeilingsPage() {
  const { api, viewer } = usePlatformHost();
  const canWrite = viewer.hasPermission('system_settings:write');
  const canSeeApps = viewer.hasPermission('oauth_clients:read');
  const canSeeActivity = viewer.hasPermission('mcp_activity:read');
  const [draft, setDraft] = useState<Draft | null>(null);
  const [version, setVersion] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);
  const [saving, setSaving] = useState(false);

  const load = useCallback(async () => {
    setError(null);
    try {
      const doc = await api.get<McpSettingsDoc>('/system-settings');
      setDraft(toDraft(doc));
      setVersion(doc.version);
    } catch (e) {
      setError(errorText(e, 'Could not load the settings'));
    }
  }, [api]);
  useEffect(() => {
    void load();
  }, [load]);

  const hosts = draft ? parseHosts(draft.sensitiveHosts) : { hosts: [], invalid: [] };
  const invalid = draft ? APP_CEILINGS.some((c) => fieldError(c, draft.numbers[c.key])) || hosts.invalid.length > 0 || hosts.hosts.length > 200 : true;
  const edit = (next: Partial<Draft>) => {
    setSaved(false);
    setDraft((d) => (d ? { ...d, ...next } : d));
  };

  const save = async () => {
    if (!draft || invalid) return;
    setSaving(true);
    setSaved(false);
    setError(null);
    try {
      const value = { ...Object.fromEntries(APP_CEILINGS.map((c) => [c.key, Number(draft.numbers[c.key])])), ...draft.switches, sensitiveHosts: hosts.hosts };
      const doc = await api.patch<McpSettingsDoc>('/system-settings', { mcp: value }, { ifMatch: String(version) });
      setVersion(doc.version);
      setSaved(true);
    } catch (e) {
      setError(isPlatformApiError(e) && e.status === 409 ? 'The settings changed elsewhere; reload the page and try again.' : errorText(e, 'Could not save the settings'));
    } finally {
      setSaving(false);
    }
  };

  const switchRow = (s: (typeof SWITCHES)[number] | (typeof BEHAVIOUR)[number]) => (
    <Box key={s.key}>
      <FormControlLabel
        control={<Switch checked={draft!.switches[s.key]} disabled={!canWrite} onChange={(e) => edit({ switches: { ...draft!.switches, [s.key]: e.target.checked } })} />}
        label={s.label}
      />
      <Typography variant="caption" color="text.secondary" component="p" sx={{ ml: { xs: 0, sm: 6 } }}>
        {s.help}
      </Typography>
    </Box>
  );

  return (
    <PageContainer>
      <PageHeader
        title="External AI apps"
        subtitle="ChatGPT, Claude and agent frameworks on this deployment: switch them off at once, limit how much they may do, and see what they did."
        back={{ to: '/admin/settings', label: 'Administration' }}
      />
      <ErrorBanner error={error} />
      {!draft && !error && <CircularProgress aria-label="Loading" />}
      {draft && (
        <>
          <Paper variant="outlined" component="section" aria-labelledby="ext-switches" sx={{ p: { xs: 2, sm: 3 }, mb: 3 }}>
            <Typography id="ext-switches" variant="h6" component="h2">
              Kill switches
            </Typography>
            <Typography variant="body2" color="text.secondary" sx={{ mb: 1.5 }}>
              Takes effect within a few seconds. Runs already working keep going: stop them from Runs.
            </Typography>
            <Stack spacing={1.5}>
              {SWITCHES.map(switchRow)}
              {!draft.switches.externalAppsEnabled && <Alert severity="warning">AI apps signed in with OAuth are refused.</Alert>}
            </Stack>
          </Paper>

          <Paper variant="outlined" component="section" aria-labelledby="ext-limits" sx={{ p: { xs: 2, sm: 3 }, mb: 3 }}>
            <Typography id="ext-limits" variant="h6" component="h2">
              Limits
            </Typography>
            <Typography variant="body2" color="text.secondary" sx={{ mb: 2 }}>
              Each user sets their own apps' runs up to the first two. The rate limits apply to /api/mcp; a refused request waits and tries again.
            </Typography>
            <Box sx={{ display: 'grid', gridTemplateColumns: { xs: '1fr', sm: '1fr 1fr' }, gap: 2 }}>
              {APP_CEILINGS.map((c) => {
                const err = fieldError(c, draft.numbers[c.key]);
                return (
                  <TextField
                    key={c.key}
                    size="small"
                    type="number"
                    label={c.label}
                    value={draft.numbers[c.key]}
                    disabled={!canWrite}
                    error={Boolean(err)}
                    helperText={err ?? c.help}
                    onChange={(e) => edit({ numbers: { ...draft.numbers, [c.key]: e.target.value } })}
                    slotProps={{ htmlInput: { inputMode: 'numeric' } }}
                  />
                );
              })}
            </Box>
          </Paper>

          <Paper variant="outlined" component="section" aria-labelledby="ext-behaviour" sx={{ p: { xs: 2, sm: 3 }, mb: 3 }}>
            <Typography id="ext-behaviour" variant="h6" component="h2" sx={{ mb: 1 }}>
              How apps work
            </Typography>
            <Stack spacing={1.5}>{BEHAVIOUR.map(switchRow)}</Stack>
            <Divider sx={{ my: 2 }} />
            <TextField
              fullWidth
              multiline
              minRows={2}
              label="Sensitive sites"
              placeholder="bank.example"
              value={draft.sensitiveHosts}
              disabled={!canWrite}
              onChange={(e) => edit({ sensitiveHosts: e.target.value })}
              error={hosts.invalid.length > 0 || hosts.hosts.length > 200}
              helperText={
                hosts.invalid.length > 0
                  ? `Not a host name: ${hosts.invalid.join(', ')}`
                  : 'One per line. When an AI app drives a browser, opening or clicking on these sites (and their subdomains) waits for the user\'s approval. Add your banks and payment providers.'
              }
            />
          </Paper>

          {saved && (
            <Alert severity="success" sx={{ mb: 2 }}>
              Saved. It takes effect within a few seconds.
            </Alert>
          )}
          {canWrite && (
            <Box sx={{ position: { xs: 'sticky', sm: 'static' }, bottom: aboveBottomBar(0), bgcolor: 'background.default', py: 1, mb: 3, zIndex: 1 }}>
              <Button variant="contained" disabled={saving || invalid} onClick={() => void save()} sx={{ minHeight: 44 }}>
                Save
              </Button>
            </Box>
          )}
        </>
      )}

      <Paper variant="outlined" component="section" aria-labelledby="ext-oauth" sx={{ p: { xs: 2, sm: 3 }, mb: 3 }}>
        <Typography id="ext-oauth" variant="h6" component="h2">
          Sign-in for AI apps
        </Typography>
        <Typography variant="body2" color="text.secondary" sx={{ mb: 1.5 }}>
          Whether apps can sign in with OAuth at all, and the hosts they may connect from, are on the OAuth clients page.
        </Typography>
        <Button component={RouterLink} to={OAUTH_CLIENTS_PATH} variant="outlined" endIcon={<OpenInNewOutlinedIcon />} sx={{ minHeight: 44 }}>
          OAuth clients
        </Button>
      </Paper>

      {canSeeApps && (
        <Box component="section" aria-labelledby="ext-apps" sx={{ mb: 3 }}>
          <Stack direction="row" spacing={1} sx={{ alignItems: 'center', mb: 1 }}>
            <Typography id="ext-apps" variant="h6" component="h2">
              Connected apps
            </Typography>
            <Chip size="small" label="every user" variant="outlined" />
          </Stack>
          <ConnectedAppsAdmin />
        </Box>
      )}

      {canSeeActivity && (
        <Box component="section" aria-labelledby="ext-activity">
          <Typography id="ext-activity" variant="h6" component="h2" sx={{ mb: 0.5 }}>
            Activity
          </Typography>
          <Typography variant="body2" color="text.secondary" sx={{ mb: 1 }}>
            Every user's AI app tool calls and refusals, newest first. Never what was typed, a script or a result.
          </Typography>
          <AppActivityList path="/admin/mcp/activity" showUser />
        </Box>
      )}
    </PageContainer>
  );
}

/** The same page under the card's name. */
export const ExternalAiAppsPage = AiAppCeilingsPage;
