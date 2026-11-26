// The health of one target from its last diagnostic report (E50.14, #984): "Working · checked 2 h ago", "Problem · checked 5 min ago",
// "Not checked yet". A colour, an icon and words, so colour is never the only signal.
import CheckCircleOutlineIcon from '@mui/icons-material/CheckCircleOutlined';
import ErrorOutlineIcon from '@mui/icons-material/ErrorOutlined';
import HelpOutlineIcon from '@mui/icons-material/HelpOutlineOutlined';
import WarningAmberIcon from '@mui/icons-material/WarningAmber';
import { Chip } from '@mui/material';

import { formatRelative } from '../ui';
import type { DiagnosticSummary } from './api';

export function healthWords(s: Pick<DiagnosticSummary, 'overall' | 'at'> | null, now = Date.now()): string {
  if (!s || s.overall === 'skipped') return 'Not checked yet';
  const when = `checked ${formatRelative(s.at, now)}`;
  return s.overall === 'pass' ? `Working · ${when}` : s.overall === 'warn' ? `Warning · ${when}` : `Problem · ${when}`;
}

export function HealthChip({ summary }: { summary: DiagnosticSummary | null }) {
  const o = summary?.overall ?? 'skipped';
  const Icon = o === 'pass' ? CheckCircleOutlineIcon : o === 'warn' ? WarningAmberIcon : o === 'fail' ? ErrorOutlineIcon : HelpOutlineIcon;
  return (
    <Chip
      size="small"
      variant="outlined"
      color={o === 'pass' ? 'success' : o === 'warn' ? 'warning' : o === 'fail' ? 'error' : 'default'}
      icon={<Icon aria-hidden />}
      label={healthWords(summary)}
      data-testid="health-chip"
      data-health={o}
      sx={{ maxWidth: '100%' }}
    />
  );
}
