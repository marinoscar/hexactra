// The three-way choice for each of the owner's accounts (E39.10, #607): Not used, Read only, Read and change. Shared by the task form
// and the chat settings. A paused account, or one that needs to be connected again, is shown disabled with a link that fixes it.
import { Box, Chip, Link, Stack, ToggleButton, ToggleButtonGroup, Typography } from '@mui/material';
import { Link as RouterLink } from 'react-router-dom';

import { ACCESS_WORDS, accessOf, capabilityChips, choiceBlocked, withAccess, type AccessChoice, type ConnectionSelection } from '../taskConnections/model';
import type { Connection } from './api';
import { ProviderMark } from './ProviderMark';
import { STATUS_WORDS } from './words';

export interface AccountChoicesProps {
  connections: readonly Connection[];
  selections: readonly ConnectionSelection[];
  onChange: (next: ConnectionSelection[]) => void;
  disabled?: boolean;
}

const CHOICES: AccessChoice[] = ['none', 'read', 'read_write'];

/** An MCP connection's enabled tool count, when the API sends it (E39.9). */
const toolCountOf = (c: Connection): number | null => {
  const n = (c as Connection & { enabledToolCount?: unknown }).enabledToolCount;
  return typeof n === 'number' ? n : null;
};

export function AccountChoices({ connections, selections, onChange, disabled = false }: AccountChoicesProps) {
  return (
    <Stack component="ul" spacing={1.5} sx={{ listStyle: 'none', m: 0, p: 0 }} aria-label="Accounts">
      {connections.map((c) => {
        const current = accessOf(selections, c.id);
        const tools = toolCountOf(c);
        const unusable = c.status !== 'active';
        const reasons = CHOICES.map((choice) => choiceBlocked(c, choice, current));
        const shownReason = reasons.find((r, i) => r && CHOICES[i] !== 'none' && current !== CHOICES[i]) ?? null;
        return (
          <Box component="li" key={c.id} data-testid={`account-${c.id}`} sx={{ border: 1, borderColor: 'divider', borderRadius: 1, p: 1.5, minWidth: 0 }}>
            <Stack direction="row" spacing={1.5} sx={{ alignItems: 'flex-start' }}>
              <Box sx={{ pt: 0.25, flexShrink: 0 }}>
                <ProviderMark provider={c.provider} />
              </Box>
              <Box sx={{ minWidth: 0, flex: 1 }}>
                <Stack direction="row" spacing={1} useFlexGap sx={{ flexWrap: 'wrap', alignItems: 'center' }}>
                  <Typography component="span" sx={{ fontWeight: 600, overflowWrap: 'anywhere' }}>
                    {c.label}
                  </Typography>
                  {unusable && <Chip size="small" color="warning" variant="outlined" label={STATUS_WORDS[c.status]} />}
                  {tools !== null && <Chip size="small" variant="outlined" label={tools === 1 ? '1 tool' : `${tools} tools`} />}
                </Stack>
                <Typography variant="body2" color="text.secondary" sx={{ overflowWrap: 'anywhere' }}>
                  {c.accountEmail}
                </Typography>
                <Stack direction="row" spacing={0.5} useFlexGap sx={{ flexWrap: 'wrap', mt: 0.5 }} aria-label="What it may do">
                  {capabilityChips(c).map((chip) => (
                    <Chip key={chip} size="small" label={chip} />
                  ))}
                </Stack>
                <ToggleButtonGroup
                  exclusive
                  size="small"
                  value={current}
                  onChange={(_e, value: AccessChoice | null) => {
                    if (value) onChange(withAccess(selections, c.id, value));
                  }}
                  aria-label={`How the agent may use ${c.label}`}
                  disabled={disabled}
                  sx={{ mt: 1, flexWrap: 'wrap', '& .MuiToggleButton-root': { minHeight: { xs: 44, sm: 36 }, textTransform: 'none', px: 1.5 } }}
                >
                  {CHOICES.map((choice, i) => (
                    <ToggleButton key={choice} value={choice} disabled={disabled || Boolean(reasons[i])} aria-label={`${ACCESS_WORDS[choice]}: ${c.label}`}>
                      {ACCESS_WORDS[choice]}
                    </ToggleButton>
                  ))}
                </ToggleButtonGroup>
                {unusable && (
                  <Typography variant="body2" color="warning.main" sx={{ mt: 0.75 }}>
                    {c.status === 'paused' ? 'Paused, so nothing can use it. ' : 'It needs to be connected again. '}
                    <Link component={RouterLink} to="/settings/connections" underline="always">
                      {c.status === 'paused' ? 'Resume it' : 'Reconnect it'}
                    </Link>
                  </Typography>
                )}
                {!unusable && shownReason && (
                  <Typography variant="caption" color="text.secondary" component="p" sx={{ mt: 0.5 }}>
                    {shownReason}
                  </Typography>
                )}
              </Box>
            </Stack>
          </Box>
        );
      })}
    </Stack>
  );
}
