// A benchmark's status and a trial's verdict as chips: a colour, an icon and words, so colour is
// never the only signal (README, "UI kit"). The run statuses' icons are the kit's.
import AutorenewIcon from '@mui/icons-material/Autorenew';
import BlockIcon from '@mui/icons-material/Block';
import CheckCircleOutlineIcon from '@mui/icons-material/CheckCircleOutlined';
import ErrorOutlineIcon from '@mui/icons-material/ErrorOutlined';
import HelpOutlineIcon from '@mui/icons-material/HelpOutlined';
import HighlightOffIcon from '@mui/icons-material/HighlightOff';
import HourglassEmptyIcon from '@mui/icons-material/HourglassEmpty';
import RemoveCircleOutlineIcon from '@mui/icons-material/RemoveCircleOutlined';
import WarningAmberIcon from '@mui/icons-material/WarningAmber';
import { Chip } from '@mui/material';
import type { ElementType } from 'react';

import type { StatusColor } from '../ui';
import type { BenchmarkStatus, TrialVerdict } from '../types/benchmarks';
import { STATUS_LABEL, VERDICT_LABEL } from './format';

const STATUS: Record<BenchmarkStatus, { color: StatusColor; Icon: ElementType }> = {
  queued: { color: 'default', Icon: HourglassEmptyIcon },
  running: { color: 'info', Icon: AutorenewIcon },
  completed: { color: 'success', Icon: CheckCircleOutlineIcon },
  cancelled: { color: 'default', Icon: BlockIcon },
  failed: { color: 'error', Icon: ErrorOutlineIcon },
};

export function BenchmarkStatusChip({ status }: { status: BenchmarkStatus | string }) {
  const known = STATUS[status as BenchmarkStatus];
  const Icon = known?.Icon;
  return (
    <Chip
      size="small"
      color={known?.color ?? 'default'}
      icon={Icon ? <Icon aria-hidden data-testid={`benchmark-status-icon-${status}`} /> : undefined}
      label={STATUS_LABEL[status as BenchmarkStatus] ?? status}
      data-status={status}
      sx={{ flexShrink: 0, maxWidth: '100%' }}
    />
  );
}

const VERDICT: Record<TrialVerdict, { color: StatusColor; Icon: ElementType }> = {
  pass: { color: 'success', Icon: CheckCircleOutlineIcon },
  fail: { color: 'error', Icon: HighlightOffIcon },
  error: { color: 'warning', Icon: WarningAmberIcon },
  skipped: { color: 'default', Icon: RemoveCircleOutlineIcon },
  unsupported: { color: 'default', Icon: BlockIcon },
};

/** A trial's verdict; a trial not judged yet reads as its status ("pending", "running"). */
export function VerdictChip({ verdict, pending }: { verdict: TrialVerdict | string | null; pending?: string }) {
  if (!verdict) {
    const running = pending === 'running';
    return <Chip size="small" variant="outlined" color={running ? 'info' : 'default'} icon={running ? <AutorenewIcon aria-hidden /> : <HourglassEmptyIcon aria-hidden />} label={pending ?? 'pending'} data-verdict="none" />;
  }
  const known = VERDICT[verdict as TrialVerdict];
  const Icon = known?.Icon ?? HelpOutlineIcon;
  return <Chip size="small" color={known?.color ?? 'default'} icon={<Icon aria-hidden />} label={VERDICT_LABEL[verdict as TrialVerdict] ?? verdict} data-verdict={verdict} sx={{ flexShrink: 0 }} />;
}

/** A one-character mark of a verdict for the dense matrix, with its word for assistive technology. */
export const VERDICT_MARK: Record<string, string> = { pass: '✓', fail: '✗', error: '!', skipped: '–', unsupported: '∅' };
