import ExpandMoreIcon from '@mui/icons-material/ExpandMore';
import LockOutlinedIcon from '@mui/icons-material/LockOutlined';
import {
  Accordion,
  AccordionDetails,
  AccordionSummary,
  Alert,
  Box,
  Button,
  Chip,
  CircularProgress,
  FormControlLabel,
  Link,
  MenuItem,
  Paper,
  Stack,
  Switch,
  TextField,
  ToggleButton,
  ToggleButtonGroup,
  Typography,
} from '@mui/material';
import { useUsableAiModels } from '@marinoscar/platform-web/ai/headless';
import { isPlatformApiError, usePlatformHost } from '@marinoscar/platform-web/core';
import { useCallback, useEffect, useId, useMemo, useState, type ReactNode } from 'react';
import { Link as RouterLink, useNavigate, useParams, useSearchParams } from 'react-router-dom';

import { createPolicy, duplicatePolicy, getCeilings, getPolicy, updatePolicy } from '../policies/api';
import { BUDGET_LABEL, NO_HARD_STOP_WARNING, STALL_LABEL, ceilingText, copyName, sourceText, tierRank } from '../policies/format';
import { BUDGET_HELP, CONTEXT_HELP, MODELS_HELP, SECTION_HELP, STALL_HELP, budgetHelp, plain, type FieldHelp } from '../policies/help';
import { ModelPicker, modelName } from '../policies/ModelPicker';
import {
  BUDGET_LIMIT_KEYS,
  STALL_ACTIONS,
  TIERS,
  TIER_LABEL,
  type AgentPolicy,
  type AgentPolicySpec,
  type BudgetCeilings,
  type BudgetLimitKey,
  type StallAction,
  type Tier,
} from '../policies/types';
import { errorText, usePolicyCatalog } from '../policies/usePolicyCatalog';
import { ErrorBanner, PageContainer, PageHeader } from '../ui';

/** The text of a "No limit" switch turned off when the field was never set. */
const SUGGESTED: Record<BudgetLimitKey, string> = {
  maxActions: '60',
  maxModelCalls: '120',
  maxActiveMinutes: '20',
  maxInputTokens: '2000000',
  maxOutputTokens: '200000',
  maxCostUsd: '2',
};

const STALL_NUMBERS = ['maxConsecutiveFailures', 'maxRepeatedAction', 'noProgressActions', 'maxEscalations'] as const;
const CONTEXT_NUMBERS = ['screenshotsKept', 'pruneBatch', 'callsPerChunk', 'observationChars'] as const;

const STALL_FIELD_LABEL: Record<(typeof STALL_NUMBERS)[number], string> = {
  maxConsecutiveFailures: 'Failures in a row',
  maxRepeatedAction: 'Same action repeated',
  noProgressActions: 'Actions without progress',
  maxEscalations: 'Most tier escalations',
};
const CONTEXT_FIELD_LABEL: Record<(typeof CONTEXT_NUMBERS)[number], string> = {
  screenshotsKept: 'Screenshots kept',
  pruneBatch: 'Prune batch',
  callsPerChunk: 'Model calls per chunk',
  observationChars: 'Observation size (characters)',
};

const UNLIMITED_WARNING = NO_HARD_STOP_WARNING;

/** The editor's numeric fields as typed text, keyed `budget.maxActions`, `stall.…`, `context.…`. */
type NumberDrafts = Record<string, string>;

function toDrafts(spec: AgentPolicySpec): { nums: NumberDrafts; unlimited: Record<BudgetLimitKey, boolean> } {
  const nums: NumberDrafts = {};
  const unlimited = {} as Record<BudgetLimitKey, boolean>;
  for (const k of BUDGET_LIMIT_KEYS) {
    const v = spec.budget[k];
    unlimited[k] = v === null;
    nums[`budget.${k}`] = v === null ? '' : String(v);
  }
  nums['budget.warnAtPercent'] = String(spec.budget.warnAtPercent);
  for (const k of STALL_NUMBERS) nums[`stall.${k}`] = String(spec.stall[k]);
  for (const k of CONTEXT_NUMBERS) nums[`context.${k}`] = String(spec.context[k]);
  return { nums, unlimited };
}

/** A typed number against its API bounds; an error sentence or null. */
function checkNumber(text: string, help: FieldHelp, integer: boolean): string | null {
  if (text.trim() === '') return 'Required';
  const n = Number(text);
  if (!Number.isFinite(n)) return 'A number';
  if (integer && !Number.isInteger(n)) return 'A whole number';
  if (n < help.min || n > help.max) return `From ${help.min.toLocaleString('en')} to ${help.max.toLocaleString('en')}`;
  return null;
}

/** Builds the spec from the drafts; `errors` names each invalid field. */
function buildSpec(base: AgentPolicySpec, nums: NumberDrafts, unlimited: Record<BudgetLimitKey, boolean>): { spec: AgentPolicySpec; errors: Record<string, string> } {
  const errors: Record<string, string> = {};
  const read = (key: string, help: FieldHelp, integer = true): number => {
    const err = checkNumber(nums[key] ?? '', help, integer);
    if (err) errors[key] = err;
    return Number(nums[key]);
  };
  const budget = { ...base.budget };
  for (const k of BUDGET_LIMIT_KEYS) budget[k] = unlimited[k] ? null : read(`budget.${k}`, BUDGET_HELP[k], k !== 'maxCostUsd');
  budget.warnAtPercent = read('budget.warnAtPercent', BUDGET_HELP.warnAtPercent);
  const stall = { ...base.stall };
  for (const k of STALL_NUMBERS) stall[k] = read(`stall.${k}`, STALL_HELP[k]);
  const context = { ...base.context };
  for (const k of CONTEXT_NUMBERS) context[k] = read(`context.${k}`, CONTEXT_HELP[k]);
  const pins = Object.fromEntries(TIERS.flatMap((t) => (base.models.pins?.[t] ? [[t, base.models.pins[t]]] : [])));
  const models = { startTier: base.models.startTier, maxTier: base.models.maxTier, allowProviderFallback: base.models.allowProviderFallback, ...(Object.keys(pins).length ? { pins } : {}) };
  return { spec: { schemaVersion: 1, models, budget, stall, context }, errors };
}

function Section({ title, help, children, id }: { title: string; help?: string; children: ReactNode; id: string }) {
  return (
    <Paper variant="outlined" component="section" aria-labelledby={id} sx={{ p: { xs: 2, sm: 3 } }}>
      <Typography variant="h6" component="h2" id={id} sx={{ fontSize: '1.1rem', mb: help ? 0 : 2 }}>
        {title}
      </Typography>
      {help && (
        <Typography variant="body2" color="text.secondary" sx={{ mb: 2 }}>
          {plain(help)}
        </Typography>
      )}
      <Stack spacing={2}>{children}</Stack>
    </Paper>
  );
}

function TierToggle({ label, value, onChange, minTier, disabled }: { label: string; value: Tier; onChange: (t: Tier) => void; minTier?: Tier; disabled: boolean }) {
  const labelId = useId();
  return (
    <Box>
      <Typography variant="body2" sx={{ mb: 0.5 }} id={labelId}>
        {label}
      </Typography>
      <ToggleButtonGroup exclusive size="small" color="primary" value={value} disabled={disabled} aria-labelledby={labelId} onChange={(_e, next: Tier | null) => next && onChange(next)}>
        {TIERS.map((t) => (
          <ToggleButton key={t} value={t} disabled={minTier !== undefined && tierRank(t) < tierRank(minTier)} sx={{ px: 2 }}>
            {TIER_LABEL[t]}
          </ToggleButton>
        ))}
      </ToggleButtonGroup>
    </Box>
  );
}

/**
 * `/settings/agent-policies/:id` (and `/new?from=<template>`): the policy
 * editor, a full page of sections (General, Models, Budgets, When the agent is
 * stuck, Advanced). Saves with `If-Match`; built-ins are shown read-only.
 */
export function AgentPolicyEditorPage() {
  const { id: rawId } = useParams();
  const [search] = useSearchParams();
  const isNew = rawId === undefined || rawId === 'new';
  const id = isNew ? null : rawId!;
  const templateId = search.get('from') ?? 'builtin:balanced';
  const { api, viewer } = usePlatformHost();
  const navigate = useNavigate();
  const canWrite = viewer.hasPermission('agent_policies:write');
  const catalog = usePolicyCatalog();
  const { models } = useUsableAiModels();

  const [policy, setPolicy] = useState<AgentPolicy | null>(null);
  const [name, setName] = useState('');
  const [description, setDescription] = useState('');
  const [base, setBase] = useState<AgentPolicySpec | null>(null);
  const [nums, setNums] = useState<NumberDrafts>({});
  const [unlimited, setUnlimited] = useState<Record<BudgetLimitKey, boolean>>({} as Record<BudgetLimitKey, boolean>);
  const [ceilings, setCeilings] = useState<BudgetCeilings | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [conflict, setConflict] = useState(false);
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);
  const [showErrors, setShowErrors] = useState(false);

  const load = useCallback(async () => {
    setLoadError(null);
    setConflict(false);
    setSaveError(null);
    try {
      const source = await getPolicy(api, id ?? templateId);
      setPolicy(id ? source : null);
      setName(id ? source.name : '');
      setDescription(id ? (source.description ?? '') : (source.description ?? ''));
      setBase(source.spec);
      const drafts = toDrafts(source.spec);
      setNums(drafts.nums);
      setUnlimited(drafts.unlimited);
    } catch (e) {
      setLoadError(errorText(e, 'Could not load the policy'));
    }
  }, [api, id, templateId]);

  useEffect(() => {
    void load();
  }, [load]);

  useEffect(() => {
    void getCeilings(api, viewer.hasPermission('system_settings:read')).then(setCeilings);
  }, [api, viewer]);

  const readOnly = !canWrite || Boolean(policy?.builtin);
  const built = useMemo(() => (base ? buildSpec(base, nums, unlimited) : null), [base, nums, unlimited]);
  const allUnlimited = BUDGET_LIMIT_KEYS.every((k) => unlimited[k]);

  const setModels = (patch: Partial<AgentPolicySpec['models']>) => base && setBase({ ...base, models: { ...base.models, ...patch } });
  const setPin = (tier: Tier, value: string | null) => base && setBase({ ...base, models: { ...base.models, pins: { ...base.models.pins, [tier]: value } } });
  const setNum = (key: string, text: string) => setNums((n) => ({ ...n, [key]: text }));
  const setNoLimit = (key: BudgetLimitKey, on: boolean) => {
    setUnlimited((u) => ({ ...u, [key]: on }));
    if (!on && !(nums[`budget.${key}`] ?? '').trim()) setNum(`budget.${key}`, SUGGESTED[key]);
  };

  const save = async () => {
    if (!built) return;
    setSaved(false);
    setSaveError(null);
    setConflict(false);
    if (Object.keys(built.errors).length > 0 || !name.trim()) {
      setShowErrors(true);
      setSaveError('Fix the highlighted fields first.');
      return;
    }
    setSaving(true);
    const input = { name: name.trim(), description: description.trim() || null, spec: built.spec };
    try {
      if (policy) {
        const next = await updatePolicy(api, policy.id, input, policy.version);
        setPolicy(next);
        setSaved(true);
        await catalog.reload();
      } else {
        const created = await createPolicy(api, input);
        navigate(`/settings/agent-policies/${created.id}`, { replace: true });
      }
    } catch (e) {
      if (isPlatformApiError(e) && e.status === 412) setConflict(true);
      else setSaveError(errorText(e, 'Could not save the policy'));
    } finally {
      setSaving(false);
    }
  };

  const duplicateBuiltin = async () => {
    if (!policy) return;
    try {
      const copy = await duplicatePolicy(api, policy.id, copyName(policy.name, catalog.policies.map((p) => p.name)));
      navigate(`/settings/agent-policies/${copy.id}`);
    } catch (e) {
      setSaveError(errorText(e, 'Could not duplicate the policy'));
    }
  };

  const numberField = (key: string, label: string, help: FieldHelp, opts: { integer?: boolean; disabled?: boolean; helper?: ReactNode; value?: string } = {}) => {
    const err = showErrors && built ? built.errors[key] : undefined;
    return (
      <TextField
        label={label}
        type="number"
        size="small"
        fullWidth
        value={opts.value ?? nums[key] ?? ''}
        disabled={readOnly || opts.disabled}
        onChange={(e) => setNum(key, e.target.value)}
        error={Boolean(err)}
        helperText={err ?? opts.helper ?? plain(help.text)}
        slotProps={{ htmlInput: { min: help.min, max: help.max, step: opts.integer === false ? 0.01 : 1, inputMode: opts.integer === false ? 'decimal' : 'numeric' } }}
      />
    );
  };

  if (loadError) {
    return (
      <PageContainer>
        <PageHeader title="Agent policy" back={{ to: '/settings/agent-policies', label: 'Agent policies' }} />
        <ErrorBanner error={loadError} />
      </PageContainer>
    );
  }
  if (!base || !built) {
    return (
      <Box sx={{ display: 'grid', placeItems: 'center', minHeight: '40vh' }}>
        <CircularProgress aria-label="Loading" />
      </Box>
    );
  }

  const spec = base;
  const tierEffective = (t: Tier) => {
    const pin = spec.models.pins?.[t];
    if (pin) return { model: pin, source: sourceText('pin') };
    const e = catalog.effective?.[t];
    if (!e) return null;
    return { model: e.model, source: sourceText(e.modelSource, e.borrowedFrom), vision: e.vision };
  };

  return (
    <PageContainer>
      <PageHeader title={policy ? policy.name : 'New policy'} back={{ to: '/settings/agent-policies', label: 'Agent policies' }}>
        {policy && (
          <Stack direction="row" spacing={1} sx={{ alignItems: 'center', flexWrap: 'wrap', rowGap: 1 }}>
            {policy.builtin && <LockOutlinedIcon color="action" titleAccess="Built-in (read-only)" />}
            <Chip size="small" variant="outlined" label={`v${policy.version}`} />
            {policy.isDefault && <Chip size="small" color="primary" label="Default" />}
          </Stack>
        )}
      </PageHeader>

      {policy?.builtin && (
        <Alert
          severity="info"
          sx={{ mb: 2 }}
          action={
            canWrite ? (
              <Button color="inherit" size="small" onClick={() => void duplicateBuiltin()}>
                Duplicate to edit
              </Button>
            ) : undefined
          }
        >
          Built-in policies are read-only. Duplicate one to edit a copy.
        </Alert>
      )}

      <Stack spacing={2} component="form" noValidate aria-label="Policy editor" onSubmit={(e) => (e.preventDefault(), void save())}>
        <Section title="General" id="sec-general">
          <TextField
            label="Name"
            required
            fullWidth
            size="small"
            value={policy?.builtin ? policy.name : name}
            disabled={readOnly}
            onChange={(e) => setName(e.target.value)}
            error={showErrors && !name.trim()}
            helperText="Unique among your policies."
            slotProps={{ htmlInput: { maxLength: 100 } }}
          />
          <TextField
            label="Description"
            fullWidth
            size="small"
            multiline
            minRows={2}
            value={description}
            disabled={readOnly}
            onChange={(e) => setDescription(e.target.value)}
            helperText="What the policy is for."
            slotProps={{ htmlInput: { maxLength: 500 } }}
          />
        </Section>

        <Section title="Models" help={SECTION_HELP.models} id="sec-models">
          <Stack direction={{ xs: 'column', sm: 'row' }} spacing={{ xs: 2, sm: 4 }}>
            <TierToggle
              label="Start tier"
              value={spec.models.startTier}
              disabled={readOnly}
              onChange={(t) => setModels({ startTier: t, maxTier: tierRank(spec.models.maxTier) < tierRank(t) ? t : spec.models.maxTier })}
            />
            <TierToggle label="Max tier" value={spec.models.maxTier} minTier={spec.models.startTier} disabled={readOnly} onChange={(t) => setModels({ maxTier: t })} />
          </Stack>
          <Typography variant="caption" color="text.secondary">
            {plain(MODELS_HELP.startTier)} {plain(MODELS_HELP.maxTier)}
          </Typography>
          <FormControlLabel
            control={<Switch checked={spec.models.allowProviderFallback} disabled={readOnly} onChange={(e) => setModels({ allowProviderFallback: e.target.checked })} />}
            label={
              <Box>
                <Typography variant="body2">Allow provider fallback</Typography>
                <Typography variant="caption" color="text.secondary">
                  {plain(MODELS_HELP.allowProviderFallback)}
                </Typography>
              </Box>
            }
          />
          <Typography variant="subtitle2" sx={{ pt: 1 }}>
            Model per tier
          </Typography>
          <Typography variant="body2" color="text.secondary">
            {plain(MODELS_HELP.pins)} Leave a pin empty to use the tier from your{' '}
            <Link component={RouterLink} to="/settings/agent-model-tiers">
              Model tiers
            </Link>
            .
          </Typography>
          {TIERS.map((t) => {
            const eff = tierEffective(t);
            const inRange = tierRank(t) >= tierRank(spec.models.startTier) && tierRank(t) <= tierRank(spec.models.maxTier);
            return (
              <Stack key={t} direction={{ xs: 'column', sm: 'row' }} spacing={{ xs: 1, sm: 2 }} sx={{ alignItems: { sm: 'flex-start' } }} aria-label={`${TIER_LABEL[t]} tier`}>
                <Box sx={{ width: { sm: 160 }, flexShrink: 0, pt: { sm: 1 } }}>
                  <Typography variant="body2" sx={{ fontWeight: 600 }}>
                    {TIER_LABEL[t]}
                    {!inRange && (
                      <Typography component="span" variant="caption" color="text.secondary">
                        {' '}
                        (not used)
                      </Typography>
                    )}
                  </Typography>
                  <Typography variant="caption" color="text.secondary" data-testid={`effective-${t}`}>
                    {eff ? (eff.model ? `${modelName(models, eff.model)} · ${eff.source}` : 'No model selected') : ' '}
                  </Typography>
                </Box>
                <Box sx={{ flex: 1, minWidth: 0 }}>
                  <ModelPicker label={`Pin for ${TIER_LABEL[t]} (optional)`} value={spec.models.pins?.[t] ?? null} onChange={(v) => setPin(t, v)} models={models} requireVision disabled={readOnly} placeholder="Use the tier's model" />
                </Box>
              </Stack>
            );
          })}
        </Section>

        <Section title="Budgets" help={SECTION_HELP.budget} id="sec-budgets">
          {allUnlimited && (
            <Alert severity="warning" role="alert">
              {UNLIMITED_WARNING}
            </Alert>
          )}
          {BUDGET_LIMIT_KEYS.map((k) => {
            const ceil = ceilingText(k, unlimited[k] ? null : Number(nums[`budget.${k}`]), ceilings);
            return (
              <Stack key={k} direction={{ xs: 'column', sm: 'row' }} spacing={{ xs: 0.5, sm: 2 }} sx={{ alignItems: { sm: 'flex-start' } }}>
                <Box sx={{ flex: 1, minWidth: 0 }}>
                  {numberField(`budget.${k}`, BUDGET_LABEL[k], BUDGET_HELP[k], {
                    integer: k !== 'maxCostUsd',
                    disabled: unlimited[k],
                    value: unlimited[k] ? '' : undefined,
                    helper: (
                      <>
                        {budgetHelp(k)}
                        {ceil && (
                          <Box component="span" sx={{ display: 'block', color: 'warning.main' }}>
                            {ceil}
                          </Box>
                        )}
                      </>
                    ),
                  })}
                </Box>
                <FormControlLabel
                  sx={{ flexShrink: 0, ml: { xs: 0, sm: 1 }, mt: { sm: 0.5 } }}
                  control={<Switch checked={Boolean(unlimited[k])} disabled={readOnly} onChange={(e) => setNoLimit(k, e.target.checked)} slotProps={{ input: { 'aria-label': `No limit: ${BUDGET_LABEL[k]}` } }} />}
                  label="No limit"
                />
              </Stack>
            );
          })}
          <Box sx={{ maxWidth: { sm: 320 } }}>{numberField('budget.warnAtPercent', 'Warn at (%)', BUDGET_HELP.warnAtPercent)}</Box>
        </Section>

        <Section title="When the agent is stuck" help={SECTION_HELP.stall} id="sec-stall">
          <TextField
            select
            size="small"
            fullWidth
            label="On a stall"
            value={spec.stall.onStall}
            disabled={readOnly}
            onChange={(e) => setBase({ ...spec, stall: { ...spec.stall, onStall: e.target.value as StallAction } })}
            helperText={plain(STALL_HELP.onStall)}
          >
            {STALL_ACTIONS.map((a) => (
              <MenuItem key={a} value={a}>
                {STALL_LABEL[a]}
              </MenuItem>
            ))}
          </TextField>
          <Box sx={{ display: 'grid', gridTemplateColumns: { xs: '1fr', sm: '1fr 1fr' }, gap: 2 }}>
            {STALL_NUMBERS.map((k) => (
              <Box key={k}>{numberField(`stall.${k}`, STALL_FIELD_LABEL[k], STALL_HELP[k])}</Box>
            ))}
          </Box>
        </Section>

        <Accordion variant="outlined" disableGutters>
          <AccordionSummary expandIcon={<ExpandMoreIcon />} aria-controls="sec-context-body" id="sec-context">
            <Box>
              <Typography variant="h6" component="h2" sx={{ fontSize: '1.1rem' }}>
                Advanced: context
              </Typography>
              <Typography variant="body2" color="text.secondary">
                {plain(SECTION_HELP.context)} More context can help the model decide, and costs more tokens on every call.
              </Typography>
            </Box>
          </AccordionSummary>
          <AccordionDetails id="sec-context-body">
            <Box sx={{ display: 'grid', gridTemplateColumns: { xs: '1fr', sm: '1fr 1fr' }, gap: 2 }}>
              {CONTEXT_NUMBERS.map((k) => (
                <Box key={k}>{numberField(`context.${k}`, CONTEXT_FIELD_LABEL[k], CONTEXT_HELP[k])}</Box>
              ))}
            </Box>
          </AccordionDetails>
        </Accordion>

        {conflict && (
          <Alert
            severity="warning"
            action={
              <Button color="inherit" size="small" onClick={() => void load()}>
                Reload
              </Button>
            }
          >
            This policy changed elsewhere; reload it to see the latest version (your changes here will be lost).
          </Alert>
        )}
        {saveError && <Alert severity="error">{saveError}</Alert>}
        {saved && <Alert severity="success">Saved. New runs use this version; runs in progress keep theirs.</Alert>}

        {!readOnly && (
          <Stack direction="row" spacing={1}>
            <Button type="submit" variant="contained" disabled={saving}>
              {policy ? 'Save' : 'Create policy'}
            </Button>
            <Button component={RouterLink} to="/settings/agent-policies">
              Cancel
            </Button>
          </Stack>
        )}
      </Stack>
    </PageContainer>
  );
}
