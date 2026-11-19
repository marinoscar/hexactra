// "Needs you" on Home for an account (E39.10, #607): an account that must be connected again can't be used by anything, and a task that
// relies on it fails quietly. Shown only while there is one; nothing for a viewer who may not read connections.
import { Alert, Button, Stack, Typography } from '@mui/material';
import { Link as RouterLink } from 'react-router-dom';

import { useConnections } from './useConnections';

export function NeedsReconnectBlock() {
  const { connections } = useConnections();
  const broken = (connections ?? []).filter((c) => c.status === 'needs_reconnect' || c.status === 'revoked');
  if (broken.length === 0) return null;
  return (
    <Alert
      severity="warning"
      role="region"
      aria-label="Accounts that need you"
      data-testid="home-needs-reconnect"
      action={
        <Button component={RouterLink} to="/settings/connections" color="inherit" size="small" sx={{ minHeight: { xs: 44, sm: 'auto' } }}>
          Reconnect
        </Button>
      }
    >
      <Stack spacing={0.25}>
        <Typography variant="body2" sx={{ fontWeight: 600 }}>
          {broken.length === 1 ? `${broken[0]!.label} needs to be connected again.` : `${broken.length} accounts need to be connected again.`}
        </Typography>
        <Typography variant="body2">Tasks and deliveries that use {broken.length === 1 ? 'it' : 'them'} cannot run until you do.</Typography>
      </Stack>
    </Alert>
  );
}
