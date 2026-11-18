import { Alert, Box, Button, CircularProgress, Paper, Stack, TextField } from '@mui/material';
import { isPlatformApiError, usePlatformHost } from '@marinoscar/platform-web/core';
import { useCallback, useEffect, useState } from 'react';

import { errorText } from '../policies/usePolicyCatalog';
import { ErrorBanner, PageContainer, PageHeader } from '../ui';

/** The two ceilings of every connected AI app (`mcp` system settings, #464), their defaults and ranges. */
export const APP_CEILINGS = [
  { key: 'maxConcurrentRunsPerApp', label: 'Runs at once per app', help: 'The most runs and browser sessions one AI app may have working at once.', min: 1, max: 20, fallback: 5 },
  { key: 'maxDailyRunsPerApp', label: 'Runs per day per app', help: 'The most runs and sessions one AI app may start in a day.', min: 1, max: 1000, fallback: 200 },
] as const;
type CeilingKey = (typeof APP_CEILINGS)[number]['key'];

interface McpSettingsDoc {
  version: number;
  mcp?: Partial<Record<CeilingKey, number>> & Record<string, unknown>;
}

/**
 * `/admin/settings/ai-app-limits` (#464): the deployment's ceilings of the
 * per-app limits (`mcp.maxConcurrentRunsPerApp`, `mcp.maxDailyRunsPerApp`).
 * A user may set an app's limits only up to them, and a lower ceiling clamps
 * the limits already set.
 */
export function AiAppCeilingsPage() {
  const { api, viewer } = usePlatformHost();
  const canWrite = viewer.hasPermission('system_settings:write');
  const [drafts, setDrafts] = useState<Record<CeilingKey, string> | null>(null);
  const [version, setVersion] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);
  const [saving, setSaving] = useState(false);

  const load = useCallback(async () => {
    setError(null);
    try {
      const doc = await api.get<McpSettingsDoc>('/system-settings');
      setDrafts(Object.fromEntries(APP_CEILINGS.map((c) => [c.key, String(doc.mcp?.[c.key] ?? c.fallback)])) as Record<CeilingKey, string>);
      setVersion(doc.version);
    } catch (e) {
      setError(errorText(e, 'Could not load the limits'));
    }
  }, [api]);
  useEffect(() => {
    void load();
  }, [load]);

  const fieldError = (c: (typeof APP_CEILINGS)[number], text: string) => {
    const n = Number(text);
    if (!text.trim() || !Number.isInteger(n)) return 'A whole number';
    if (n < c.min || n > c.max) return `From ${c.min} to ${c.max.toLocaleString('en')}`;
    return null;
  };
  const invalid = drafts ? APP_CEILINGS.some((c) => fieldError(c, drafts[c.key])) : true;

  const save = async () => {
    if (!drafts || invalid) return;
    setSaving(true);
    setSaved(false);
    setError(null);
    try {
      const value = Object.fromEntries(APP_CEILINGS.map((c) => [c.key, Number(drafts[c.key])]));
      const doc = await api.patch<McpSettingsDoc>('/system-settings', { mcp: value }, { ifMatch: String(version) });
      setVersion(doc.version);
      setSaved(true);
    } catch (e) {
      setError(isPlatformApiError(e) && e.status === 409 ? 'The settings changed elsewhere; reload the page and try again.' : errorText(e, 'Could not save the limits'));
    } finally {
      setSaving(false);
    }
  };

  return (
    <PageContainer>
      <PageHeader title="AI app limits" subtitle="The most any connected AI app (ChatGPT, Claude, ...) may do on this deployment. Each user sets their own apps' limits up to these values." back={{ to: '/admin/settings', label: 'Administration' }} />
      <ErrorBanner error={error} />
      {!drafts && !error && <CircularProgress aria-label="Loading" />}
      {drafts && (
        <Paper variant="outlined" sx={{ p: { xs: 2, sm: 3 } }}>
          <Stack spacing={2}>
            {APP_CEILINGS.map((c) => {
              const err = fieldError(c, drafts[c.key]);
              return (
                <TextField
                  key={c.key}
                  size="small"
                  type="number"
                  label={c.label}
                  value={drafts[c.key]}
                  disabled={!canWrite}
                  error={Boolean(err)}
                  helperText={err ?? c.help}
                  onChange={(e) => {
                    setSaved(false);
                    setDrafts({ ...drafts, [c.key]: e.target.value });
                  }}
                />
              );
            })}
            {saved && <Alert severity="success">Saved. Apps above these values are held to them from their next run.</Alert>}
            {canWrite && (
              <Box>
                <Button variant="contained" disabled={saving || invalid} onClick={() => void save()} sx={{ minHeight: 44 }}>
                  Save limits
                </Button>
              </Box>
            )}
          </Stack>
        </Paper>
      )}
    </PageContainer>
  );
}
