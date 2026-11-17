import { useEffect, useState } from 'react';
import { Alert, AlertTitle, Box, Chip, LinearProgress, Paper, Stack, Tooltip, Typography } from '@mui/material';

import { meterRows, policyChipLabel, spendLine, stopLine, TIER_LABEL, tierChip, type RunBudget, type RunPolicy, type RunTier, type StopReasonRun, type TaskSpend } from './runBudget';

/** `policy: Balanced v1 · default`, `tier: Standard → Frontier` (highlighted once escalated) and `model: …`. */
export function RunHeaderChips({ policy, tier }: { policy?: RunPolicy | null; tier?: RunTier | null }) {
  if (!policy && !tier) return null;
  const t = tier ? tierChip(tier) : null;
  return (
    <Stack direction="row" spacing={1} sx={{ mb: 1, flexWrap: 'wrap', rowGap: 1 }} aria-label="Run policy">
      {policy && <Chip size="small" variant="outlined" label={policyChipLabel(policy)} data-testid="policy-chip" />}
      {tier && t && (
        <Tooltip title={`Starts on ${TIER_LABEL[tier.start]}; may escalate up to ${TIER_LABEL[tier.max]}${tier.escalations ? ` (${tier.escalations} escalation${tier.escalations === 1 ? '' : 's'} so far)` : ''}`}>
          <Chip size="small" color={t.escalated ? 'warning' : 'default'} variant={t.escalated ? 'filled' : 'outlined'} label={t.label} data-testid="tier-chip" />
        </Tooltip>
      )}
      {tier && <Chip size="small" variant="outlined" label={`model: ${tier.model ?? 'not resolved'}`} data-testid="model-chip" sx={{ maxWidth: '100%' }} />}
    </Stack>
  );
}

/**
 * One compact bar per limited budget (used / limit, percent), the used figure
 * with "∞" for an unlimited one. `ticking` (a running run) moves active time
 * forward between stream events, from when this budget arrived.
 */
export function RunBudgetMeter({ budget, ticking, now }: { budget: RunBudget; ticking: boolean; now: number }) {
  const [receivedAt, setReceivedAt] = useState(() => Date.now());
  useEffect(() => setReceivedAt(Date.now()), [budget]);
  const extra = ticking ? Math.max(0, now - receivedAt) / 60_000 : 0;
  const rows = meterRows(budget, extra);
  return (
    <Paper variant="outlined" sx={{ p: 1.5, mb: 2 }} aria-label="Budget" role="group">
      <Typography variant="subtitle2" sx={{ mb: 1 }}>
        Budget
      </Typography>
      <Box sx={{ display: 'grid', gridTemplateColumns: { xs: '1fr', sm: '1fr 1fr', md: '1fr 1fr 1fr' }, columnGap: 2, rowGap: 1.25 }}>
        {rows.map((r) => (
          <Box key={r.key} data-testid={`budget-${r.key}`} data-tone={r.tone}>
            <Stack direction="row" spacing={1} sx={{ alignItems: 'baseline' }}>
              <Typography variant="caption" color="text.secondary" sx={{ flexGrow: 1 }}>
                {r.label}
                {r.ceiling ? ' (ceiling)' : ''}
              </Typography>
              <Typography variant="caption" sx={{ fontVariantNumeric: 'tabular-nums' }} color={r.tone === 'primary' ? 'text.primary' : `${r.tone}.main`}>
                {r.text}
                {r.percent !== null ? ` · ${Math.floor(r.percent)}%` : ''}
              </Typography>
              {r.limit === null && (
                <Typography variant="caption" color="text.secondary" aria-label="unlimited">
                  ∞
                </Typography>
              )}
            </Stack>
            {r.percent !== null ? (
              <LinearProgress
                variant="determinate"
                color={r.tone}
                value={Math.min(100, r.percent)}
                aria-label={`${r.label} budget`}
                sx={{ height: 6, borderRadius: 3 }}
              />
            ) : (
              <Box sx={{ height: 6, borderRadius: 3, border: 1, borderStyle: 'dashed', borderColor: 'divider' }} />
            )}
          </Box>
        ))}
      </Box>
    </Paper>
  );
}

/** "Stopped: cost budget reached ($2.00)." with the agent's summary, for a run that has a stop reason. */
export function RunStopReason({ run }: { run: StopReasonRun }) {
  const line = stopLine(run);
  if (!line) return null;
  return (
    <Alert severity={line.severity} sx={{ my: 2 }} data-testid="stop-reason">
      <AlertTitle>{line.title}</AlertTitle>
      {line.summary && <Box sx={{ whiteSpace: 'pre-wrap' }}>{line.summary}</Box>}
      {line.detail && <Box sx={{ whiteSpace: 'pre-wrap' }}>{line.detail}</Box>}
    </Alert>
  );
}

/** A task's last-30-days spend (#408). */
export function TaskSpendLine({ spend }: { spend: TaskSpend | null | undefined }) {
  if (!spend) return null;
  return (
    <Typography variant="body2" color="text.secondary" sx={{ mt: 1 }} data-testid="task-spend">
      {spendLine(spend)}
    </Typography>
  );
}
