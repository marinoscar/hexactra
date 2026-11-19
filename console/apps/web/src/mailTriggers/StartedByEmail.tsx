// "Started by an email" on the run page (E39.10, #607): the trigger's name when the run was started by one. The trigger's own page is the
// task's; a deleted trigger leaves "an email". Nothing about the message is shown: the console keeps none of it.
import MarkEmailReadOutlinedIcon from '@mui/icons-material/MarkEmailReadOutlined';
import { Link, Stack, Typography } from '@mui/material';
import { usePlatformHost } from '@marinoscar/platform-web/core';
import { useEffect, useState } from 'react';
import { Link as RouterLink } from 'react-router-dom';

import { listTriggers } from './api';

export function StartedByEmail({ taskId, triggerId, canRead }: { taskId: string | null; triggerId: string | null | undefined; canRead: boolean }) {
  const { api } = usePlatformHost();
  const [name, setName] = useState<string | null | undefined>(undefined);
  useEffect(() => {
    if (!taskId || !triggerId || !canRead) return;
    let stale = false;
    listTriggers(api, taskId)
      .then((rows) => !stale && setName(rows.find((t) => t.id === triggerId)?.name ?? null))
      .catch(() => !stale && setName(null));
    return () => {
      stale = true;
    };
  }, [api, taskId, triggerId, canRead]);
  if (!triggerId) return null;
  return (
    <Stack direction="row" spacing={0.75} sx={{ alignItems: 'center', mb: 1 }} data-testid="started-by-email">
      <MarkEmailReadOutlinedIcon fontSize="small" color="action" aria-hidden />
      <Typography variant="body2">
        Started by an email
        {name ? (
          <>
            {' '}
            (trigger{' '}
            {taskId ? (
              <Link component={RouterLink} to={`/tasks/${taskId}`} underline="hover">
                {name}
              </Link>
            ) : (
              name
            )}
            )
          </>
        ) : null}
      </Typography>
    </Stack>
  );
}
