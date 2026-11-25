// The desktop page's sign-in mode (E48.4, #930): a banner that names the profile and says what to do, follows the guided
// sign-in by polling it, then shows "Signed in as <email>" with the next steps.
import { useCallback, useEffect, useRef, useState } from 'react';
import { Alert, AlertTitle, Button, CircularProgress, Stack } from '@mui/material';
import type { PlatformApiClient } from '@marinoscar/platform-web/core';

import { ErrorBanner } from '../ui';
import { cancelProfileSignin, getProfileSignin, type ProfileSignin } from './signin';

/** How often the page polls the sign-in (each poll also moves it on). */
export const SIGNIN_POLL_MS = 2_000;

/** Cancels the page left behind a moment later, so a re-mount (React's development double effect) keeps it. */
const pendingCancel = new Map<string, number>();

/**
 * Follows a guided sign-in: polls it while it runs, and cancels it when the page goes away before it ended (closing the page
 * abandons it; the API then gives the desktop back and leaves the browser open).
 */
export function useProfileSignin(api: PlatformApiClient, id: string | null) {
  const [session, setSession] = useState<ProfileSignin | null>(null);
  const [error, setError] = useState<string | null>(null);
  const ended = useRef(false);

  useEffect(() => {
    if (!id) return;
    const queued = pendingCancel.get(id);
    if (queued !== undefined) {
      window.clearTimeout(queued);
      pendingCancel.delete(id);
    }
    let stop = false;
    let timer: number | undefined;
    const tick = async () => {
      try {
        const s = await getProfileSignin(api, id);
        if (stop) return;
        setSession(s);
        setError(null);
        ended.current = s.status !== 'started';
        if (ended.current) return;
      } catch (e) {
        if (stop) return;
        setError(e instanceof Error ? e.message : 'Could not read the sign-in');
      }
      timer = window.setTimeout(() => void tick(), SIGNIN_POLL_MS);
    };
    void tick();
    return () => {
      stop = true;
      window.clearTimeout(timer);
      if (ended.current) return;
      pendingCancel.set(
        id,
        window.setTimeout(() => {
          pendingCancel.delete(id);
          // The person left: the desktop is given back even when a queue meant to keep the lease for its next profile.
          void cancelProfileSignin(api, id, { keepLease: false }).catch(() => undefined);
        }, 300),
      );
    };
  }, [api, id]);

  /** Cancel; `keepLease` overrides the sign-in's own choice (a queue's Skip keeps it for the next profile on the host). */
  const cancel = useCallback(async (opts: { keepLease?: boolean } = {}) => {
    if (!id) return null;
    try {
      const s = await cancelProfileSignin(api, id, opts);
      ended.current = true;
      setSession(s);
      return s;
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not cancel the sign-in');
      return null;
    }
  }, [api, id]);

  return { session, error, cancel };
}

const END_REASON: Record<NonNullable<ProfileSignin['endReason']>, string> = {
  cancelled: 'You cancelled it.',
  timeout: 'It was not finished within 15 minutes.',
  profile_gone: 'The profile is no longer on the node.',
  replaced: 'Another sign-in on this node took its place.',
};

const STATE_LABEL: Record<ProfileSignin['signin'], string> = {
  signed_in: 'signed in',
  signed_out: 'signed out',
  expired: 'expired',
  unknown: 'unknown',
};

export interface ProfileSigninBannerProps {
  session: ProfileSignin | null;
  hostName: string | null;
  error?: string | null;
  onCancel: () => void;
  onBack: () => void;
  /** The next profile that needs a sign-in ("Fix sign-ins", E48.6); the button shows only with it. */
  onNext?: () => void;
  /** Skip this profile and go to the next one ("Fix sign-ins"); shown while the sign-in runs. */
  onSkip?: () => void;
  /** The label of the button that leaves (default "Back to Fleet"). */
  backLabel?: string;
}

/** What the person does now, and how the sign-in ended. */
export function ProfileSigninBanner({ session, hostName, error, onCancel, onBack, onNext, onSkip, backLabel = 'Back to Fleet' }: ProfileSigninBannerProps) {
  if (!session) {
    return error ? <ErrorBanner error={error} /> : <Alert severity="info" icon={<CircularProgress size={20} />}>Opening the sign-in…</Alert>;
  }
  const where = hostName ? ` on ${hostName}` : '';
  const next = (
    <Stack direction="row" spacing={1} sx={{ mt: 1, flexWrap: 'wrap', rowGap: 1 }}>
      <Button size="small" variant="contained" onClick={onBack}>
        {backLabel}
      </Button>
      {onNext && (
        <Button size="small" variant="outlined" onClick={onNext}>
          Next profile
        </Button>
      )}
    </Stack>
  );

  if (session.status === 'completed') {
    if (session.resultState === 'signed_in') {
      return (
        <Alert severity="success" data-testid="signin-banner" sx={{ overflowWrap: 'anywhere' }}>
          <AlertTitle>{session.email ? `Signed in as ${session.email}` : 'Signed in'}</AlertTitle>
          The &quot;{session.profile}&quot; profile is saved{session.keepLease ? '; you keep the desktop for the next profile.' : ' and the desktop is released.'}
          {next}
        </Alert>
      );
    }
    return (
      <Alert severity="warning" data-testid="signin-banner">
        <AlertTitle>The sign-in was not saved</AlertTitle>
        Chrome closed, but the &quot;{session.profile}&quot; profile reads {STATE_LABEL[session.resultState ?? 'unknown']}. Try again from the Fleet page.
        {next}
      </Alert>
    );
  }

  if (session.status === 'abandoned') {
    return (
      <Alert severity="info" data-testid="signin-banner">
        <AlertTitle>Sign-in ended</AlertTitle>
        {END_REASON[session.endReason ?? 'cancelled']} {session.keepLease ? 'You keep the desktop for the next profile' : 'The desktop is released'}; Chrome was left open as it was.
        {next}
      </Alert>
    );
  }

  const cancel = (
    <Stack direction="row" spacing={0.5}>
      {onSkip && (
        <Button color="inherit" size="small" onClick={onSkip}>
          Skip
        </Button>
      )}
      <Button color="inherit" size="small" onClick={onCancel}>
        Cancel
      </Button>
    </Stack>
  );
  if (session.phase === 'saving') {
    return (
      <Alert severity="info" icon={<CircularProgress size={20} />} action={cancel} data-testid="signin-banner" sx={{ overflowWrap: 'anywhere' }}>
        <AlertTitle>{session.email ? `Signed in as ${session.email}` : 'Signed in'}</AlertTitle>
        Saving the profile: Chrome is closing so it writes the sign-in to disk. Nothing more to do.
      </Alert>
    );
  }
  return (
    <Alert severity="info" action={cancel} data-testid="signin-banner">
      <AlertTitle>Sign in to Google in the &quot;{session.profile}&quot; profile</AlertTitle>
      Chrome for &quot;{session.profile}&quot; is open{where} at Google&apos;s sign-in, and you control the desktop. Sign in below, and
      answer anything Google asks. The console notices when you are signed in, saves the profile and gives the desktop back.
      {error && <ErrorBanner error={error} />}
    </Alert>
  );
}
