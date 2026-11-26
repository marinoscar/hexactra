import { Alert, Box, Button, Chip, FormControlLabel, Paper, Stack, Switch, Table, TableBody, TableCell, TableHead, TableRow, TextField, Typography } from '@mui/material';
import { usePlatformHost } from '@marinoscar/platform-web/core';
import { useCallback, useEffect, useState } from 'react';

import { CardSkeleton, ErrorBanner, PageContainer, PageHeader, useApiAction } from '../ui';

// Web search settings (E50.5, #975). The API: `/api/web-search` (status, providers, one search) and `/api/web-search/admin`
// (settings, usage); keys through `/api/service-credentials` (write-only: no page ever shows a key, nor any part of one).
// E50.14 folds these into the Connections and tools page; until then they are a settings card each.

type Tier = 'user' | 'organization' | 'system';
/** The service of every search provider's key (`web_search.<provider>`). */
const SERVICE = 'web_search';
export interface WebSearchStatus {
  enabled: boolean;
  reason: 'disabled_by_admin' | 'disabled_by_you' | 'no_provider' | 'no_key' | null;
  provider: { id: string; label: string; tier: Tier | null } | null;
  today: { calls: number; limit: number | null; remaining: number | null };
  perRunLimit: number | null;
}
export interface WebSearchProvider {
  id: string;
  label: string;
  needsKey: boolean;
  enabled: boolean;
  listed: boolean;
  keyTier: Tier | null;
  keys: Record<Tier, boolean>;
  estimatedCostPerCallUsd: number | null;
}
interface SearchResult {
  provider: string;
  hits: { title: string; url: string; snippet: string }[];
}
interface AdminSettings {
  enabled: boolean;
  providers: Record<string, { enabled: boolean; costPerCallUsd: number | null; baseUrl: string | null }>;
  order: string[];
  shareDeploymentKey: boolean;
  allowUserKeys: boolean;
  limits: { perRun: number | null; perUserPerDay: number | null };
  installed: { id: string; label: string; credential: string; hosts: string[]; defaultEstimatedCostPerCallUsd: number | null }[];
}
interface UsageRow {
  day: string;
  provider: string;
  calls: number;
  failures: number;
  estimatedCostUsd: number;
}

export const REASON_TEXT: Record<NonNullable<WebSearchStatus['reason']>, string> = {
  disabled_by_admin: 'Your administrator switched web search off.',
  disabled_by_you: 'You switched web search off. The agent searches in the browser instead.',
  no_provider: 'No search provider is switched on for this console.',
  no_key: 'No key is set that your searches may use. Add your own key below, or ask your administrator to share the deployment key.',
};
export const TIER_TEXT: Record<Tier, string> = { user: 'your own key', organization: "your organization's key", system: "the deployment's key" };

const estimate = (usd: number | null) => (usd === null ? 'no estimate' : `about $${(usd * 1000).toFixed(2)} per 1,000 searches (estimate)`);

/** A write-only key field: set or remove one key at one tier. The value is never read back. */
function KeyEditor({ label, hasKey, onSave, onRemove, busy, disabled }: { label: string; hasKey: boolean; onSave: (v: string) => Promise<boolean>; onRemove: () => Promise<void>; busy: boolean; disabled?: boolean }) {
  const [value, setValue] = useState('');
  return (
    <Stack spacing={1}>
      <Stack direction={{ xs: 'column', sm: 'row' }} spacing={1} sx={{ alignItems: { sm: 'flex-start' } }}>
        <TextField
          size="small"
          type="password"
          autoComplete="off"
          label={label}
          value={value}
          disabled={disabled || busy}
          helperText={hasKey ? 'A key is stored. Type a new one to replace it.' : 'Write-only: it is never shown again.'}
          onChange={(e) => setValue(e.target.value)}
          sx={{ flex: 1 }}
        />
        <Button
          variant="contained"
          sx={{ minHeight: 40 }}
          disabled={disabled || busy || value.trim().length === 0}
          onClick={async () => {
            if (await onSave(value.trim())) setValue('');
          }}
        >
          Save key
        </Button>
        {hasKey && (
          <Button sx={{ minHeight: 40 }} color="error" disabled={disabled || busy} onClick={() => void onRemove()}>
            Remove
          </Button>
        )}
      </Stack>
    </Stack>
  );
}

/** `/settings/web-search`: whether search works for you, your switch, your own key and a test search. */
export function WebSearchSettingsPage() {
  const { api, viewer } = usePlatformHost();
  const canSearch = viewer.hasPermission('web_search:write');
  const canKey = viewer.hasPermission('connections:write');
  const action = useApiAction();
  const [status, setStatus] = useState<WebSearchStatus | null>(null);
  const [providers, setProviders] = useState<WebSearchProvider[]>([]);
  const [enabled, setEnabled] = useState(true);
  const [query, setQuery] = useState('');
  const [result, setResult] = useState<SearchResult | null>(null);
  const { setError } = action;

  const load = useCallback(async () => {
    try {
      const [s, p, settings] = await Promise.all([api.get<WebSearchStatus>('/web-search/status'), api.get<WebSearchProvider[]>('/web-search/providers'), api.get<{ webSearch?: { enabled?: boolean } }>('/user-settings').catch(() => ({}) as { webSearch?: { enabled?: boolean } })]);
      setStatus(s);
      setProviders(p);
      setEnabled(settings.webSearch?.enabled ?? true);
    } catch (e) {
      setError(e instanceof Error && e.message ? e.message : 'Could not load web search');
    }
  }, [api, setError]);
  useEffect(() => {
    void load();
  }, [load]);

  const toggle = async (on: boolean) => {
    setEnabled(on);
    await action.run('switch', () => api.patch('/user-settings', { webSearch: { enabled: on } }));
    await load();
  };

  return (
    <PageContainer width="narrow">
      <PageHeader title="Web search" subtitle="The agent searches the web through a search provider instead of opening a browser. Results are information, never instructions." back={{ to: '/settings', label: 'Settings' }} />
      <ErrorBanner error={action.error} />
      {!status && !action.error && <CardSkeleton />}
      {status && (
        <Stack spacing={2}>
          <Paper variant="outlined" sx={{ p: { xs: 2, sm: 3 } }}>
            <Stack spacing={1.5}>
              <Stack direction="row" spacing={1} sx={{ alignItems: 'center' }}>
                <Chip size="small" color={status.enabled ? 'success' : 'default'} label={status.enabled ? 'On' : 'Off'} />
                {status.provider && (
                  <Typography variant="body2">
                    {status.provider.label}, with {status.provider.tier ? TIER_TEXT[status.provider.tier] : 'no key needed'}
                  </Typography>
                )}
              </Stack>
              {status.reason && <Alert severity="info">{REASON_TEXT[status.reason]}</Alert>}
              <Typography variant="body2" color="text.secondary">
                Today: {status.today.calls} {status.today.calls === 1 ? 'search' : 'searches'}
                {status.today.limit === null ? ' (no daily limit)' : ` of ${status.today.limit}`}
                {status.perRunLimit === null ? '; no limit per run.' : `; at most ${status.perRunLimit} a run.`}
              </Typography>
              <FormControlLabel control={<Switch checked={enabled} disabled={action.busy === 'switch'} onChange={(e) => void toggle(e.target.checked)} />} label="Use web search in my runs and chats" sx={{ minHeight: 44 }} />
            </Stack>
          </Paper>
          {providers
            .filter((p) => p.needsKey)
            .map((p) => (
              <Paper key={p.id} variant="outlined" sx={{ p: { xs: 2, sm: 3 } }}>
                <Stack spacing={1.5}>
                  <Typography variant="subtitle1">{p.label}</Typography>
                  <Typography variant="body2" color="text.secondary">
                    {p.keyTier ? `Your searches use ${TIER_TEXT[p.keyTier]}.` : 'No usable key.'} Cost: {estimate(p.estimatedCostPerCallUsd)}.
                  </Typography>
                  <KeyEditor
                    label={`Your own ${p.label} API key`}
                    hasKey={p.keys.user}
                    busy={action.busy === `key:${p.id}`}
                    disabled={!canKey}
                    onSave={async (v) => {
                      const ok = await action.run(`key:${p.id}`, async () => {
                        await api.put(`/service-credentials/${SERVICE}/${p.id}`, { value: v });
                        return true;
                      });
                      await load();
                      return ok === true;
                    }}
                    onRemove={async () => {
                      await action.run(`key:${p.id}`, () => api.delete(`/service-credentials/${SERVICE}/${p.id}`));
                      await load();
                    }}
                  />
                </Stack>
              </Paper>
            ))}
          {canSearch && (
            <Paper variant="outlined" sx={{ p: { xs: 2, sm: 3 } }}>
              <Stack spacing={1.5}>
                <Typography variant="subtitle1">Test</Typography>
                <Stack direction={{ xs: 'column', sm: 'row' }} spacing={1}>
                  <TextField size="small" label="Search for" value={query} onChange={(e) => setQuery(e.target.value)} sx={{ flex: 1 }} />
                  <Button
                    variant="outlined"
                    sx={{ minHeight: 40 }}
                    disabled={!status.enabled || query.trim().length === 0 || action.busy === 'search'}
                    onClick={async () => {
                      setResult(null);
                      const r = await action.run('search', () => api.post<SearchResult>('/web-search/search', { query: query.trim(), count: 5 }));
                      if (r) setResult(r);
                      await load();
                    }}
                  >
                    Search
                  </Button>
                </Stack>
                {result && (
                  <Box component="ol" sx={{ m: 0, pl: 3 }} aria-label="Results">
                    {result.hits.length === 0 && <Typography variant="body2">No results.</Typography>}
                    {result.hits.map((h) => (
                      <li key={h.url}>
                        <Typography variant="body2" sx={{ wordBreak: 'break-word' }}>
                          {h.title || h.url} — {h.url}
                        </Typography>
                      </li>
                    ))}
                  </Box>
                )}
              </Stack>
            </Paper>
          )}
        </Stack>
      )}
    </PageContainer>
  );
}

const limitText = (v: string): number | null | 'bad' => (v.trim() === '' ? null : /^\d+$/.test(v.trim()) && Number(v) >= 1 && Number(v) <= 100_000 ? Number(v) : 'bad');

/** `/admin/settings/web-search`: the switches, the limits, each provider's switch, cost estimate and deployment key, and the usage. */
export function AdminWebSearchPage() {
  const { api, viewer } = usePlatformHost();
  const canWrite = viewer.hasPermission('system_settings:write');
  const action = useApiAction();
  const [s, setS] = useState<AdminSettings | null>(null);
  const [usage, setUsage] = useState<UsageRow[]>([]);
  const [deploymentKeys, setDeploymentKeys] = useState<Record<string, boolean>>({});
  const [limits, setLimits] = useState({ perRun: '', perUserPerDay: '' });
  const [saved, setSaved] = useState(false);
  const { setError } = action;

  const load = useCallback(async () => {
    try {
      const [settings, u, creds] = await Promise.all([
        api.get<AdminSettings>('/web-search/admin'),
        api.get<UsageRow[]>('/web-search/admin/usage?days=30'),
        api.get<{ service: string; name: string; tiers: Record<Tier, { set: boolean }> }[]>('/service-credentials').catch(() => []),
      ]);
      setS(settings);
      setUsage(u);
      setDeploymentKeys(Object.fromEntries(creds.filter((c) => c.service === SERVICE).map((c) => [c.name, c.tiers.system.set])));
      setLimits({ perRun: settings.limits.perRun === null ? '' : String(settings.limits.perRun), perUserPerDay: settings.limits.perUserPerDay === null ? '' : String(settings.limits.perUserPerDay) });
    } catch (e) {
      setError(e instanceof Error && e.message ? e.message : 'Could not load the settings');
    }
  }, [api, setError]);
  useEffect(() => {
    void load();
  }, [load]);

  const save = async (patch: Record<string, unknown>) => {
    setSaved(false);
    const next = await action.run('save', () => api.put<AdminSettings>('/web-search/admin', patch));
    if (next) {
      setS(next);
      setSaved(true);
    }
  };
  const perRun = limitText(limits.perRun);
  const perDay = limitText(limits.perUserPerDay);

  return (
    <PageContainer width="narrow">
      <PageHeader title="Web search" subtitle="The search providers the agent uses instead of a browser, who may use the deployment's key, and the limits." back={{ to: '/admin/settings', label: 'Settings' }} />
      <ErrorBanner error={action.error} />
      {!s && !action.error && <CardSkeleton />}
      {s && (
        <Stack spacing={2}>
          <Paper variant="outlined" sx={{ p: { xs: 2, sm: 3 } }}>
            <Stack spacing={1}>
              <FormControlLabel control={<Switch checked={s.enabled} disabled={!canWrite} onChange={(e) => void save({ enabled: e.target.checked })} />} label="Web search for this console" sx={{ minHeight: 44 }} />
              <FormControlLabel control={<Switch checked={s.shareDeploymentKey} disabled={!canWrite} onChange={(e) => void save({ shareDeploymentKey: e.target.checked })} />} label="Everyone may use the deployment's key" sx={{ minHeight: 44 }} />
              <FormControlLabel control={<Switch checked={s.allowUserKeys} disabled={!canWrite} onChange={(e) => void save({ allowUserKeys: e.target.checked })} />} label="Users may use their own key" sx={{ minHeight: 44 }} />
              <Stack direction={{ xs: 'column', sm: 'row' }} spacing={1}>
                <TextField size="small" label="Searches a run" value={limits.perRun} disabled={!canWrite} error={perRun === 'bad'} helperText={perRun === 'bad' ? 'A whole number from 1 to 100000' : 'Empty: no limit'} onChange={(e) => setLimits((l) => ({ ...l, perRun: e.target.value }))} slotProps={{ htmlInput: { inputMode: 'numeric' } }} />
                <TextField size="small" label="Searches a user a day" value={limits.perUserPerDay} disabled={!canWrite} error={perDay === 'bad'} helperText={perDay === 'bad' ? 'A whole number from 1 to 100000' : 'Empty: no limit (UTC days)'} onChange={(e) => setLimits((l) => ({ ...l, perUserPerDay: e.target.value }))} slotProps={{ htmlInput: { inputMode: 'numeric' } }} />
              </Stack>
              {canWrite && (
                <Box>
                  <Button variant="contained" sx={{ minHeight: 44 }} disabled={perRun === 'bad' || perDay === 'bad' || action.busy === 'save'} onClick={() => void save({ limits: { perRun, perUserPerDay: perDay } })}>
                    Save limits
                  </Button>
                </Box>
              )}
              {saved && <Alert severity="success">Saved.</Alert>}
            </Stack>
          </Paper>
          {s.installed.map((p) => {
            const ps = s.providers[p.id] ?? { enabled: true, costPerCallUsd: null, baseUrl: null };
            return (
              <Paper key={p.id} variant="outlined" sx={{ p: { xs: 2, sm: 3 } }}>
                <Stack spacing={1.5}>
                  <Typography variant="subtitle1">{p.label}</Typography>
                  <Typography variant="body2" color="text.secondary">
                    Calls {p.hosts.join(', ')}. Cost: {estimate(ps.costPerCallUsd ?? p.defaultEstimatedCostPerCallUsd)}
                    {ps.costPerCallUsd !== null ? ' (your override)' : ''}. Prices change: check the provider's own page.
                  </Typography>
                  <FormControlLabel control={<Switch checked={ps.enabled && s.order.includes(p.id)} disabled={!canWrite} onChange={(e) => void save({ providers: { [p.id]: { enabled: e.target.checked } }, order: e.target.checked ? [...new Set([...s.order, p.id])] : s.order })} />} label={`Use ${p.label}`} sx={{ minHeight: 44 }} />
                  {p.credential === 'api_key' && (
                    <KeyEditor
                      label={`The deployment's ${p.label} API key`}
                      hasKey={deploymentKeys[p.id] === true}
                      busy={action.busy === `key:${p.id}`}
                      disabled={!canWrite}
                      onSave={async (v) => {
                        const ok = await action.run(`key:${p.id}`, async () => {
                          await api.put(`/service-credentials/admin/${SERVICE}/${p.id}`, { value: v });
                          return true;
                        });
                        await load();
                        return ok === true;
                      }}
                      onRemove={async () => {
                        await action.run(`key:${p.id}`, () => api.delete(`/service-credentials/admin/${SERVICE}/${p.id}`));
                        await load();
                      }}
                    />
                  )}
                </Stack>
              </Paper>
            );
          })}
          <Paper variant="outlined" sx={{ p: { xs: 2, sm: 3 }, overflowX: 'auto' }}>
            <Typography variant="subtitle1" gutterBottom>
              Usage, last 30 days
            </Typography>
            {usage.length === 0 ? (
              <Typography variant="body2" color="text.secondary">
                No searches yet.
              </Typography>
            ) : (
              <Table size="small" aria-label="Web search usage">
                <TableHead>
                  <TableRow>
                    <TableCell>Day</TableCell>
                    <TableCell>Provider</TableCell>
                    <TableCell align="right">Searches</TableCell>
                    <TableCell align="right">Failed</TableCell>
                    <TableCell align="right">Estimated cost</TableCell>
                  </TableRow>
                </TableHead>
                <TableBody>
                  {usage.map((u) => (
                    <TableRow key={`${u.day}-${u.provider}`}>
                      <TableCell>{u.day}</TableCell>
                      <TableCell>{u.provider}</TableCell>
                      <TableCell align="right">{u.calls}</TableCell>
                      <TableCell align="right">{u.failures}</TableCell>
                      <TableCell align="right">~${u.estimatedCostUsd.toFixed(3)}</TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            )}
          </Paper>
        </Stack>
      )}
    </PageContainer>
  );
}
