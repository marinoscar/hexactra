import AddIcon from '@mui/icons-material/Add';
import DeleteOutlineIcon from '@mui/icons-material/DeleteOutlined';
import { Alert, Box, Button, CircularProgress, IconButton, Paper, Stack, TextField } from '@mui/material';
import { useUsableAiModels } from '@marinoscar/platform-web/ai/headless';
import { isPlatformApiError, usePlatformHost } from '@marinoscar/platform-web/core';
import { useCallback, useEffect, useState } from 'react';

import { getAgentSystemSettings, getUserModelPrices, patchAgentSystemSettings, patchUserModelPrices } from '../policies/api';
import { ModelPicker } from '../policies/ModelPicker';
import type { ModelPrice } from '../policies/types';
import { errorText } from '../policies/usePolicyCatalog';
import { ErrorBanner, PageContainer, PageHeader } from '../ui';

/** The API's key rule: `'<provider>:<model id>'` (apps/api/src/runner/agent-pricing.schemas.ts). */
const MODEL_PRICE_KEY = /^[a-z0-9][a-z0-9_.-]*:\S.*$/;

interface Row {
  key: string;
  input: string;
  output: string;
  cached: string;
}

function priceError(text: string, optional: boolean): string | null {
  if (!text.trim()) return optional ? null : 'Required';
  const n = Number(text);
  return Number.isFinite(n) && n >= 0 && n <= 100_000 ? null : 'From 0 to 100,000';
}

function rowErrors(row: Row, rows: readonly Row[]): Partial<Record<keyof Row, string>> {
  const out: Partial<Record<keyof Row, string>> = {};
  if (!MODEL_PRICE_KEY.test(row.key)) out.key = 'provider:modelId, e.g. openai:model-x';
  else if (rows.filter((r) => r.key === row.key).length > 1) out.key = 'Listed twice';
  const input = priceError(row.input, false);
  const output = priceError(row.output, false);
  const cached = priceError(row.cached, true);
  if (input) out.input = input;
  if (output) out.output = output;
  if (cached) out.cached = cached;
  return out;
}

export interface AgentPricingPageProps {
  /** `deployment`: the admin's table (`/system-settings`). `user`: the signed-in user's own prices (`/user-settings`, #735). */
  scope?: 'deployment' | 'user';
}

/**
 * `/admin/settings/agent-pricing`: what each model costs per million tokens
 * (`agentPricing`). Run cost and budgets in dollars use it; an unlisted
 * model's calls are unpriced, and a run then shows its cost as "at least".
 *
 * `/settings/model-prices` (`scope="user"`, #735): the same editor for the
 * user's own prices, which replace the deployment's price of the same model
 * for that user's runs and usage report only.
 */
export function AgentPricingPage({ scope = 'deployment' }: AgentPricingPageProps) {
  const { api, viewer } = usePlatformHost();
  const own = scope === 'user';
  const canWrite = viewer.hasPermission(own ? 'user_settings:write' : 'system_settings:write');
  const { models } = useUsableAiModels();
  const [rows, setRows] = useState<Row[] | null>(null);
  const [version, setVersion] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);
  const [saving, setSaving] = useState(false);

  const load = useCallback(async () => {
    setError(null);
    try {
      const doc = own ? await getUserModelPrices(api) : await getAgentSystemSettings(api);
      const table = doc.agentPricing?.models ?? {};
      setRows(
        Object.entries(table)
          .sort(([a], [b]) => a.localeCompare(b))
          .map(([key, p]) => ({ key, input: String(p.inputPerMTok), output: String(p.outputPerMTok), cached: p.cachedInputPerMTok === undefined ? '' : String(p.cachedInputPerMTok) })),
      );
      setVersion(doc.version);
    } catch (e) {
      setError(errorText(e, 'Could not load the prices'));
    }
  }, [api, own]);

  useEffect(() => {
    void load();
  }, [load]);

  const invalid = rows ? rows.some((r) => Object.keys(rowErrors(r, rows)).length > 0) : true;
  const setRow = (i: number, patch: Partial<Row>) => rows && setRows(rows.map((r, j) => (j === i ? { ...r, ...patch } : r)));

  const save = async () => {
    if (!rows || invalid) return;
    setSaving(true);
    setSaved(false);
    setError(null);
    try {
      const table: Record<string, ModelPrice> = {};
      for (const r of rows) {
        table[r.key] = { inputPerMTok: Number(r.input), outputPerMTok: Number(r.output), ...(r.cached.trim() ? { cachedInputPerMTok: Number(r.cached) } : {}) };
      }
      const doc = own ? await patchUserModelPrices(api, table, version) : await patchAgentSystemSettings(api, 'agentPricing', { models: table }, version);
      setVersion(doc.version);
      setSaved(true);
    } catch (e) {
      setError(isPlatformApiError(e) && e.status === 409 ? 'The settings changed elsewhere; reload the page and try again.' : errorText(e, 'Could not save the prices'));
    } finally {
      setSaving(false);
    }
  };

  return (
    <PageContainer>
      <PageHeader
        title={own ? 'My model prices' : 'Model prices'}
        subtitle={
          own
            ? 'What each model costs you, in US dollars per million tokens, if your own key pays a different rate. A price here replaces the deployment’s price of the same model for your runs, your cost budgets and My usage & cost only. Leave a model out to use the deployment’s price.'
            : 'What each model costs, in US dollars per million tokens. Run cost, cost budgets and the AI usage report use these prices. A model that is not listed is unpriced: its runs show their cost as “at least”. A user may set their own prices for their own runs.'
        }
      />
      <ErrorBanner error={error} />
      {!rows && !error && <CircularProgress aria-label="Loading" />}
      {rows && (
        <Stack spacing={1.5} aria-label="Prices">
          {rows.length === 0 && <Alert severity="info">{own ? 'No prices of your own: your runs use the deployment’s prices.' : 'No prices yet. Add the models your runs use.'}</Alert>}
          {rows.map((r, i) => {
            const errs = rowErrors(r, rows);
            return (
              <Paper key={i} variant="outlined" sx={{ p: 2 }} aria-label={`Price ${r.key || i + 1}`}>
                <Stack direction={{ xs: 'column', md: 'row' }} spacing={1.5} sx={{ alignItems: { md: 'flex-start' } }}>
                  <Box sx={{ flex: 2, minWidth: 0 }}>
                    <ModelPicker label="Model" value={r.key || null} onChange={(v) => setRow(i, { key: v ?? '' })} models={models} disabled={!canWrite} helperText={errs.key ?? ' '} />
                  </Box>
                  {/* On a phone: input and output side by side, then cached and the remove button, so no label is cut. */}
                  <Box sx={{ flex: 3, minWidth: 0, display: 'grid', gridTemplateColumns: { xs: 'minmax(0, 1fr) minmax(0, 1fr)', sm: 'repeat(3, minmax(0, 1fr)) auto' }, columnGap: 1.5, alignItems: 'start' }}>
                    {(
                      [
                        ['input', 'Input $/M'],
                        ['output', 'Output $/M'],
                        ['cached', 'Cached $/M'],
                      ] as const
                    ).map(([field, label]) => (
                      <TextField
                        key={field}
                        size="small"
                        type="number"
                        label={label}
                        value={r[field]}
                        disabled={!canWrite}
                        error={Boolean(errs[field])}
                        helperText={errs[field] ?? (field === 'cached' ? 'Optional' : ' ')}
                        onChange={(e) => setRow(i, { [field]: e.target.value })}
                        slotProps={{ htmlInput: { min: 0, step: 0.01, inputMode: 'decimal' } }}
                        sx={{ minWidth: 0 }}
                      />
                    ))}
                    {canWrite && (
                      <IconButton aria-label={`Remove ${r.key || 'row'}`} onClick={() => setRows(rows.filter((_, j) => j !== i))} sx={{ justifySelf: 'end', width: { xs: 44, sm: 40 }, height: { xs: 44, sm: 40 } }}>
                        <DeleteOutlineIcon />
                      </IconButton>
                    )}
                  </Box>
                </Stack>
              </Paper>
            );
          })}
          {saved && <Alert severity="success">{own ? 'Saved. Your usage report uses them now, and your runs from their next step.' : 'Saved. New model calls are priced with these values.'}</Alert>}
          {canWrite && (
            <Stack direction="row" spacing={1}>
              <Button startIcon={<AddIcon />} onClick={() => setRows([...rows, { key: '', input: '', output: '', cached: '' }])}>
                Add a model
              </Button>
              <Button variant="contained" disabled={saving || invalid} onClick={() => void save()}>
                Save prices
              </Button>
            </Stack>
          )}
        </Stack>
      )}
    </PageContainer>
  );
}
