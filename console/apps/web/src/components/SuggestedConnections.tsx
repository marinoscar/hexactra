import { Alert, Link, Stack } from '@mui/material';
import { Link as RouterLink } from 'react-router-dom';

/** One account the owner could allow so a job like this needs no browser (E41.5). Information only: nothing changes by itself. */
export interface SuggestedConnection {
  connectionId: string;
  label: string;
  provider: string;
  site: string;
  scope: 'task' | 'chat';
  text: string;
}

/**
 * "This used the browser for Google Mail. You have "Marin" connected: allow it for this task…" under a finished run, with a link to where
 * the owner lists accounts: the task's page, or the chat's settings. Renders nothing when there is nothing to suggest.
 */
export function SuggestedConnections({ items, taskId }: { items: SuggestedConnection[] | undefined | null; taskId?: string | null }) {
  if (!items?.length) return null;
  return (
    <Stack spacing={1} sx={{ mt: 1 }} data-testid="suggested-connections">
      {items.map((s) => (
        <Alert key={s.connectionId} severity="info" variant="outlined" sx={{ overflowWrap: 'anywhere' }}>
          {s.text}{' '}
          {s.scope === 'task' && taskId ? (
            <Link component={RouterLink} to={`/tasks/${taskId}/edit`}>
              Choose the task's accounts
            </Link>
          ) : s.scope === 'chat' ? (
            'Add it in this chat’s settings.'
          ) : null}
        </Alert>
      ))}
    </Stack>
  );
}
