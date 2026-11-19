// What a trigger did with the messages it saw (E39.8, #605): "Started a run", "Skipped: sender not verified". No subject or sender is
// stored, so there is none to show: the run is the link.
import { Alert, Link, Stack, Typography } from '@mui/material';
import { useEffect, useState } from 'react';
import { Link as RouterLink } from 'react-router-dom';
import { usePlatformHost } from '@marinoscar/platform-web/core';

import { RelativeTime } from '../ui';
import { listEvents, type TriggerEvent } from './api';
import { eventText } from './model';

export function TriggerEvents({ triggerId, refreshKey, canReadRuns }: { triggerId: string; refreshKey?: string; canReadRuns: boolean }) {
  const { api } = usePlatformHost();
  const [events, setEvents] = useState<TriggerEvent[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    let stale = false;
    listEvents(api, triggerId)
      .then((rows) => {
        if (!stale) setEvents(rows);
      })
      .catch((e: unknown) => {
        if (!stale) setError(e instanceof Error && e.message ? e.message : 'Could not load the history');
      });
    return () => {
      stale = true;
    };
  }, [api, triggerId, refreshKey]);

  if (error) return <Alert severity="error">{error}</Alert>;
  if (events === null) return <Typography variant="body2" color="text.secondary">Loading…</Typography>;
  if (events.length === 0) return <Typography variant="body2" color="text.secondary">No matching email yet.</Typography>;
  return (
    <Stack component="ul" spacing={0.5} aria-label="What this trigger did" sx={{ listStyle: 'none', m: 0, p: 0 }} data-testid="trigger-events">
      {events.map((e) => (
        <Typography key={e.id} component="li" variant="body2" sx={{ overflowWrap: 'anywhere' }}>
          {e.runId && canReadRuns ? (
            <Link component={RouterLink} to={`/runs/${e.runId}`} underline="hover">
              {eventText(e)}
            </Link>
          ) : (
            eventText(e)
          )}{' '}
          <Typography component="span" variant="caption" color="text.secondary">
            <RelativeTime iso={e.createdAt} />
          </Typography>
        </Typography>
      ))}
    </Stack>
  );
}
