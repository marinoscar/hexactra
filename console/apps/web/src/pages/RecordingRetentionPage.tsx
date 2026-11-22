import { Alert, Box, Button, FormControl, FormControlLabel, FormLabel, Paper, Radio, RadioGroup, Stack, TextField } from '@mui/material';
import { isPlatformApiError, usePlatformHost } from '@marinoscar/platform-web/core';
import { useCallback, useEffect, useId, useState } from 'react';

import { CardSkeleton, ErrorBanner, PageContainer, PageHeader, useApiAction } from '../ui';
import { wholeNumberError } from './RequestHistorySettingsPage';

/** The limits of the `recordings` system settings (apps/api/src/recordings/recordings.settings.ts). */
export const RECORDINGS_MAX_KEEP_DAYS = 3650;
export const RECORDINGS_MAX_MINUTES = 480;
export const RECORDINGS_DEFAULTS = { keepDays: 30 as number | null, maxMinutes: 60 };

interface RecordingsSettings {
  keepDays: number | null;
  maxMinutes: number;
}
interface SystemSettingsDoc {
  version: number;
  recordings?: Partial<RecordingsSettings>;
}
interface Draft {
  mode: 'days' | 'forever';
  days: string;
  minutes: string;
}

/**
 * `/admin/settings/run-recordings` (E45.6, #761): how long the video recordings of runs are kept: deleted after N days (30 by default)
 * or kept indefinitely, and the longest one recording may be. The `recordings` namespace of the system settings; writes need
 * `system_settings:write`. The nightly job `browser.recordings.retention` enforces it.
 */
export function RecordingRetentionPage() {
  const { api, viewer } = usePlatformHost();
  const uid = useId();
  const canWrite = viewer.hasPermission('system_settings:write');
  const action = useApiAction();
  const [stored, setStored] = useState<RecordingsSettings | null>(null);
  const [draft, setDraft] = useState<Draft | null>(null);
  const [version, setVersion] = useState(0);
  const [saved, setSaved] = useState(false);
  const { setError } = action;

  const load = useCallback(async () => {
    try {
      const doc = await api.get<SystemSettingsDoc>('/system-settings');
      const s: RecordingsSettings = { ...RECORDINGS_DEFAULTS, ...doc.recordings };
      setStored(s);
      setDraft({ mode: s.keepDays === null ? 'forever' : 'days', days: String(s.keepDays ?? RECORDINGS_DEFAULTS.keepDays), minutes: String(s.maxMinutes) });
      setVersion(doc.version);
    } catch (e) {
      setError(e instanceof Error && e.message ? e.message : 'Could not load the settings');
    }
  }, [api, setError]);
  useEffect(() => {
    void load();
  }, [load]);

  const daysError = draft && draft.mode === 'days' ? wholeNumberError(draft.days, RECORDINGS_MAX_KEEP_DAYS) : null;
  const minutesError = draft ? wholeNumberError(draft.minutes, RECORDINGS_MAX_MINUTES) : null;
  const next: RecordingsSettings | null = draft && !daysError && !minutesError ? { keepDays: draft.mode === 'forever' ? null : Number(draft.days), maxMinutes: Number(draft.minutes) } : null;
  const dirty = Boolean(next && stored && (next.keepDays !== stored.keepDays || next.maxMinutes !== stored.maxMinutes));

  const save = async () => {
    if (!next) return;
    setSaved(false);
    try {
      const doc = await api.patch<SystemSettingsDoc>('/system-settings', { recordings: next }, { ifMatch: String(version) });
      setVersion(doc.version);
      setStored(next);
      setSaved(true);
      setError(null);
    } catch (e) {
      setError(isPlatformApiError(e) && e.status === 409 ? 'The settings changed elsewhere; reload the page and try again.' : e instanceof Error && e.message ? e.message : 'Could not save the settings');
    }
  };

  const edit = (patch: Partial<Draft>) => {
    setSaved(false);
    setDraft((d) => (d ? { ...d, ...patch } : d));
  };

  return (
    <PageContainer width="narrow">
      <PageHeader
        title="Run recordings"
        subtitle="Videos of the runs your users chose to record. They are not masked, so keep them only as long as they are useful."
        back={{ to: '/admin/settings', label: 'Settings' }}
      />
      <ErrorBanner error={action.error} />
      {!draft && !action.error && <CardSkeleton />}
      {draft && (
        <Paper variant="outlined" sx={{ p: { xs: 2, sm: 3 } }}>
          <Stack spacing={2.5}>
            <FormControl component="fieldset" disabled={!canWrite}>
              <FormLabel component="legend" id={`${uid}-keep`}>
                How long recordings are kept
              </FormLabel>
              <RadioGroup aria-labelledby={`${uid}-keep`} value={draft.mode} onChange={(e) => edit({ mode: e.target.value === 'forever' ? 'forever' : 'days' })}>
                <FormControlLabel value="days" control={<Radio />} label="Delete after a number of days" sx={{ minHeight: 44 }} />
                <FormControlLabel value="forever" control={<Radio />} label="Keep indefinitely" sx={{ minHeight: 44 }} />
              </RadioGroup>
            </FormControl>
            {draft.mode === 'days' && (
              <TextField
                size="small"
                type="number"
                label="Delete recordings after (days)"
                value={draft.days}
                disabled={!canWrite}
                error={Boolean(daysError)}
                helperText={daysError ?? 'A recording is deleted this many days after it was made, by the nightly cleanup. A shorter period also applies to recordings already kept. The run and its masked steps stay.'}
                onChange={(e) => edit({ days: e.target.value })}
                slotProps={{ htmlInput: { min: 1, max: RECORDINGS_MAX_KEEP_DAYS, inputMode: 'numeric', 'aria-label': 'Days a recording is kept' } }}
              />
            )}
            {draft.mode === 'forever' && <Alert severity="warning">Recordings stay until their owner deletes them or their run is deleted. They take storage and are not masked.</Alert>}
            <TextField
              size="small"
              type="number"
              label="Longest recording (minutes)"
              value={draft.minutes}
              disabled={!canWrite}
              error={Boolean(minutesError)}
              helperText={minutesError ?? 'A recording stops at this length; the run goes on. About 2 to 8 MB per minute.'}
              onChange={(e) => edit({ minutes: e.target.value })}
              slotProps={{ htmlInput: { min: 1, max: RECORDINGS_MAX_MINUTES, inputMode: 'numeric', 'aria-label': 'Longest recording in minutes' } }}
            />
            {saved && <Alert severity="success">Saved. The nightly cleanup uses the new period; new recordings use the new length.</Alert>}
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
