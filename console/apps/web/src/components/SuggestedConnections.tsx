import { Alert, Link, Stack } from '@mui/material';
import { Link as RouterLink } from 'react-router-dom';

/**
 * An account the owner could switch on so a job like this needs no browser (E41.5, reworded by E50.17): it is paused (`resume`) or has the
 * capability switched off (`capability`). Information only: nothing changes by itself.
 */
export interface SuggestedConnection {
  connectionId: string;
  label: string;
  provider: string;
  site: string;
  scope: 'task' | 'chat';
  fix?: 'resume' | 'capability';
  text: string;
}

/**
 * "This used the browser for Google Mail. "Marin" is paused: resume it in Connections and tools…" under a finished run, with a link to the
 * Connections page, the one place a tool is switched on. Renders nothing when there is nothing to suggest.
 */
export function SuggestedConnections({ items }: { items: SuggestedConnection[] | undefined | null; taskId?: string | null }) {
  if (!items?.length) return null;
  return (
    <Stack spacing={1} sx={{ mt: 1 }} data-testid="suggested-connections">
      {items.map((s) => (
        <Alert key={s.connectionId} severity="info" variant="outlined" sx={{ overflowWrap: 'anywhere' }}>
          {s.text}{' '}
          <Link component={RouterLink} to="/settings/connections">
            Open Connections and tools
          </Link>
        </Alert>
      ))}
    </Stack>
  );
}
