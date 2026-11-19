import AutorenewIcon from '@mui/icons-material/Autorenew';
import BlockIcon from '@mui/icons-material/Block';
import CheckCircleOutlineIcon from '@mui/icons-material/CheckCircleOutlined';
import ErrorOutlineIcon from '@mui/icons-material/ErrorOutlined';
import HourglassEmptyIcon from '@mui/icons-material/HourglassEmpty';
import PauseCircleOutlinedIcon from '@mui/icons-material/PauseCircleOutlined';
import PersonOutlineIcon from '@mui/icons-material/PersonOutlined';
import { Chip } from '@mui/material';
import type { ElementType } from 'react';

import { BUDGET_LABEL, STALLED_LABEL, type BudgetKey } from '../components/runBudget';
import type { RunStatus, RunStopReason } from '../types/runs';

export type StatusColor = 'default' | 'info' | 'warning' | 'success' | 'error';

export const STATUS_COLOR: Record<RunStatus, StatusColor> = {
  queued: 'default',
  running: 'info',
  waiting_human: 'warning',
  paused: 'warning',
  succeeded: 'success',
  failed: 'error',
  cancelled: 'default',
};

/** The icon of each status, so colour is never the only signal. */
export const STATUS_ICON: Record<RunStatus, ElementType> = {
  queued: HourglassEmptyIcon,
  running: AutorenewIcon,
  waiting_human: PersonOutlineIcon,
  paused: PauseCircleOutlinedIcon,
  succeeded: CheckCircleOutlineIcon,
  failed: ErrorOutlineIcon,
  cancelled: BlockIcon,
};

/** A status in words; a status this build does not know reads as its raw text. */
export function statusLabel(status: RunStatus | string): string {
  return status === 'waiting_human' ? 'needs you' : status;
}

/** The run is not over: queued, running, waiting for an answer, or paused by its owner. */
export function isLive(status: RunStatus | string): boolean {
  return status === 'queued' || status === 'running' || status === 'waiting_human' || status === 'paused';
}

/** The run is over: succeeded, failed or cancelled. */
export function isTerminal(status: RunStatus | string): boolean {
  return status === 'succeeded' || status === 'failed' || status === 'cancelled';
}

const budgetLabel = (key: BudgetKey) => `${BUDGET_LABEL[key].toLowerCase()} budget`;

/**
 * Every value of `runs.stop_reason`, in words. The budget wording comes from
 * #408's `BUDGET_LABEL` (components/runBudget.ts), so the chip, the runs
 * list's stop chip and the run page's stop line name a budget the same way.
 */
export const STOP_REASON_LABEL: Record<RunStopReason, string> = {
  finished: 'finished',
  budget_actions: budgetLabel('actions'),
  budget_model_calls: budgetLabel('modelCalls'),
  budget_active_time: budgetLabel('activeMinutes'),
  budget_input_tokens: budgetLabel('inputTokens'),
  budget_output_tokens: budgetLabel('outputTokens'),
  budget_cost: budgetLabel('cost'),
  stalled: STALLED_LABEL,
  cancelled: 'cancelled',
  error: 'error',
  no_model: 'no model',
};

/** A stop reason in words; one this build does not know reads as its raw text. */
export function stopReasonLabel(reason: RunStopReason | string): string {
  return (STOP_REASON_LABEL as Record<string, string>)[reason] ?? reason;
}

/**
 * Whether the chip says the stop reason: a budget stop, a stall, a run with no
 * usable model, and a reason this build does not know. The others repeat the
 * status ("failed · error", "cancelled · cancelled").
 */
export function showsStopReason(reason: RunStopReason | string | null | undefined): reason is string {
  if (!reason) return false;
  return reason.startsWith('budget_') || reason === 'stalled' || reason === 'no_model' || !(reason in STOP_REASON_LABEL);
}

export interface StatusChipProps {
  /** A run status; an unknown one renders a default chip with its raw text. */
  status: RunStatus | string;
  /** Why the run stopped: a budget or stall stop is appended in words ("failed · cost budget"). */
  stopReason?: RunStopReason | string | null;
  size?: 'small' | 'medium';
}

/** A run's status as a chip: a colour, an icon and words. */
export function StatusChip({ status, stopReason, size = 'small' }: StatusChipProps) {
  const known = status in STATUS_COLOR ? (status as RunStatus) : null;
  const Icon = known ? STATUS_ICON[known] : null;
  const label = showsStopReason(stopReason) ? `${statusLabel(status)} · ${stopReasonLabel(stopReason)}` : statusLabel(status);
  return (
    <Chip
      size={size}
      color={known ? STATUS_COLOR[known] : 'default'}
      icon={Icon ? <Icon data-testid={`status-icon-${status}`} aria-hidden /> : undefined}
      label={label}
      data-status={status}
      sx={{ maxWidth: '100%', flexShrink: 0 }}
    />
  );
}
