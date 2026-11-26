import { Link, Typography } from '@mui/material';
import { Link as RouterLink } from 'react-router-dom';

import type { ChatMessage } from '../types/chat';

/** The saved task a chat run was started from (E51.2, #1007): `meta.taskId` and `meta.taskName` of its `run` message; null for any other run. */
export function runTaskOf(message: Pick<ChatMessage, 'kind' | 'meta'>): { id: string; name: string } | null {
  if (message.kind !== 'run') return null;
  const meta = message.meta as { taskId?: unknown; taskName?: unknown } | null;
  if (typeof meta?.taskId !== 'string' || !meta.taskId || typeof meta.taskName !== 'string') return null;
  return { id: meta.taskId, name: meta.taskName };
}

/**
 * The first line of a task run's Browser card: Using your task "Send a text", the name a link to the task. It matters because the run's
 * limits (allowed sites, the confirmation setting, saved logins) are the task's, not the chat's.
 */
export function UsingTask({ message }: { message: Pick<ChatMessage, 'kind' | 'meta'> }) {
  const task = runTaskOf(message);
  if (!task) return null;
  return (
    <Typography variant="body2" sx={{ mb: 0.5, overflowWrap: 'anywhere' }} data-testid="using-task">
      Using your task{' '}
      <Link component={RouterLink} to={`/tasks/${encodeURIComponent(task.id)}`}>
        &quot;{task.name}&quot;
      </Link>
    </Typography>
  );
}
