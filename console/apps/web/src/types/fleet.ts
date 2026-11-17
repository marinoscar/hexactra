// The fleet's hosts, as the API returns them.

/** A browser profile on a host. */
export interface FleetProfile {
  name: string;
  running: boolean;
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
  lastSeen: string;
}

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
