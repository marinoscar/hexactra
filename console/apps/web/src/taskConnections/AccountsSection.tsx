// What the agent can use (E50.17, #987): one read-only line, the same on the task form and in the chat settings. A tool that is set up and
// switched on is always available, so there is nothing to choose here: the owner's switch on the Connections page is the only one. Hidden
// without `connections:read` (the caller decides).
import { Alert, Link, Stack, Typography } from '@mui/material';
import { Link as RouterLink } from 'react-router-dom';

import type { Connection } from '../connections/api';
import { switchedOnNames } from './model';

export interface SwitchedOnToolsProps {
  /** `null` while loading. */
  connections: readonly Connection[] | null;
  failed?: boolean;
}

const connectionsLink = (
  <Link component={RouterLink} to="/settings/connections">
    Connections and tools
  </Link>
);

export function SwitchedOnTools({ connections, failed = false }: SwitchedOnToolsProps) {
  if (failed) return <Alert severity="warning">Your connections could not be loaded. The agent can still use everything you switched on in {connectionsLink}.</Alert>;
  if (connections === null) return <Typography color="text.secondary">Loading your connections…</Typography>;
  const names = switchedOnNames(connections);
  return (
    <Stack spacing={1} data-testid="switched-on-tools">
      {names.length === 0 ? (
        <Typography variant="body2" color="text.secondary" sx={{ overflowWrap: 'anywhere' }}>
          Nothing is switched on in {connectionsLink} yet: connect an account or add a tool there, and every task and chat can use it.
        </Typography>
      ) : (
        <Typography variant="body2" color="text.secondary" sx={{ overflowWrap: 'anywhere' }}>
          The agent can use everything you switched on in {connectionsLink}: {names.join(', ')}.
        </Typography>
      )}
      <Typography variant="body2" color="text.secondary">
        It asks you before it sends or changes anything, unless you told it not to ask again.
      </Typography>
    </Stack>
  );
}
