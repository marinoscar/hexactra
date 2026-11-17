/** Shapes of `/api/fleet` (apps/api/src/fleet/fleet.schemas.ts). */
export interface FleetHost {
  id: string;
  name: string;
  version: string;
  online: boolean;
  browserConnected: boolean;
  onDemand: boolean;
  draining: boolean;
  viewerUrl: string | null;
  mode: 'unattended' | 'attended' | 'container' | null;
  desktop: boolean;
  profiles: { name: string; running: boolean }[];
  lastSeen: string;
}

export interface FleetEnrollment {
  enrollmentToken: string;
  /** The fabric URL the new host uses. */
  agentUrl: string;
  expiresAt: string | null;
  command: string;
}

export interface FleetCommandResult {
  id: string;
  kind: string;
  profile: string | null;
  state: string;
  error: string | null;
  createdAt: string;
  completedAt: string | null;
}

/** One line per host, for the CLI and the TUI. */
export function hostLine(h: FleetHost): string {
  const flags = [
    h.online ? 'online' : 'offline',
    h.mode ?? (h.onDemand ? 'launch' : 'attach'),
    ...(h.desktop ? ['desktop'] : []),
    ...(h.draining ? ['disabled'] : []),
  ];
  const profiles = h.profiles.map((p) => (p.running ? `${p.name}*` : p.name)).join(', ') || '-';
  return `${h.name}  [${flags.join(', ')}]  profiles: ${profiles}`;
}

/** A host by id, id prefix or exact name. */
export function findHost(hosts: FleetHost[], ref: string): FleetHost {
  const exact = hosts.filter((h) => h.id === ref || h.name === ref);
  const matches = exact.length ? exact : hosts.filter((h) => h.id.startsWith(ref));
  if (matches.length === 1) return matches[0]!;
  if (!matches.length) throw new Error(`No host matches "${ref}". List them with \`hexactra fleet hosts\`.`);
  throw new Error(`"${ref}" matches ${matches.length} hosts: ${matches.map((h) => h.name).join(', ')}. Use the id.`);
}

/** The console page that shows a host's remote desktop. */
export function desktopUrl(consoleUrl: string, hostId: string): string {
  return `${consoleUrl.replace(/\/+$/, '')}/fleet/hosts/${hostId}/desktop`;
}
