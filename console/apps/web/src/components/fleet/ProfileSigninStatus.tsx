// A profile's Google sign-in status on the Fleet page (E48.3, #929;
// docs/decisions/profile-signin-health.md). The email is display data, shown
// in full to `fleet:read`; it is never logged or traced from here.
import CheckCircleOutlineIcon from '@mui/icons-material/CheckCircleOutlined';
import HelpOutlineIcon from '@mui/icons-material/HelpOutlineOutlined';
import LoginIcon from '@mui/icons-material/Login';
import WarningAmberIcon from '@mui/icons-material/WarningAmber';
import { Box, Button, Chip, Tooltip, Typography } from '@mui/material';
import type { ElementType } from 'react';

import { needsSignin, type FleetHost, type FleetProfile, type FleetSigninReporting, type FleetSigninState } from '../../types/fleet';
import { formatRelative, useProfileTimeZone, type StatusColor } from '../../ui';

/** Each state's chip: a colour, an icon and words, so colour is never the only signal. */
export const SIGNIN_CHIP: Record<FleetSigninState, { label: string; color: StatusColor; Icon: ElementType }> = {
  signed_in: { label: 'Signed in', color: 'success', Icon: CheckCircleOutlineIcon },
  signed_out: { label: 'Not signed in to Google', color: 'warning', Icon: WarningAmberIcon },
  expired: { label: 'Google session expired', color: 'warning', Icon: WarningAmberIcon },
  unknown: { label: 'Sign-in not checked', color: 'default', Icon: HelpOutlineIcon },
};

/** The hint an attended host shows: the person signs in on their own Chrome. */
export const ATTENDED_HINT = "Sign in on this computer's Chrome";
/** The hint a host without a desktop shows. */
export const NO_DESKTOP_HINT = 'No desktop: sign in with `hexactra fleet profile show`';
/** The hint an unattended desktop host shows to a viewer without `fleet:desktop`. */
export const NO_DESKTOP_ACCESS_HINT = 'Someone with desktop access can sign this profile in';

/** A state this build does not know reads as `unknown`. */
function chipOf(state: FleetSigninState | string) {
  return (SIGNIN_CHIP as Record<string, (typeof SIGNIN_CHIP)[FleetSigninState]>)[state] ?? SIGNIN_CHIP.unknown;
}

/** How many of the host's profiles need the owner to sign in. */
export function signinNeededCount(host: Pick<FleetHost, 'profiles'>): number {
  return host.profiles.filter(needsSignin).length;
}

/** "1 profile needs sign-in", "3 profiles need sign-in". */
export function signinNeededLabel(n: number): string {
  return n === 1 ? '1 profile needs sign-in' : `${n} profiles need sign-in`;
}

/**
 * What a profile that needs sign-in offers: a Sign in button (an unattended
 * host with a desktop, for `fleet:desktop`), or a hint.
 */
export type SigninAction = { kind: 'button' } | { kind: 'hint'; text: string };

export function signinAction(host: Pick<FleetHost, 'mode' | 'desktop'>, canDesktop: boolean): SigninAction {
  if (host.mode === 'attended') return { kind: 'hint', text: ATTENDED_HINT };
  if (!host.desktop) return { kind: 'hint', text: NO_DESKTOP_HINT };
  if (host.mode === 'unattended' && canDesktop) return { kind: 'button' };
  return { kind: 'hint', text: NO_DESKTOP_ACCESS_HINT };
}

/** The emails a signed-in (or expired) profile is known by, in the order the node reported. */
function emailsOf(profile: FleetProfile, state: FleetSigninState): string[] {
  const matching = profile.accounts.filter((a) => a.state === state).map((a) => a.email);
  return matching.length ? matching : profile.accounts.map((a) => a.email);
}

/** The tooltip of a profile never checked, when the host says why (#998). */
export const FABRIC_OUTDATED_HINT = "Not reported: the server's fabric does not accept sign-in status yet. Update the server (hexactra deploy update).";
export const NOT_REPORTED_HINT = "Not reported: this node has not sent its sign-in status. Update its agent (hexactra agent update).";

function neverChecked(reporting: FleetSigninReporting | undefined): string {
  if (reporting === 'fabric_outdated') return FABRIC_OUTDATED_HINT;
  if (reporting === 'not_reported') return NOT_REPORTED_HINT;
  return 'never checked';
}

export interface SigninChipProps {
  profile: Pick<FleetProfile, 'signin' | 'checkedAt'>;
  /** The host's `signinReporting`: names the cause when the profile was never checked. */
  reporting?: FleetSigninReporting;
}

/** The sign-in chip, with "checked <relative time>" (or why it never was) as its tooltip. */
export function SigninChip({ profile, reporting }: SigninChipProps) {
  const timeZone = useProfileTimeZone();
  const chip = chipOf(profile.signin);
  const checked = profile.checkedAt ? `checked ${formatRelative(profile.checkedAt, Date.now(), { timeZone })}` : neverChecked(reporting);
  return (
    <Tooltip title={checked}>
      <Chip
        size="small"
        color={chip.color}
        icon={<chip.Icon aria-hidden />}
        label={chip.label}
        data-signin={profile.signin}
        sx={{ maxWidth: '100%', flexShrink: 0, '& .MuiChip-label': { overflow: 'hidden', textOverflow: 'ellipsis' } }}
      />
    </Tooltip>
  );
}

export interface ProfileSigninStatusProps {
  host: Pick<FleetHost, 'name' | 'mode' | 'desktop' | 'online' | 'signinReporting'>;
  profile: FleetProfile;
  canDesktop: boolean;
  /** What "Sign in" does. Opens the desktop page today; E48.4 rewires it to the guided sign-in. */
  onSignIn: (profile: FleetProfile) => void;
}

/**
 * The profile's sign-in chip, the account it is signed in as (the full email,
 * wrapping at any character so a long one never overflows a phone), and, when
 * it needs sign-in, the Sign in button or the hint for this kind of host.
 */
export function ProfileSigninStatus({ host, profile, canDesktop, onSignIn }: ProfileSigninStatusProps) {
  const state = (profile.signin in SIGNIN_CHIP ? profile.signin : 'unknown') as FleetSigninState;
  const emails = state === 'signed_in' || state === 'expired' ? emailsOf(profile, state) : [];
  const action = needsSignin(profile) ? signinAction(host, canDesktop) : null;
  return (
    <Box sx={{ display: 'flex', flexWrap: 'wrap', alignItems: 'center', columnGap: 1, rowGap: 0.5, mt: 0.5, minWidth: 0 }}>
      <SigninChip profile={profile} reporting={host.signinReporting} />
      {emails.length > 0 && (
        <Typography variant="body2" color="text.secondary" sx={{ minWidth: 0, maxWidth: '100%', overflowWrap: 'anywhere' }}>
          {state === 'signed_in' ? `Signed in as ${emails.join(', ')}` : `Last signed in as ${emails.join(', ')}`}
        </Typography>
      )}
      {action?.kind === 'button' && (
        <Button
          size="small"
          variant="outlined"
          startIcon={<LoginIcon />}
          disabled={!host.online}
          aria-label={`Sign in ${profile.name} on ${host.name}`}
          sx={{ minHeight: { xs: 44, sm: 'auto' } }}
          onClick={() => onSignIn(profile)}
        >
          Sign in
        </Button>
      )}
      {action?.kind === 'hint' && (
        <Typography variant="body2" color="text.secondary" sx={{ minWidth: 0, maxWidth: '100%', overflowWrap: 'anywhere' }}>
          {action.text}
        </Typography>
      )}
    </Box>
  );
}

/** The host card's warning: "N profiles need sign-in"; nothing when none does. */
export function HostSigninChip({ host }: { host: Pick<FleetHost, 'profiles'> }) {
  const n = signinNeededCount(host);
  if (n === 0) return null;
  return <Chip size="small" color="warning" icon={<WarningAmberIcon aria-hidden />} label={signinNeededLabel(n)} data-testid="host-signin-needed" />;
}
