// The fleet's hosts, as the API returns them.

/** A profile's Google sign-in state (E48, #927). */
export type FleetSigninState = 'signed_in' | 'signed_out' | 'expired' | 'unknown';

/** An account a profile is signed in to; the email is shown in full to the owner. */
export interface FleetProfileAccount {
  provider: string;
  email: string;
  state: FleetSigninState;
}

/** A browser profile on a host. */
export interface FleetProfile {
  name: string;
  running: boolean;
  /** `unknown` when never checked, the check failed, or the checks disagree. */
  signin: FleetSigninState;
  accounts: FleetProfileAccount[];
  /** When the node last checked; null when it never did. */
  checkedAt: string | null;
}

/** The profile needs the owner to sign in (signed out or expired; never `unknown`). */
export function needsSignin(p: Pick<FleetProfile, 'signin'>): boolean {
  return p.signin === 'signed_out' || p.signin === 'expired';
}

/** How a host runs its browsers (docs/nodes.md). */
export type FleetHostMode = 'unattended' | 'attended' | 'container';

/** One host, as `GET /api/fleet/hosts` returns it. */
export interface FleetHost {
  id: string;
  name: string;
  version: string;
  online: boolean;
  browserConnected: boolean;
  onDemand: boolean;
  draining: boolean;
  viewerUrl: string | null;
  mode: FleetHostMode | null;
  desktop: boolean;
  profiles: FleetProfile[];
  /**
   * Why profiles may show no sign-in status (#998): `fabric_outdated` (the server's fabric is older
   * than sign-in status), `not_reported` (the node never reported), `ok` otherwise. Older consoles omit it.
   */
  signinReporting?: FleetSigninReporting;
  lastSeen: string;
}

export type FleetSigninReporting = 'ok' | 'fabric_outdated' | 'not_reported';

/** `POST /api/fleet/enrollments`. */
export interface FleetEnrollment {
  enrollmentToken: string;
  expiresAt: string | null;
  command: string;
}

/** The machine's state as the picker shows it (#384). */
export function machineState(h: Pick<FleetHost, 'draining' | 'online'>): string {
  if (h.draining) return 'disabled';
  if (!h.online) return 'offline';
  return 'online';
}
