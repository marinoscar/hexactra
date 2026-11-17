import AutorenewIcon from '@mui/icons-material/Autorenew';
import BlockIcon from '@mui/icons-material/Block';
import CheckCircleOutlineIcon from '@mui/icons-material/CheckCircleOutlined';
import ErrorOutlineIcon from '@mui/icons-material/ErrorOutlined';
import HourglassEmptyIcon from '@mui/icons-material/HourglassEmpty';
import PersonOutlineIcon from '@mui/icons-material/PersonOutlined';
import { Chip } from '@mui/material';
import type { ElementType } from 'react';

import type { RunStatus, RunStopReason } from '../types/runs';

export type StatusColor = 'default' | 'info' | 'warning' | 'success' | 'error';

export const STATUS_COLOR: Record<RunStatus, StatusColor> = {
  queued: 'default',
  running: 'info',
  waiting_human: 'warning',
  succeeded: 'success',
  failed: 'error',
  cancelled: 'default',
};

/** The icon of each status, so colour is never the only signal. */
export const STATUS_ICON: Record<RunStatus, ElementType> = {
  queued: HourglassEmptyIcon,
  running: AutorenewIcon,
  waiting_human: PersonOutlineIcon,
  succeeded: CheckCircleOutlineIcon,
  failed: ErrorOutlineIcon,
  cancelled: BlockIcon,
};

/** A status in words; a status this build does not know reads as its raw text. */
export function statusLabel(status: RunStatus | string): string {
  return status === 'waiting_human' ? 'needs you' : status;
}

/** The run still needs a host or a person: queued, running or waiting for an answer. */
export function isLive(status: RunStatus | string): boolean {
  return status === 'queued' || status === 'running' || status === 'waiting_human';
}

/** The run is over: succeeded, failed or cancelled. */
export function isTerminal(status: RunStatus | string): boolean {
  return status === 'succeeded' || status === 'failed' || status === 'cancelled';
}

/** Every value of `runs.stop_reason`, in words. */
export const STOP_REASON_LABEL: Record<RunStopReason, string> = {
  finished: 'finished',
  budget_actions: 'action budget',
  budget_model_calls: 'model call budget',
  budget_active_time: 'time budget',
  budget_input_tokens: 'input token budget',
  budget_output_tokens: 'output token budget',
  budget_cost: 'cost budget',
  stalled: 'stalled',
  cancelled: 'cancelled',
  error: 'error',
  no_model: 'no model',
};

/** A stop reason in words; one this build does not know reads as its raw text. */
export function stopReasonLabel(reason: RunStopReason | string): string {
  return (STOP_REASON_LABEL as Record<string, string>)[reason] ?? reason;
}

/**
 * Whether the chip says the stop reason: a budget stop, a stall, and a reason
 * this build does not know. The others repeat the status ("failed · error").
 */
export function showsStopReason(reason: RunStopReason | string | null | undefined): reason is string {
  if (!reason) return false;
  return reason.startsWith('budget_') || reason === 'stalled' || !(reason in STOP_REASON_LABEL);
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
