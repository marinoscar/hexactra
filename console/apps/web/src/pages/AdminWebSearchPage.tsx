import { Alert, Box, Button, FormControlLabel, Paper, Stack, Switch, Table, TableBody, TableCell, TableHead, TableRow, TextField, Typography } from '@mui/material';
import { usePlatformHost } from '@marinoscar/platform-web/core';
import { useCallback, useEffect, useState } from 'react';

import { DiagnosticsPanel } from '../diagnostics/DiagnosticsPanel';
import type { DiagnosticTarget } from '../diagnostics/api';
import { CardSkeleton, ErrorBanner, PageContainer, PageHeader, useApiAction } from '../ui';
import { AdminProviderCard } from '../webSearch/AdminProviderCard';
import { SERVICE, getAdmin, getUsage, listCredentials, removeDeploymentKey, saveAdmin, saveDeploymentKey, type AdminSettings, type ServiceCredential, type UsageRow } from '../webSearch/api';
import { SEARCH_TEST_NOTE } from '../webSearch/webSearchWords';

// The administrator's Web search card (E50.5, #975; E50.14, #984): `/api/web-search/admin` (settings, usage) and the deployment's keys
// through `/api/service-credentials/admin` (write-only: no page ever shows a key, nor any part of one).

const limitText = (v: string): number | null | 'bad' => (v.trim() === '' ? null : /^\d+$/.test(v.trim()) && Number(v) >= 1 && Number(v) <= 100_000 ? Number(v) : 'bad');
const str = (n: number | null | undefined) => (n === null || n === undefined ? '' : String(n));
const toLines = (v: string): string[] => [...new Set(v.split(/[\s,]+/).map((x) => x.trim().toLowerCase()).filter(Boolean))];
const box = { p: { xs: 2, sm: 3 } } as const;

/** `/admin/settings/web-search`: the switches, the limits, page reading, each provider (order, switch, estimate, key, Test), the usage. */
export function AdminWebSearchPage() {
  const { api, viewer } = usePlatformHost();
  const canWrite = viewer.hasPermission('system_settings:write');
  const action = useApiAction('Could not save the web search settings');
  const [s, setS] = useState<AdminSettings | null>(null);
  const [usage, setUsage] = useState<UsageRow[]>([]);
  const [creds, setCreds] = useState<ServiceCredential[]>([]);
  const [limits, setLimits] = useState({ perRun: '', perUserPerDay: '', fetchPerRun: '' });
  const [blocked, setBlocked] = useState('');
  const [saved, setSaved] = useState(false);
  const [testing, setTesting] = useState<DiagnosticTarget | null>(null);
  const { setError } = action;

  const fill = (settings: AdminSettings) => {
    setS(settings);
    setLimits({ perRun: str(settings.limits.perRun), perUserPerDay: str(settings.limits.perUserPerDay), fetchPerRun: str(settings.limits.fetchPerRun) });
    setBlocked((settings.fetch?.blockedHosts ?? []).join('\n'));
  };

  const load = useCallback(async () => {
    try {
      const [settings, u, c] = await Promise.all([getAdmin(api), getUsage(api), listCredentials(api).catch(() => [] as ServiceCredential[])]);
      fill(settings);
      setUsage(u);
      setCreds(c.filter((x) => x.service === SERVICE));
    } catch (e) {
      setError(e instanceof Error && e.message ? e.message : 'Could not load the settings');
    }
  }, [api, setError]);
  useEffect(() => {
    void load();
  }, [load]);

  const save = async (patch: Record<string, unknown>) => {
    setSaved(false);
    const next = await action.run('save', () => saveAdmin(api, patch));
    if (next) {
      fill(next);
      setSaved(true);
    }
  };
  const perRun = limitText(limits.perRun);
  const perDay = limitText(limits.perUserPerDay);
  const fetchPerRun = limitText(limits.fetchPerRun);
  const badLimit = perRun === 'bad' || perDay === 'bad' || fetchPerRun === 'bad';

  // In the order first, then the providers not in it.
  const ordered = s ? [...s.order.map((id) => s.installed.find((p) => p.id === id)).filter((p): p is AdminSettings['installed'][number] => Boolean(p)), ...s.installed.filter((p) => !s.order.includes(p.id))] : [];
  const listed = s ? s.order.filter((id) => s.installed.some((p) => p.id === id)) : [];
  const move = (id: string, delta: -1 | 1) => {
    const i = listed.indexOf(id);
    const j = i + delta;
    if (i < 0 || j < 0 || j >= listed.length) return;
    const next = [...listed];
    [next[i], next[j]] = [next[j]!, next[i]!];
    void save({ order: next });
  };

  return (
    <PageContainer width="narrow">
      <PageHeader title="Web search" subtitle="The search providers the agent uses instead of a browser, who may use the deployment's key, the limits and page reading." back={{ to: '/admin/settings', label: 'Settings' }} />
      <ErrorBanner error={action.error} onClose={action.clearError} />
      {!s && !action.error && <CardSkeleton />}
      {s && (
        <Stack spacing={2}>
          <Paper variant="outlined" sx={box}>
            <Stack spacing={1}>
              <FormControlLabel control={<Switch checked={s.enabled} disabled={!canWrite} onChange={(e) => void save({ enabled: e.target.checked })} />} label="Web search for this console" sx={{ minHeight: 44 }} />
              <FormControlLabel control={<Switch checked={s.shareDeploymentKey} disabled={!canWrite} onChange={(e) => void save({ shareDeploymentKey: e.target.checked })} />} label="Everyone may use the deployment's key" sx={{ minHeight: 44 }} />
              <FormControlLabel control={<Switch checked={s.allowUserKeys} disabled={!canWrite} onChange={(e) => void save({ allowUserKeys: e.target.checked })} />} label="Users may add their own key" sx={{ minHeight: 44 }} />
              <Typography variant="subtitle2" component="h2" sx={{ pt: 1 }}>
                Limits
              </Typography>
              <Stack direction={{ xs: 'column', sm: 'row' }} spacing={1}>
                <TextField size="small" label="Searches a run" value={limits.perRun} disabled={!canWrite} error={perRun === 'bad'} helperText={perRun === 'bad' ? 'A whole number from 1 to 100000' : 'Empty: no limit'} onChange={(e) => setLimits((l) => ({ ...l, perRun: e.target.value }))} slotProps={{ htmlInput: { inputMode: 'numeric' } }} />
                <TextField size="small" label="Searches a user a day" value={limits.perUserPerDay} disabled={!canWrite} error={perDay === 'bad'} helperText={perDay === 'bad' ? 'A whole number from 1 to 100000' : 'Empty: no limit (UTC days)'} onChange={(e) => setLimits((l) => ({ ...l, perUserPerDay: e.target.value }))} slotProps={{ htmlInput: { inputMode: 'numeric' } }} />
                <TextField size="small" label="Pages read a run" value={limits.fetchPerRun} disabled={!canWrite} error={fetchPerRun === 'bad'} helperText={fetchPerRun === 'bad' ? 'A whole number from 1 to 100000' : 'Empty: no limit'} onChange={(e) => setLimits((l) => ({ ...l, fetchPerRun: e.target.value }))} slotProps={{ htmlInput: { inputMode: 'numeric' } }} />
              </Stack>
              {canWrite && (
                <Box>
                  <Button variant="contained" sx={{ minHeight: 44 }} disabled={badLimit || action.busy === 'save'} onClick={() => void save({ limits: { perRun, perUserPerDay: perDay, ...(s.limits.fetchPerRun !== undefined || fetchPerRun !== null ? { fetchPerRun } : {}) } })}>
                    Save limits
                  </Button>
                </Box>
              )}
              {saved && <Alert severity="success">Saved.</Alert>}
            </Stack>
          </Paper>

          {s.fetch && (
            <Paper variant="outlined" component="section" aria-label="Page reading" sx={box}>
              <Stack spacing={1.5}>
                <Typography variant="subtitle1" component="h2">
                  Page reading
                </Typography>
                <Typography variant="body2" color="text.secondary">
                  The agent reads a public page on this server, without a browser, inside the run&apos;s allowed sites. Private and internal addresses are never read.
                </Typography>
                <FormControlLabel control={<Switch checked={s.fetch.enabled} disabled={!canWrite} onChange={(e) => void save({ fetch: { enabled: e.target.checked } })} />} label="Let the agent read pages without a browser" sx={{ minHeight: 44 }} />
                <TextField label="Blocked hosts" value={blocked} onChange={(e) => setBlocked(e.target.value)} disabled={!canWrite} multiline minRows={2} fullWidth placeholder={'blocked.example.test\n*.example.test'} helperText="One per line: a host name or *.domain. Never read, at any redirect." />
                {canWrite && (
                  <Box>
                    <Button variant="outlined" sx={{ minHeight: 44 }} disabled={action.busy === 'save'} onClick={() => void save({ fetch: { blockedHosts: toLines(blocked) } })}>
                      Save blocked hosts
                    </Button>
                  </Box>
                )}
              </Stack>
            </Paper>
          )}

          <Typography variant="h6" component="h2">
            Providers
          </Typography>
          <Typography variant="body2" color="text.secondary" sx={{ mt: '0 !important' }}>
            The first provider that is switched on and has a usable key answers; the next one answers if it fails.
          </Typography>
          {ordered.map((p) => (
            <AdminProviderCard
              key={p.id}
              provider={p}
              settings={s}
              position={listed.indexOf(p.id)}
              count={listed.length}
              credential={creds.find((c) => c.name === p.id)}
              canWrite={canWrite}
              busy={action.busy}
              onSave={save}
              onMove={(d) => move(p.id, d)}
              onTest={() => setTesting({ kind: 'search_provider', id: p.id, scope: 'deployment', name: p.label })}
              onSaveKey={async (v) => {
                const ok = await action.run(`key:${p.id}`, async () => {
                  await saveDeploymentKey(api, p.id, v);
                  return true;
                });
                await load();
                return ok === true;
              }}
              onRemoveKey={async () => {
                await action.run(`key:${p.id}`, () => removeDeploymentKey(api, p.id));
                await load();
              }}
            />
          ))}

          <Paper variant="outlined" sx={{ ...box, overflowX: 'auto' }}>
            <Typography variant="subtitle1" component="h2" gutterBottom>
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
      <DiagnosticsPanel target={testing} onClose={() => setTesting(null)} note={`${SEARCH_TEST_NOTE} It uses the deployment's key only.`} actions={{ canAdmin: true }} />
    </PageContainer>
  );
}
