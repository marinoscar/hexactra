import {
  Alert,
  Box,
  Button,
  Card,
  CardContent,
  CircularProgress,
  Container,
  FormControlLabel,
  MenuItem,
  Stack,
  Switch,
  TextField,
  Typography,
} from '@mui/material';
import { useUsableAiModels } from '@marinoscar/platform-web/ai/headless';
import { isPlatformApiError, usePlatformHost } from '@marinoscar/platform-web/core';
import { useCallback, useEffect, useState } from 'react';

import { getAgentSystemSettings, getEffectiveTiers, getUserTiers, patchAgentSystemSettings, saveUserTiers } from '../policies/api';
import { sourceText } from '../policies/format';
import { ModelPicker, modelName } from '../policies/ModelPicker';
import { TIERS, TIER_EFFORTS, TIER_LABEL, type EffectiveTiers, type ModelTiers, type ModelTiersOverride, type Tier, type TierDef, type TierEffort } from '../policies/types';
import { errorText } from '../policies/usePolicyCatalog';

const EMPTY: TierDef = { model: null, reasoningEffort: null, maxOutputTokens: null, fallbackModel: null };

const TIER_BLURB: Record<Tier, string> = {
  fast: 'Cheap and quick: simple pages and routine steps.',
  standard: 'The everyday tier most runs start on.',
  frontier: 'The strongest model: used when a run is stuck, or from the start by a demanding policy.',
};

const EFFORT_LABEL: Record<TierEffort, string> = { none: 'None (least reasoning)', low: 'Low', medium: 'Medium', high: 'High' };

interface Draft {
  /** User scope only: the tier follows the deployment (no override stored). */
  inherit: boolean;
  def: TierDef;
  tokens: string;
}

function toDraft(def: Partial<TierDef> | undefined, inherit: boolean): Draft {
  const full = { ...EMPTY, ...def };
  return { inherit, def: full, tokens: full.maxOutputTokens === null ? '' : String(full.maxOutputTokens) };
}

function tokensError(text: string): string | null {
  if (!text.trim()) return null;
  const n = Number(text);
  return Number.isInteger(n) && n >= 256 && n <= 64_000 ? null : 'A whole number from 256 to 64,000';
}

/**
 * The three model tiers (Fast, Standard, Frontier). `scope="user"` is
 * `/settings/agent-model-tiers`: the user's own overrides, each tier inheriting
 * the deployment until switched off. `scope="deployment"` is
 * `/admin/settings/agent-model-tiers`: the deployment default (`browserAgentTiers`).
 */
export function ModelTiersPage({ scope }: { scope: 'user' | 'deployment' }) {
  const { api, viewer } = usePlatformHost();
  const { models, error: modelsError } = useUsableAiModels();
  const canWrite = scope === 'user' ? viewer.hasPermission('user_settings:write') : viewer.hasPermission('system_settings:write');
  const [drafts, setDrafts] = useState<Record<Tier, Draft> | null>(null);
  const [version, setVersion] = useState(0);
  const [effective, setEffective] = useState<EffectiveTiers | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);
  const [saving, setSaving] = useState(false);

  const load = useCallback(async () => {
    setError(null);
    try {
      if (scope === 'user') {
        const { tiers, version: v } = await getUserTiers(api);
        setDrafts(Object.fromEntries(TIERS.map((t) => [t, toDraft(tiers[t], !tiers[t])])) as Record<Tier, Draft>);
        setVersion(v);
      } else {
        const doc = await getAgentSystemSettings(api);
        setDrafts(Object.fromEntries(TIERS.map((t) => [t, toDraft(doc.browserAgentTiers?.[t], false)])) as Record<Tier, Draft>);
        setVersion(doc.version);
      }
    } catch (e) {
      setError(errorText(e, 'Could not load the model tiers'));
    }
    if (scope === 'user') {
      getEffectiveTiers(api)
        .then(setEffective)
        .catch(() => setEffective(null));
    }
  }, [api, scope]);

  useEffect(() => {
    void load();
  }, [load]);

  const update = (t: Tier, patch: Partial<Draft>) => drafts && setDrafts({ ...drafts, [t]: { ...drafts[t], ...patch } });
  const updateDef = (t: Tier, patch: Partial<TierDef>) => drafts && update(t, { def: { ...drafts[t].def, ...patch } });

  const invalid = drafts ? TIERS.some((t) => !drafts[t].inherit && tokensError(drafts[t].tokens)) : true;

  const save = async () => {
    if (!drafts || invalid) return;
    setSaving(true);
    setSaved(false);
    setError(null);
    const defOf = (t: Tier): TierDef => ({ ...drafts[t].def, maxOutputTokens: drafts[t].tokens.trim() ? Number(drafts[t].tokens) : null });
    try {
      if (scope === 'user') {
        // Every field is sent: `null` clears an override field, so an inherited tier is all nulls.
        const tiers: ModelTiersOverride = Object.fromEntries(TIERS.map((t) => [t, drafts[t].inherit ? { ...EMPTY } : defOf(t)]));
        const next = await saveUserTiers(api, tiers, version);
        setVersion(next.version);
        getEffectiveTiers(api)
          .then(setEffective)
          .catch(() => setEffective(null));
      } else {
        const tiers = Object.fromEntries(TIERS.map((t) => [t, defOf(t)])) as ModelTiers;
        const doc = await patchAgentSystemSettings(api, 'browserAgentTiers', tiers, version);
        setVersion(doc.version);
      }
      setSaved(true);
    } catch (e) {
      if (isPlatformApiError(e) && (e.status === 409 || e.status === 412)) {
        setError('These settings changed elsewhere; reload the page and try again.');
      } else {
        setError(errorText(e, 'Could not save the model tiers'));
      }
    } finally {
      setSaving(false);
    }
  };

  return (
    <Container maxWidth="md" sx={{ py: { xs: 2, sm: 4 } }}>
      <Typography variant="h4" component="h1" gutterBottom>
        {scope === 'user' ? 'Model tiers' : 'Agent model tiers'}
      </Typography>
      <Typography color="text.secondary" sx={{ mb: 1 }}>
        {scope === 'user'
          ? 'Which model each tier uses for your runs. A tier you do not override follows the deployment default; a policy can still pin its own model.'
          : 'The deployment default for every user. A tier left empty borrows the nearest tier that is set (Fast and Frontier borrow Standard; Standard borrows Frontier, then Fast), then the AI default model.'}
      </Typography>
      <Alert severity="info" sx={{ mb: 2 }}>
        Tip: use the same model for Standard and Frontier with a different reasoning effort (low, then high). An escalation then keeps the provider&apos;s prompt cache warm.
      </Alert>
      {modelsError && (
        <Alert severity="warning" sx={{ mb: 2 }}>
          The model list is not available ({modelsError}). You can still type a model as provider:modelId.
        </Alert>
      )}
      {error && (
        <Alert severity="error" sx={{ mb: 2 }}>
          {error}
        </Alert>
      )}
      {!drafts && !error && <CircularProgress aria-label="Loading" />}
      {drafts && (
        <Stack spacing={2}>
          {TIERS.map((t) => {
            const d = drafts[t];
            const eff = effective?.[t];
            const disabled = !canWrite || d.inherit;
            return (
              <Card key={t} variant="outlined" component="section" aria-label={`${TIER_LABEL[t]} tier`}>
                <CardContent>
                  <Stack direction={{ xs: 'column', sm: 'row' }} spacing={1} sx={{ justifyContent: 'space-between', alignItems: { sm: 'center' }, mb: 1 }}>
                    <Box>
                      <Typography variant="h6" component="h2" sx={{ fontSize: '1.1rem' }}>
                        {TIER_LABEL[t]}
                      </Typography>
                      <Typography variant="body2" color="text.secondary">
                        {TIER_BLURB[t]}
                      </Typography>
                    </Box>
                    {scope === 'user' && (
                      <FormControlLabel
                        control={<Switch checked={d.inherit} disabled={!canWrite} onChange={(e) => update(t, { inherit: e.target.checked })} />}
                        label="Inherit from deployment"
                      />
                    )}
                  </Stack>
                  {eff && (
                    <Typography variant="body2" sx={{ mb: 2 }} data-testid={`effective-${t}`}>
                      Now: {eff.model ? <strong>{modelName(models, eff.model)}</strong> : 'no model selected'} ({sourceText(eff.modelSource, eff.borrowedFrom)}
                      {eff.reasoningEffort ? `, ${eff.reasoningEffort} effort` : ''}){eff.vision === false ? ' · no vision: runs work without screenshots' : ''}
                      {eff.problem ? ` · ${eff.problem}` : ''}
                    </Typography>
                  )}
                  <Box sx={{ display: 'grid', gridTemplateColumns: { xs: '1fr', sm: '1fr 1fr' }, gap: 2 }}>
                    <ModelPicker label="Model" value={d.def.model} onChange={(v) => updateDef(t, { model: v })} models={models} disabled={disabled} placeholder={scope === 'user' ? 'Deployment default' : 'Not set'} />
                    <TextField
                      select
                      size="small"
                      label="Reasoning effort"
                      value={d.def.reasoningEffort ?? ''}
                      disabled={disabled}
                      onChange={(e) => updateDef(t, { reasoningEffort: (e.target.value || null) as TierEffort | null })}
                    >
                      <MenuItem value="">Provider default</MenuItem>
                      {TIER_EFFORTS.map((x) => (
                        <MenuItem key={x} value={x}>
                          {EFFORT_LABEL[x]}
                        </MenuItem>
                      ))}
                    </TextField>
                    <TextField
                      size="small"
                      type="number"
                      label="Max output tokens"
                      value={d.tokens}
                      disabled={disabled}
                      onChange={(e) => update(t, { tokens: e.target.value })}
                      error={!d.inherit && Boolean(tokensError(d.tokens))}
                      helperText={(!d.inherit && tokensError(d.tokens)) || 'Empty uses the provider default.'}
                      slotProps={{ htmlInput: { min: 256, max: 64000, step: 1 } }}
                    />
                    <ModelPicker
                      label="Fallback model"
                      value={d.def.fallbackModel}
                      onChange={(v) => updateDef(t, { fallbackModel: v })}
                      models={models}
                      disabled={disabled}
                      placeholder="None"
                      helperText="Used when the provider errors or rate-limits, if the policy allows it."
                    />
                  </Box>
                </CardContent>
              </Card>
            );
          })}
          {saved && <Alert severity="success">Saved. New runs use these tiers; runs in progress keep theirs.</Alert>}
          {canWrite && (
            <Box>
              <Button variant="contained" disabled={saving || invalid} onClick={() => void save()}>
                Save tiers
              </Button>
            </Box>
          )}
        </Stack>
      )}
    </Container>
  );
}
