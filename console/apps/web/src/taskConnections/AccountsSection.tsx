// "Accounts the agent may use" (E39.10, #607) for a chat, and "Tools and accounts" for a task (#967). A task uses every account and tool the
// owner connected, at what they switched on for each, unless the owner limits it; a chat lists its own. Hidden without `connections:read`;
// read-only without write access. The task form asks nothing about the browser (#967): the agent opens one when the job needs a website.
import { Alert, Box, Button, Chip, Link, Stack, Typography } from '@mui/material';
import { Link as RouterLink } from 'react-router-dom';

import { AccountChoices } from '../connections/AccountChoices';
import type { Connection } from '../connections/api';
import { ProviderMark } from '../connections/ProviderMark';
import { ACCOUNTS_HELP, ALL_TOOLS_HELP, LIMITED_HELP, capabilityChips, limitFromAll, usableConnections, type ConnectionSelection, type ConnectionsMode } from './model';

export interface AccountsSectionProps {
  /** `null` while loading. */
  connections: readonly Connection[] | null;
  failed?: boolean;
  selections: readonly ConnectionSelection[];
  onChange: (next: ConnectionSelection[]) => void;
  disabled?: boolean;
  /** A task (#967): everything the owner connected (`all`) unless limited (`listed`). A chat has no mode: it lists its own. */
  mode?: { value: ConnectionsMode; onChange: (mode: ConnectionsMode, selections: ConnectionSelection[]) => void };
}

/** An MCP server's enabled tool count, or the chips of what an account can do. */
function whatItDoes(c: Connection): string[] {
  if (c.provider === 'mcp') {
    const n = c.mcp?.tools.enabled ?? 0;
    return [`${n} tool${n === 1 ? '' : 's'} switched on`];
  }
  return capabilityChips(c);
}

function EverythingList({ connections }: { connections: readonly Connection[] }) {
  const usable = usableConnections(connections);
  return (
    <Stack component="ul" spacing={1} sx={{ listStyle: 'none', m: 0, p: 0 }} aria-label="Accounts and tools the agent may use">
      {usable.map((c) => (
        <Box component="li" key={c.id} data-testid={`uses-${c.id}`} sx={{ display: 'flex', gap: 1.5, alignItems: 'flex-start', minWidth: 0 }}>
          <Box sx={{ pt: 0.25, flexShrink: 0 }}>
            <ProviderMark provider={c.provider} />
          </Box>
          <Box sx={{ minWidth: 0 }}>
            <Typography sx={{ fontWeight: 600, overflowWrap: 'anywhere' }}>{c.label}</Typography>
            <Stack direction="row" spacing={0.5} useFlexGap sx={{ flexWrap: 'wrap', mt: 0.5 }}>
              {whatItDoes(c).map((w) => (
                <Chip key={w} size="small" label={w} />
              ))}
            </Stack>
          </Box>
        </Box>
      ))}
    </Stack>
  );
}

export function AccountsSection({ connections, failed = false, selections, onChange, disabled = false, mode }: AccountsSectionProps) {
  if (connections === null) return <Typography color="text.secondary">Loading your accounts…</Typography>;
  const none = connections.length === 0 && !failed;
  const connectLink = (
    <Typography color="text.secondary">
      You have not connected an account or a tool yet.{' '}
      <Link component={RouterLink} to="/settings/connections">
        Connect one
      </Link>{' '}
      to let the agent read your mail or calendar, write a document, or use a tool you add.
    </Typography>
  );
  const failedNote = failed && <Alert severity="warning">Your accounts could not be loaded. Saving keeps the accounts this already has.</Alert>;

  if (mode && mode.value === 'all') {
    return (
      <Stack spacing={2}>
        <Typography variant="body2" color="text.secondary">
          {ALL_TOOLS_HELP}
        </Typography>
        {failedNote}
        {none ? connectLink : <EverythingList connections={connections} />}
        {!none && !failed && (
          <Box>
            <Button size="small" variant="text" disabled={disabled} onClick={() => mode.onChange('listed', selections.length > 0 ? [...selections] : limitFromAll(connections))}>
              Limit this task
            </Button>
          </Box>
        )}
      </Stack>
    );
  }

  return (
    <Stack spacing={2}>
      <Typography variant="body2" color="text.secondary">
        {mode ? LIMITED_HELP : ACCOUNTS_HELP}
      </Typography>
      {failedNote}
      {none ? connectLink : <AccountChoices connections={connections} selections={selections} onChange={onChange} disabled={disabled} />}
      {mode && (
        <Box>
          <Button size="small" variant="text" disabled={disabled} onClick={() => mode.onChange('all', [])}>
            Use everything I connected
          </Button>
        </Box>
      )}
    </Stack>
  );
}
