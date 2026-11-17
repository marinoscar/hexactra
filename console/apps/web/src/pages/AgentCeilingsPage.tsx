import { Alert, Box, Button, CircularProgress, FormControlLabel, Paper, Stack, Switch, TextField } from '@mui/material';
import { isPlatformApiError, usePlatformHost } from '@marinoscar/platform-web/core';
import { useCallback, useEffect, useState } from 'react';

import { getAgentSystemSettings, patchAgentSystemSettings } from '../policies/api';
import { BUDGET_LABEL } from '../policies/format';
import { BUDGET_HELP, budgetHelp } from '../policies/help';
import { BUDGET_LIMIT_KEYS, type BudgetCeilings, type BudgetLimitKey } from '../policies/types';
import { errorText } from '../policies/usePolicyCatalog';
import { ErrorBanner, PageContainer, PageHeader } from '../ui';

type Drafts = Record<BudgetLimitKey, { none: boolean; text: string }>;

function fieldError(key: BudgetLimitKey, text: string): string | null {
  const help = BUDGET_HELP[key];
  const n = Number(text);
  if (!text.trim() || !Number.isFinite(n)) return 'A number';
  if (key !== 'maxCostUsd' && !Number.isInteger(n)) return 'A whole number';
  if (n < help.min || n > help.max) return `From ${help.min.toLocaleString('en')} to ${help.max.toLocaleString('en')}`;
  return null;
}

/**
 * `/admin/settings/agent-ceilings`: the deployment's budget ceilings
 * (`browserAgentCeilings`). Every run's budget is the smaller of its policy's
 * and the ceiling, so a ceiling caps even an "Unlimited" policy.
 */
export function AgentCeilingsPage() {
  const { api, viewer } = usePlatformHost();
  const canWrite = viewer.hasPermission('system_settings:write');
  const [drafts, setDrafts] = useState<Drafts | null>(null);
  const [version, setVersion] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);
  const [saving, setSaving] = useState(false);

  const load = useCallback(async () => {
    setError(null);
    try {
      const doc = await getAgentSystemSettings(api);
      const c = doc.browserAgentCeilings;
      setDrafts(Object.fromEntries(BUDGET_LIMIT_KEYS.map((k) => [k, { none: (c?.[k] ?? null) === null, text: c?.[k] == null ? '' : String(c[k]) }])) as Drafts);
      setVersion(doc.version);
    } catch (e) {
      setError(errorText(e, 'Could not load the ceilings'));
    }
  }, [api]);

  useEffect(() => {
    void load();
  }, [load]);

  const invalid = drafts ? BUDGET_LIMIT_KEYS.some((k) => !drafts[k].none && fieldError(k, drafts[k].text)) : true;

  const save = async () => {
    if (!drafts || invalid) return;
    setSaving(true);
    setSaved(false);
    setError(null);
    try {
      const value = Object.fromEntries(BUDGET_LIMIT_KEYS.map((k) => [k, drafts[k].none ? null : Number(drafts[k].text)])) as BudgetCeilings;
      const doc = await patchAgentSystemSettings(api, 'browserAgentCeilings', value, version);
      setVersion(doc.version);
      setSaved(true);
    } catch (e) {
      setError(isPlatformApiError(e) && e.status === 409 ? 'The settings changed elsewhere; reload the page and try again.' : errorText(e, 'Could not save the ceilings'));
    } finally {
      setSaving(false);
    }
  };

  return (
    <PageContainer>
      <PageHeader
        title="Agent budget ceilings"
        subtitle="The most any run on this deployment may spend, whatever its policy says. A run gets the smaller of its policy's budget and the ceiling, so a ceiling also caps “Unlimited” policies. Users see the ceilings under their policy's budgets."
      />
      <ErrorBanner error={error} />
      {!drafts && !error && <CircularProgress aria-label="Loading" />}
      {drafts && (
        <Paper variant="outlined" sx={{ p: { xs: 2, sm: 3 } }}>
          <Stack spacing={2}>
            {BUDGET_LIMIT_KEYS.map((k) => {
              const d = drafts[k];
              const err = d.none ? null : fieldError(k, d.text);
              return (
                <Stack key={k} direction={{ xs: 'column', sm: 'row' }} spacing={{ xs: 0.5, sm: 2 }} sx={{ alignItems: { sm: 'flex-start' } }}>
                  <TextField
                    sx={{ flex: 1 }}
                    size="small"
                    type="number"
                    label={BUDGET_LABEL[k]}
                    value={d.none ? '' : d.text}
                    disabled={!canWrite || d.none}
                    error={Boolean(err)}
                    helperText={err ?? budgetHelp(k)}
                    onChange={(e) => setDrafts({ ...drafts, [k]: { ...d, text: e.target.value } })}
                  />
                  <FormControlLabel
                    sx={{ flexShrink: 0, mt: { sm: 0.5 } }}
                    control={
                      <Switch
                        checked={d.none}
                        disabled={!canWrite}
                        onChange={(e) => setDrafts({ ...drafts, [k]: { ...d, none: e.target.checked } })}
                        slotProps={{ input: { 'aria-label': `No ceiling: ${BUDGET_LABEL[k]}` } }}
                      />
                    }
                    label="No ceiling"
                  />
                </Stack>
              );
            })}
            {saved && <Alert severity="success">Saved. New runs are capped by these values.</Alert>}
            {canWrite && (
              <Box>
                <Button variant="contained" disabled={saving || invalid} onClick={() => void save()}>
                  Save ceilings
                </Button>
              </Box>
            )}
          </Stack>
        </Paper>
      )}
    </PageContainer>
  );
}
