import { Alert, Box, Button, FormControl, FormControlLabel, FormLabel, Paper, Radio, RadioGroup, Stack, Switch, TextField, Typography } from '@mui/material';
import { usePlatformHost } from '@marinoscar/platform-web/core';
import { useCallback, useEffect, useId, useState } from 'react';

import { getKgAdminSettings, putKgAdminSettings, type KgAdminSettings } from '../kgraph/api';
import { CardSkeleton, ErrorBanner, PageContainer, PageHeader, useApiAction } from '../ui';
import { wholeNumberError } from './RequestHistorySettingsPage';

interface Draft {
  enabled: boolean;
  auditEvery: string;
  suspendAfterFailures: string;
  pacing: 'human' | 'fast';
}

/** `auditEvery` may be 0 (never); `wholeNumberError` checks from 1, so 0 is accepted here first. */
function auditError(v: string): string | null {
  if (v.trim() === '0') return null;
  const e = wholeNumberError(v, 1000);
  return e && e.startsWith('From') ? 'From 0 to 1,000' : e;
}

/**
 * `/admin/settings/kgraph` (E46.20): the deployment switch (off by default) with what it does, how often a reuse task is audited with
 * AI only, the failures before a procedure is suspended, and the pacing of replayed actions. `GET|PUT /api/admin/kgraph/settings`
 * (`kgraph:admin`). Turning it off keeps what everyone learned.
 */
export function KgraphAdminPage() {
  const { api } = usePlatformHost();
  const uid = useId();
  const action = useApiAction();
  const [stored, setStored] = useState<KgAdminSettings | null>(null);
  const [draft, setDraft] = useState<Draft | null>(null);
  const [saved, setSaved] = useState(false);
  const { setError } = action;

  const fill = (s: KgAdminSettings) => {
    setStored(s);
    setDraft({ enabled: s.enabled, auditEvery: String(s.auditEvery), suspendAfterFailures: String(s.suspendAfterFailures), pacing: s.pacing });
  };
  const load = useCallback(async () => {
    try {
      fill(await getKgAdminSettings(api));
    } catch (e) {
      setError(e instanceof Error && e.message ? e.message : 'Could not load the settings');
    }
  }, [api, setError]);
  useEffect(() => {
    void load();
  }, [load]);

  const aErr = draft ? auditError(draft.auditEvery) : null;
  const sErr = draft ? wholeNumberError(draft.suspendAfterFailures, 100) : null;
  const next: Partial<KgAdminSettings> | null = draft && !aErr && !sErr ? { enabled: draft.enabled, auditEvery: Number(draft.auditEvery), suspendAfterFailures: Number(draft.suspendAfterFailures), pacing: draft.pacing } : null;
  const dirty = Boolean(next && stored && (next.enabled !== stored.enabled || next.auditEvery !== stored.auditEvery || next.suspendAfterFailures !== stored.suspendAfterFailures || next.pacing !== stored.pacing));
  const edit = (patch: Partial<Draft>) => {
    setSaved(false);
    setDraft((d) => (d ? { ...d, ...patch } : d));
  };
  const save = async () => {
    if (!next) return;
    const s = await action.run('save', () => putKgAdminSettings(api, next), 'Could not save the settings');
    if (!s) return;
    fill(s);
    setSaved(true);
  };

  return (
    <PageContainer width="narrow">
      <PageHeader title="Knowledge Graph" subtitle="Whether your users' saved tasks may learn their steps and repeat them without the model." back={{ to: '/admin/settings', label: 'Settings' }} />
      <ErrorBanner error={action.error} onClose={action.clearError} />
      {!draft && !action.error && <CardSkeleton />}
      {draft && (
        <Paper variant="outlined" sx={{ p: { xs: 2, sm: 3 } }}>
          <Stack spacing={2.5}>
            <Box>
              <FormControlLabel control={<Switch checked={draft.enabled} onChange={(e) => edit({ enabled: e.target.checked })} />} label="Allow the Knowledge Graph on this console" sx={{ minHeight: 44 }} />
              <Typography variant="body2" color="text.secondary">
                Off by default. When on, each user may turn it on for themselves, and then choose per task: the agent&apos;s steps are saved as a procedure, and later runs repeat them without the model, with the agent taking over when a page changed. Every step still passes the same checks, Stop and approvals. Turning it off stops all learning and reuse at once and deletes nothing.
              </Typography>
            </Box>
            <TextField
              size="small"
              type="number"
              label="Check with AI only every (runs)"
              value={draft.auditEvery}
              error={Boolean(aErr)}
              helperText={aErr ?? 'Every Nth run of a task that reuses its steps runs with AI only, to compare. 0 never. Default 10.'}
              onChange={(e) => edit({ auditEvery: e.target.value })}
              slotProps={{ htmlInput: { min: 0, max: 1000, inputMode: 'numeric', 'aria-label': 'Audit every N runs' } }}
            />
            <TextField
              size="small"
              type="number"
              label="Failures before a procedure is suspended"
              value={draft.suspendAfterFailures}
              error={Boolean(sErr)}
              helperText={sErr ?? 'After this many failed replays in a row, the procedure stops being used until it is repaired or restored. Default 3.'}
              onChange={(e) => edit({ suspendAfterFailures: e.target.value })}
              slotProps={{ htmlInput: { min: 1, max: 100, inputMode: 'numeric', 'aria-label': 'Failures before suspension' } }}
            />
            <FormControl component="fieldset">
              <FormLabel component="legend" id={`${uid}-pacing`}>
                Pacing of replayed actions
              </FormLabel>
              <RadioGroup aria-labelledby={`${uid}-pacing`} value={draft.pacing} onChange={(e) => edit({ pacing: e.target.value === 'fast' ? 'fast' : 'human' })}>
                <FormControlLabel value="human" control={<Radio />} label="Like a person: a short random pause between actions" sx={{ minHeight: 44 }} />
                <FormControlLabel value="fast" control={<Radio />} label="Fast: only wait for the page to be ready" sx={{ minHeight: 44 }} />
              </RadioGroup>
            </FormControl>
            {saved && <Alert severity="success">Saved.</Alert>}
            <Box>
              <Button variant="contained" sx={{ minHeight: 44 }} disabled={!dirty || action.busy !== null} onClick={() => void save()}>
                Save
              </Button>
            </Box>
          </Stack>
        </Paper>
      )}
    </PageContainer>
  );
}
