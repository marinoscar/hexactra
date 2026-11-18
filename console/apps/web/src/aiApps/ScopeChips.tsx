import WarningAmberOutlinedIcon from '@mui/icons-material/WarningAmberOutlined';
import { Chip, Stack, Tooltip } from '@mui/material';

import { MCP_SCOPE_ICONS } from '../components/McpScopeIcon';
import type { AppScope } from './types';

/**
 * What an app may do, as plain-language chips ("Delegate", "Inbox", "Drive
 * browser", ...). A scope that is not low-risk is in the warning colour with a
 * warning icon; the tooltip is the consent text. Repeated labels (the two
 * Inbox scopes) show once; "Stay connected" is left out.
 */
export function ScopeChips({ scopes, size = 'small' }: { scopes: readonly AppScope[]; size?: 'small' | 'medium' }) {
  const seen = new Map<string, AppScope>();
  for (const s of scopes) {
    if (s.id === 'offline_access') continue;
    const prev = seen.get(s.label);
    if (!prev || (prev.risk === 'low' && s.risk !== 'low')) seen.set(s.label, s);
  }
  return (
    <Stack direction="row" spacing={0.5} useFlexGap sx={{ flexWrap: 'wrap' }} data-testid="app-scopes">
      {[...seen.values()].map((s) => {
        const risky = s.risk !== 'low';
        const ScopeIcon = MCP_SCOPE_ICONS[s.id]?.Icon;
        return (
          <Tooltip key={s.label} title={s.consent}>
            <Chip
              size={size}
              label={s.label}
              color={risky ? 'warning' : 'default'}
              variant={risky ? 'filled' : 'outlined'}
              icon={risky ? <WarningAmberOutlinedIcon fontSize="small" aria-hidden /> : ScopeIcon ? <ScopeIcon fontSize="small" aria-hidden /> : undefined}
              data-risk={s.risk}
              aria-label={`${s.label}${risky ? ` (${s.risk} risk)` : ''}`}
            />
          </Tooltip>
        );
      })}
    </Stack>
  );
}
