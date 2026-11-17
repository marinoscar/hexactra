import { Alert, Box, Button, FormControlLabel, Paper, Stack, Switch, TextField } from '@mui/material';
import { isPlatformApiError, usePlatformHost } from '@marinoscar/platform-web/core';
import { useCallback, useEffect, useState } from 'react';

import { RETENTION_MAX_DAYS } from '../types/retention';
import { CardSkeleton, ErrorBanner, PageContainer, PageHeader, useApiAction } from '../ui';

/** The part of the system settings document this page reads. */
interface SystemSettingsDoc {
  version: number;
  runs?: { maxKeepDays: number | null };
}

function daysError(text: string): string | null {
  const n = Number(text);
  if (!text.trim() || !Number.isInteger(n)) return 'A whole number';
  if (n < 1 || n > RETENTION_MAX_DAYS) return `From 1 to ${RETENTION_MAX_DAYS.toLocaleString('en-US')}`;
  return null;
}

/**
 * `/admin/settings/run-history`: the deployment's ceiling on run retention
 * (the `runs` namespace of the system settings, #422). A user's longer limit,
 * or "forever", is cut to it by the nightly cleanup; their own setting is not
 * rewritten.
 */
export function RunRetentionCeilingPage() {
  const { api, viewer } = usePlatformHost();
  const canWrite = viewer.hasPermission('system_settings:write');
  const action = useApiAction();
  const [draft, setDraft] = useState<{ none: boolean; text: string } | null>(null);
  const [stored, setStored] = useState<number | null>(null);
  const [version, setVersion] = useState(0);
  const [saved, setSaved] = useState(false);
  const { setError } = action;

  const load = useCallback(async () => {
    try {
      const doc = await api.get<SystemSettingsDoc>('/system-settings');
      const max = doc.runs?.maxKeepDays ?? null;
      setStored(max);
      setDraft({ none: max === null, text: max === null ? '' : String(max) });
      setVersion(doc.version);
    } catch (e) {
      setError(e instanceof Error && e.message ? e.message : 'Could not load the limit');
    }
  }, [api, setError]);

  useEffect(() => {
    void load();
  }, [load]);

  const error = draft && !draft.none ? daysError(draft.text) : null;
  const value = draft ? (draft.none ? null : Number(draft.text)) : null;
  const dirty = draft !== null && !error && value !== stored;

  const save = async () => {
    if (!draft || error) return;
    setSaved(false);
    try {
      const doc = await api.patch<SystemSettingsDoc>('/system-settings', { runs: { maxKeepDays: value } }, { ifMatch: String(version) });
      setVersion(doc.version);
      setStored(value);
      setSaved(true);
      setError(null);
    } catch (e) {
      setError(isPlatformApiError(e) && e.status === 409 ? 'The settings changed elsewhere; reload the page and try again.' : e instanceof Error && e.message ? e.message : 'Could not save the limit');
    }
  };

  return (
    <PageContainer width="narrow">
      <PageHeader
        title="Run history limit"
        subtitle="The most days any user's finished runs are kept. A user who keeps runs longer, or forever, is cut to this by the nightly cleanup, and sees the limit in their Run history settings."
        back={{ to: '/admin/settings', label: 'Settings' }}
      />
      <ErrorBanner error={action.error} />
      {!draft && !action.error && <CardSkeleton />}
      {draft && (
        <Paper variant="outlined" sx={{ p: { xs: 2, sm: 3 } }}>
          <Stack spacing={2}>
            <Stack direction="row" spacing={2} sx={{ alignItems: 'flex-start' }}>
              <TextField
                sx={{ flex: 1, minWidth: 0 }}
                size="small"
                type="number"
                label="Days"
                value={draft.none ? '' : draft.text}
                disabled={!canWrite || draft.none}
                error={Boolean(error)}
                helperText={error ?? 'Runs older than this are removed for every user.'}
                onChange={(e) => {
                  setSaved(false);
                  setDraft({ ...draft, text: e.target.value });
                }}
                slotProps={{ htmlInput: { min: 1, max: RETENTION_MAX_DAYS, inputMode: 'numeric', 'aria-label': 'Most days runs are kept' } }}
              />
              <FormControlLabel
                sx={{ flexShrink: 0, mr: 0, minHeight: 44 }}
                control={
                  <Switch
                    checked={draft.none}
                    disabled={!canWrite}
                    onChange={(e) => {
                      setSaved(false);
                      setDraft({ ...draft, none: e.target.checked });
                    }}
                    slotProps={{ input: { 'aria-label': 'No limit on how long runs are kept' } }}
                  />
                }
                label="No limit"
              />
            </Stack>
            {saved && <Alert severity="success">Saved. The next nightly cleanup uses this limit.</Alert>}
            {canWrite && (
              <Box>
                <Button variant="contained" sx={{ minHeight: 44 }} disabled={!dirty} onClick={() => void save()}>
                  Save
                </Button>
              </Box>
            )}
          </Stack>
        </Paper>
      )}
    </PageContainer>
  );
}
