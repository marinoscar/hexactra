import { useCallback, useEffect, useRef, useState } from 'react';
import { Link as RouterLink, useNavigate, useSearchParams } from 'react-router-dom';
import { Alert, AlertTitle, Box, Button, Card, CardContent, Chip, Link, List, ListItem, Stack, Typography } from '@mui/material';
import CheckCircleOutlineIcon from '@mui/icons-material/CheckCircleOutlined';
import ErrorOutlineIcon from '@mui/icons-material/ErrorOutlined';
import HourglassEmptyIcon from '@mui/icons-material/HourglassEmpty';
import LoginIcon from '@mui/icons-material/Login';
import ReplayIcon from '@mui/icons-material/Replay';
import SkipNextIcon from '@mui/icons-material/SkipNext';
import type { ElementType } from 'react';
import { usePlatformHost } from '@marinoscar/platform-web/core';

import { SigninChip } from '../components/fleet/ProfileSigninStatus';
import { cancelProfileSignin, getProfileSignin, type ProfileSignin } from '../fleet/signin';
import {
  buildSigninQueue,
  groupByHost,
  loadQueue,
  queueDesktopPath,
  recordResult,
  releaseHeld,
  retryItems,
  saveQueue,
  startNext,
  summaryOf,
  type QueueItem,
  type QueueItemStatus,
  type SigninQueue,
} from '../fleet/signinQueue';
import type { FleetHost } from '../types/fleet';
import { CardSkeleton, EmptyState, ErrorBanner, PageContainer, PageHeader, type StatusColor } from '../ui';

const STATUS: Record<QueueItemStatus, { label: string; color: StatusColor; Icon: ElementType }> = {
  pending: { label: 'To do', color: 'default', Icon: HourglassEmptyIcon },
  signed_in: { label: 'Signed in', color: 'success', Icon: CheckCircleOutlineIcon },
  skipped: { label: 'Skipped', color: 'warning', Icon: SkipNextIcon },
  failed: { label: 'Failed', color: 'error', Icon: ErrorOutlineIcon },
};

function message(e: unknown, fallback: string): string {
  return e instanceof Error && e.message ? e.message : fallback;
}

/**
 * `/fleet/signin-queue`: "Fix sign-ins" (E48.6, #932). Every profile that needs a Google sign-in on an unattended node with a
 * desktop, grouped by host, signed in one at a time with the guided sign-in (the desktop page in sign-in mode, `&queue=1`).
 * The desktop page comes back here with `?from=<sign-in id>`: the item's outcome is recorded and the next one starts
 * (`&stop=1`: the person went back to the list, and the kept lease is released). Profiles the console cannot sign in are
 * listed with the Fleet page's hint.
 */
export function SigninQueuePage() {
  const { api, viewer } = usePlatformHost();
  const canDesktop = viewer.hasPermission('fleet:desktop');
  const navigate = useNavigate();
  const [params] = useSearchParams();
  const [queue, setQueue] = useState<SigninQueue | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const init = useRef(false);

  const commit = useCallback((q: SigninQueue | null) => {
    saveQueue(q);
    setQueue(q);
  }, []);

  /** Starts the next pending profile and opens its desktop; one at a time. */
  const run = useCallback(
    async (q: SigninQueue) => {
      setBusy(true);
      setError(null);
      try {
        const { queue: next, session } = await startNext(api, q);
        commit(next);
        if (session) navigate(queueDesktopPath(session));
      } catch (e) {
        setError(message(e, 'Could not start the next sign-in'));
      } finally {
        setBusy(false);
      }
    },
    [api, commit, navigate],
  );

  useEffect(() => {
    if (init.current) return;
    init.current = true;
    const from = params.get('from');
    const stop = params.get('stop') === '1';
    const stored = loadQueue();
    void (async () => {
      // Back from the desktop page: record the outcome, then move on (or stay on the list).
      if (from && stored?.active?.sessionId === from) {
        let s: ProfileSignin | null = await getProfileSignin(api, from).catch(() => null);
        if (s?.status === 'started') s = await cancelProfileSignin(api, from, { keepLease: !stop && s.keepLease }).catch(() => s);
        const q = recordResult(stored, s);
        navigate('/fleet/signin-queue', { replace: true });
        if (stop) {
          commit(await releaseHeld(api, q));
          return;
        }
        commit(q);
        await run(q);
        return;
      }
      // The browser's Back to an earlier step: show the queue as it is.
      if (from && stored) {
        commit(stored);
        return;
      }
      // A new queue from the fleet as it is now; a lease an earlier queue kept is given back first.
      try {
        if (stored) await releaseHeld(api, stored);
        const hosts = await api.get<FleetHost[]>('/fleet/hosts');
        commit(buildSigninQueue(hosts, canDesktop));
      } catch (e) {
        setError(message(e, 'Could not load the fleet'));
      }
    })();
  }, [api, canDesktop, commit, navigate, params, run]);

  const retry = (keys: string[]) => {
    if (queue) void run(retryItems(queue, keys));
  };

  const finish = async () => {
    if (queue) await releaseHeld(api, queue);
    commit(null);
    navigate('/fleet');
  };

  const counts = queue ? summaryOf(queue) : null;
  const keysOf = (status: QueueItemStatus) => queue?.items.filter((it) => it.status === status).map((it) => it.key) ?? [];
  const primary =
    queue && counts && counts.pending > 0
      ? { key: 'start', label: queue.ran ? 'Continue' : 'Start', Icon: LoginIcon, onClick: () => void run(queue), disabled: busy }
      : queue
        ? { key: 'done', label: 'Done', onClick: () => void finish(), disabled: busy }
        : undefined;

  return (
    <PageContainer>
      <PageHeader
        title="Fix sign-ins"
        back={{ to: '/fleet', label: 'Fleet' }}
        subtitle="One profile at a time: Google flags sign-ins on several new devices at once."
        primary={primary}
      />
      <ErrorBanner error={error} />
      {queue === null && !error && <CardSkeleton rows={2} />}
      {queue && queue.items.length === 0 && queue.onNode.length === 0 && (
        <EmptyState Icon={CheckCircleOutlineIcon} title="Nothing to fix" body="Every profile is signed in or not yet checked." action={{ key: 'fleet', label: 'Back to Fleet', to: '/fleet' }} />
      )}

      {queue && counts && queue.items.length > 0 && counts.pending === 0 && (
        <Alert severity={counts.failed ? 'warning' : counts.skipped ? 'info' : 'success'} sx={{ mb: 2 }} data-testid="queue-summary">
          <AlertTitle>Summary</AlertTitle>
          <Stack spacing={1}>
            <SummaryRow label="Signed in" n={counts.signed_in} />
            <SummaryRow label="Skipped" n={counts.skipped} onRetry={() => retry(keysOf('skipped'))} disabled={busy} />
            <SummaryRow label="Failed" n={counts.failed} onRetry={() => retry(keysOf('failed'))} disabled={busy} />
          </Stack>
        </Alert>
      )}

      {queue && queue.items.length > 0 && (
        <Stack spacing={2} aria-label="Sign-in queue" sx={{ mb: 2 }}>
          {groupByHost(queue.items).map((g) => (
            <Card key={g.hostId} variant="outlined" aria-label={`Host ${g.hostName}`}>
              <CardContent>
                <Typography variant="h6" component="h2" sx={{ overflowWrap: 'anywhere' }}>
                  {g.hostName}
                </Typography>
                <List dense disablePadding>
                  {g.items.map((it) => (
                    <QueueRow key={it.key} item={it} onRetry={() => retry([it.key])} disabled={busy} />
                  ))}
                </List>
              </CardContent>
            </Card>
          ))}
        </Stack>
      )}

      {queue && queue.onNode.length > 0 && (
        <Card variant="outlined" aria-label="Sign in on the node">
          <CardContent>
            <Typography variant="h6" component="h2">
              Sign in on the node
            </Typography>
            <Typography variant="body2" color="text.secondary" sx={{ mb: 1 }}>
              The console cannot open these profiles&apos; desktop.
            </Typography>
            <List dense disablePadding>
              {queue.onNode.map((o) => (
                <ListItem key={o.key} disableGutters sx={{ display: 'block' }}>
                  <Typography sx={{ overflowWrap: 'anywhere' }}>
                    {o.profile} <Typography component="span" color="text.secondary">on {o.hostName}</Typography>
                  </Typography>
                  <Typography variant="body2" color="text.secondary" sx={{ overflowWrap: 'anywhere' }}>
                    {o.hint}
                  </Typography>
                </ListItem>
              ))}
            </List>
          </CardContent>
        </Card>
      )}
    </PageContainer>
  );
}

function SummaryRow({ label, n, onRetry, disabled }: { label: string; n: number; onRetry?: () => void; disabled?: boolean }) {
  return (
    <Box sx={{ display: 'flex', alignItems: 'center', flexWrap: 'wrap', columnGap: 1, rowGap: 0.5 }} data-testid={`summary-${label.toLowerCase().replace(' ', '-')}`}>
      <Typography>
        {label}: <strong>{n}</strong>
      </Typography>
      {onRetry && n > 0 && (
        <Button size="small" color="inherit" variant="outlined" startIcon={<ReplayIcon />} onClick={onRetry} disabled={disabled} sx={{ minHeight: { xs: 44, sm: 'auto' } }}>
          Retry {label.toLowerCase()}
        </Button>
      )}
    </Box>
  );
}

function QueueRow({ item, onRetry, disabled }: { item: QueueItem; onRetry: () => void; disabled: boolean }) {
  const st = STATUS[item.status];
  return (
    <ListItem disableGutters divider data-testid="queue-item" data-key={item.key} data-status={item.status} sx={{ display: 'block', py: 1 }}>
      <Box sx={{ display: 'flex', alignItems: 'center', flexWrap: 'wrap', columnGap: 1, rowGap: 0.5, minWidth: 0 }}>
        <Typography component="p" sx={{ fontWeight: 500, minWidth: 0, overflowWrap: 'anywhere', mr: 'auto' }}>
          {item.profile}
        </Typography>
        <Chip size="small" color={st.color} icon={<st.Icon aria-hidden />} label={st.label} />
        {item.status === 'pending' && <SigninChip profile={{ signin: item.state, checkedAt: item.checkedAt }} />}
        {(item.status === 'skipped' || item.status === 'failed') && (
          <Button size="small" startIcon={<ReplayIcon />} onClick={onRetry} disabled={disabled} aria-label={`Retry ${item.profile} on ${item.hostName}`} sx={{ minHeight: { xs: 44, sm: 'auto' } }}>
            Retry
          </Button>
        )}
      </Box>
      {item.reason && (
        <Typography variant="body2" color="text.secondary" sx={{ overflowWrap: 'anywhere' }}>
          {item.reason}
          {item.runUrl && (
            <>
              {' '}
              (
              <Link component={RouterLink} to={item.runUrl}>
                the run
              </Link>
              )
            </>
          )}
        </Typography>
      )}
    </ListItem>
  );
}
