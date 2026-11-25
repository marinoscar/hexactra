// "This profile is not signed in to Google" (E48.5, #931): the warning the task builder, the task page and the chat's
// machine picker show while the chosen profile needs a sign-in, with a link to fix it. A warning only: nothing is
// blocked, and the fleet data comes from what the page already loads (none without `fleet:read`: then nothing shows).
import { Alert, Link } from '@mui/material';
import { Link as RouterLink } from 'react-router-dom';

import { machineState, needsSignin, type FleetHost } from '../types/fleet';

/**
 * Where the owner signs a profile in: the ONE place this link is built (the guided sign-in of E48.4 starts from the
 * machine's desktop page with `signin=1`). Used by the warnings below and by a takeover's question card.
 */
export function signinHref(hostId: string, profile: string): string {
  return `/fleet/hosts/${encodeURIComponent(hostId)}/desktop?${new URLSearchParams({ profile, signin: '1' }).toString()}`;
}

export interface ProfileNeedingSignin {
  host: FleetHost;
  profile: string;
  state: 'signed_out' | 'expired';
}

/**
 * The machine and profile to warn about, as the API decides for `PROFILE_NOT_SIGNED_IN`: on the chosen machine, or
 * with "Any available machine" only when every online machine that has the profile needs a sign-in. `unknown` never warns.
 */
export function profileNeedingSignin(hosts: readonly FleetHost[], hostId: string | null, profile: string): ProfileNeedingSignin | null {
  const chosen = hostId ? hosts.find((h) => h.id === hostId) : undefined;
  const candidates = hostId ? (chosen ? [chosen] : []) : hosts.filter((h) => machineState(h) === 'online' && h.profiles.some((p) => p.name === profile));
  if (candidates.length === 0) return null;
  const found = candidates.map((host) => ({ host, p: host.profiles.find((p) => p.name === profile) }));
  if (!found.every((f) => f.p && needsSignin(f.p))) return null;
  const first = found[0]!;
  return { host: first.host, profile, state: first.p!.signin as 'signed_out' | 'expired' };
}

export interface ProfileSigninWarningProps {
  hosts: readonly FleetHost[] | null;
  hostId: string | null;
  profile: string;
  /** A tighter alert, for a popover. */
  dense?: boolean;
  /** Called when the link is followed (a popover closes itself). */
  onNavigate?: () => void;
}

/** The warning, or nothing when the profile is signed in, unknown, or the fleet is not known. */
export function ProfileSigninWarning({ hosts, hostId, profile, dense, onNavigate }: ProfileSigninWarningProps) {
  const need = hosts ? profileNeedingSignin(hosts, hostId, profile) : null;
  if (!need) return null;
  return (
    <Alert severity="warning" data-testid="profile-signin-warning" sx={dense ? { py: 0, mx: 2, my: 1 } : undefined}>
      This profile is not signed in to Google. “{need.profile}” on {need.host.name} {need.state === 'expired' ? 'has an expired Google session' : 'is signed out'}: runs start anyway, but a site that needs your Google account stops at its sign-in page.{' '}
      <Link component={RouterLink} to={signinHref(need.host.id, need.profile)} onClick={onNavigate}>
        Sign in
      </Link>
    </Alert>
  );
}
