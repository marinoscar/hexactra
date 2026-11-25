// One-click guided sign-in of a node's browser profile (E48.4, #930): the calls the Fleet page's Sign in button and the desktop
// page's sign-in mode make (`/api/fleet/hosts/:id/profiles/:name/signin`, `/api/fleet/signin-sessions/:id`).
import { isPlatformApiError, type PlatformApiClient } from '@marinoscar/platform-web/core';

import type { FleetSigninState } from '../types/fleet';

export type ProfileSigninStatus = 'started' | 'completed' | 'abandoned';

/** A guided sign-in as the API returns it. `email` is read live from the host while the profile reads signed in. */
export interface ProfileSignin {
  id: string;
  hostId: string;
  profile: string;
  status: ProfileSigninStatus;
  /** While started: `waiting` for the person to sign in, or `saving` (Chrome was closed so the profile is saved). */
  phase: 'waiting' | 'saving' | null;
  leaseId: string | null;
  keepLease: boolean;
  signin: FleetSigninState;
  email: string | null;
  /** The profile's state when the sign-in completed. */
  resultState: FleetSigninState | null;
  endReason: 'cancelled' | 'timeout' | 'profile_gone' | 'replaced' | null;
  startedAt: string;
  expiresAt: string;
  endedAt: string | null;
}

export interface StartProfileSigninOptions {
  /** Keep the takeover lease when this sign-in ends, for the next profile on the same host ("Fix sign-ins", E48.6). */
  keepLease?: boolean;
}

/**
 * Starts a guided sign-in: the console takes over the host's desktop and opens the profile at Google's sign-in. Go to
 * {@link signinDesktopPath} next. Rejects with the API's error: `PROFILE_IN_USE` (see {@link profileInUseRun}),
 * `TAKEOVER_HELD`, `SIGNIN_UNAVAILABLE`.
 */
export function startProfileSignin(api: PlatformApiClient, hostId: string, profile: string, opts: StartProfileSigninOptions = {}): Promise<ProfileSignin> {
  return api.post<ProfileSignin>(`/fleet/hosts/${hostId}/profiles/${encodeURIComponent(profile)}/signin`, opts.keepLease ? { keepLease: true } : {});
}

/** The sign-in now; each poll moves it on (the API notices the sign-in, saves the profile and gives the desktop back). */
export function getProfileSignin(api: PlatformApiClient, id: string, signal?: AbortSignal): Promise<ProfileSignin> {
  return api.get<ProfileSignin>(`/fleet/signin-sessions/${id}`, signal ? { signal } : undefined);
}

/** Ends an unfinished sign-in: the desktop is given back and the browser is left open. */
export function cancelProfileSignin(api: PlatformApiClient, id: string, opts: StartProfileSigninOptions = {}): Promise<ProfileSignin> {
  return api.post<ProfileSignin>(`/fleet/signin-sessions/${id}/cancel`, opts.keepLease !== undefined ? { keepLease: opts.keepLease } : {});
}

/** The desktop page in sign-in mode. */
export function signinDesktopPath(s: Pick<ProfileSignin, 'hostId' | 'id'>): string {
  return `/fleet/hosts/${s.hostId}/desktop?signin=${encodeURIComponent(s.id)}`;
}

/** The run a `PROFILE_IN_USE` refusal names (its id and console link), else null. */
export function profileInUseRun(e: unknown): { runId: string; runUrl: string } | null {
  if (!isPlatformApiError(e) || e.code !== 'PROFILE_IN_USE') return null;
  const d = e.details as { runId?: unknown; runUrl?: unknown } | undefined;
  return typeof d?.runId === 'string' && typeof d.runUrl === 'string' ? { runId: d.runId, runUrl: d.runUrl } : null;
}
