import { useEffect, useState } from 'react';
import { Alert, AlertTitle, Box, Button, Chip, LinearProgress, Paper, Stack, Tooltip, Typography } from '@mui/material';

import { meterRows, type MeterRow, policyChipLabel, spendLine, stopLine, TIER_LABEL, tierChip, type RunBudget, type RunPolicy, type RunTier, type StopReasonRun, type TaskSpend } from './runBudget';

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

/** The budget closest to its limit: the one bar a collapsed meter shows. The first row when none is limited. */
export function mostUsedRow(rows: MeterRow[]): MeterRow | undefined {
  return rows.reduce<MeterRow | undefined>((best, r) => (r.percent !== null && (best === undefined || best.percent === null || r.percent > best.percent) ? r : best), rows[0]);
}

export interface RunBudgetMeterProps {
  budget: RunBudget;
  ticking: boolean;
  now: number;
  /** On a phone: show only the most-used bar until "Show all" is pressed. */
  collapsible?: boolean;
  /** How many bars sit side by side at most (a narrow pane takes fewer). Default 3. */
  maxColumns?: 1 | 2 | 3;
}

/**
 * One compact bar per limited budget (used / limit, percent), the used figure
 * with "∞" for an unlimited one. `ticking` (a running run) moves active time
 * forward between stream events, from when this budget arrived.
 */
export function RunBudgetMeter({ budget, ticking, now, collapsible = false, maxColumns = 3 }: RunBudgetMeterProps) {
  const [receivedAt, setReceivedAt] = useState(() => Date.now());
  useEffect(() => setReceivedAt(Date.now()), [budget]);
  const [expanded, setExpanded] = useState(false);
  const extra = ticking ? Math.max(0, now - receivedAt) / 60_000 : 0;
  const all = meterRows(budget, extra);
  const collapsed = collapsible && !expanded && all.length > 1;
  const top = mostUsedRow(all);
  const rows = collapsed && top ? [top] : all;
  const columns = collapsed ? '1fr' : { xs: '1fr', sm: maxColumns >= 2 ? '1fr 1fr' : '1fr', md: `repeat(${maxColumns}, 1fr)` };
  return (
    <Paper variant="outlined" sx={{ p: 1.5, mb: 2 }} aria-label="Budget" role="group">
      <Stack direction="row" sx={{ alignItems: 'center', mb: 1, minHeight: collapsible ? 32 : undefined }}>
        <Typography variant="subtitle2" sx={{ flexGrow: 1 }}>
          Budget
        </Typography>
        {collapsible && all.length > 1 && (
          <Button size="small" aria-expanded={expanded} onClick={() => setExpanded((e) => !e)} sx={{ minHeight: 32, my: -0.5 }}>
            {expanded ? 'Show less' : `Show all ${all.length}`}
          </Button>
        )}
      </Stack>
      <Box sx={{ display: 'grid', gridTemplateColumns: columns, columnGap: 2, rowGap: 1.25 }}>
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
