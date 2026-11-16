// What this machine needs as a browser host, per install mode (#374):
// `hexactra agent deps` and the TUI's Doctor and Install views read it.
//
// The package lists are the ones the installs use (APT_PACKAGES,
// ATTENDED_PACKAGES, DESKTOP_INPUT_PACKAGES), so the report cannot drift
// from what actually gets installed.
import { ATTENDED_PACKAGES, readState, sessionKind, type AgentDeps } from './agent.js';
import { DESKTOP_INPUT_PACKAGES, aptInstallStep, missingPackages } from './desktopTools.js';
import { runPrivileged } from './googleChrome.js';
import { APT_PACKAGES, readUnattended } from './unattended.js';

/** How the agent runs on this machine. */
export type InstallMode = 'default' | 'attended' | 'unattended';
/** What the install wizard and `agent install --mode` offer. */
export type InstallChoice = InstallMode | 'both';

export const MODE_LABELS: Record<InstallChoice, string> = {
  default: 'Default: Chrome for Testing in this desktop session',
  attended: 'Attended: your own Google Chrome and X11 desktop',
  unattended: 'Unattended: its own desktop from boot, nobody logged in',
  both: 'Both: an unattended node, plus an attended host for you',
};

export const MODE_DESCRIPTIONS: Record<InstallChoice, string> = {
  default: 'A systemd user service runs the agent with Chrome for Testing, which the CLI downloads. Good for a quick start or a spare account.',
  attended: 'The agent drives your own signed-in Google Chrome on your desktop. You can watch, and take over, from the console.',
  unattended: 'A dedicated hexactra user, its own GPU-backed desktop (XFCE on TigerVNC) and Google Chrome, started at boot. The primary home node.',
  both: 'Installs the unattended node, then an attended host named <name>-attended for your own Chrome.',
};

/** Google Chrome is installed by `agent chrome setup` (a .deb), not apt-get from the lists. */
export const GOOGLE_CHROME_PACKAGE = 'google-chrome-stable';

const PURPOSE: Record<string, string> = {
  xdotool: 'mouse and keyboard on the whole desktop',
  imagemagick: 'full-screen captures of the desktop',
  x11vnc: 'shares your desktop while someone views it',
  'libnotify-bin': 'the on-screen notice when someone views',
  'tigervnc-standalone-server': 'the unattended virtual display',
  xfce4: 'the unattended desktop session',
  'xfce4-terminal': 'a terminal on the unattended desktop',
  'dbus-x11': 'the desktop session bus',
  'x11-xserver-utils': 'display settings (xrandr)',
  'fonts-noto-color-emoji': 'emoji that render like a normal PC',
  'fonts-liberation2': 'common web fonts',
  'mesa-vulkan-drivers': 'GPU rendering for Chrome',
  [GOOGLE_CHROME_PACKAGE]: 'Google Chrome (installed by Chrome setup)',
};

/** The packages each mode needs. */
export function packagesFor(mode: InstallMode): string[] {
  switch (mode) {
    case 'default':
      return [...DESKTOP_INPUT_PACKAGES];
    case 'attended':
      return [GOOGLE_CHROME_PACKAGE, ...ATTENDED_PACKAGES];
    case 'unattended':
      return [GOOGLE_CHROME_PACKAGE, ...APT_PACKAGES];
  }
}

/** The modes a choice installs. */
export function modesOf(choice: InstallChoice): InstallMode[] {
  return choice === 'both' ? ['unattended', 'attended'] : [choice];
}

export interface DependencyRow {
  name: string;
  purpose: string;
  /** Modes that need it, in a stable order. */
  neededBy: InstallMode[];
  installed: boolean;
  /** Installed by `agent chrome setup` rather than apt-get. */
  chrome: boolean;
}

const ORDER: InstallMode[] = ['default', 'attended', 'unattended'];

/** Every package the given modes need, with whether dpkg reports it installed. */
export function dependencyReport(d: Pick<AgentDeps, 'exec'>, modes: readonly InstallMode[] = ORDER): DependencyRow[] {
  const rows = new Map<string, DependencyRow>();
  for (const mode of ORDER.filter((m) => modes.includes(m))) {
    for (const name of packagesFor(mode)) {
      const row = rows.get(name) ?? { name, purpose: PURPOSE[name] ?? '', neededBy: [], installed: false, chrome: name === GOOGLE_CHROME_PACKAGE };
      row.neededBy.push(mode);
      rows.set(name, row);
    }
  }
  const missing = new Set(missingPackages(d, [...rows.keys()]));
  for (const row of rows.values()) row.installed = !missing.has(row.name);
  return [...rows.values()];
}

/** The modes installed on this machine; all modes when nothing is installed yet. */
export function installedModes(d: Pick<AgentDeps, 'paths' | 'exec'>): InstallMode[] {
  const modes: InstallMode[] = [];
  const s = readState(d.paths);
  if (s) modes.push(s.attended ? 'attended' : 'default');
  if (readUnattended(d.paths.agentDir)) modes.push('unattended');
  return modes.length ? modes : ORDER;
}

/** Report lines for `hexactra agent deps` (and the TUI's plain fallback). */
export function dependencyLines(rows: readonly DependencyRow[]): string[] {
  const width = Math.max(10, ...rows.map((r) => r.name.length));
  return rows.map((r) => `${r.installed ? 'ok     ' : 'MISSING'}  ${r.name.padEnd(width)}  ${r.purpose}${r.purpose ? ' · ' : ''}${r.neededBy.join(', ')}`);
}

/**
 * Installs the missing apt packages of `rows` with sudo. Google Chrome is
 * left to Chrome setup (it adds Google's apt repository); the result says so.
 */
export function installMissing(d: AgentDeps, rows: readonly DependencyRow[], interactive: boolean): { installed: string[]; chromeMissing: boolean } {
  const apt = rows.filter((r) => !r.installed && !r.chrome).map((r) => r.name);
  const steps = aptInstallStep(apt, 'packages this machine needs as a browser host');
  if (steps.length) runPrivileged(d, steps, interactive);
  else d.log('No apt packages are missing.');
  const chromeMissing = rows.some((r) => r.chrome && !r.installed);
  if (chromeMissing) d.log('Google Chrome is missing: run Chrome setup (`hexactra agent chrome setup`).');
  return { installed: apt, chromeMissing };
}

// ---------------------------------------------------------------------------
// sudo from the TUI (#374)

/** sudo works without a password right now (cached, or NOPASSWD). */
export function sudoReady(d: Pick<AgentDeps, 'exec'>): boolean {
  return d.exec(['sudo', '-n', 'true']).code === 0;
}

/**
 * Validates the password with `sudo -S -v`, which caches it for this terminal
 * so the install's `sudo -n` steps run. The password goes to sudo's stdin
 * only: it is not stored, returned or logged.
 */
export function sudoAuthenticate(d: Pick<AgentDeps, 'exec'>, password: string): boolean {
  return d.exec(['sudo', '-S', '-p', '', '-v'], { input: `${password}\n` }).code === 0;
}

/** Whether a desktop session is here, for the install wizard's notes. */
export function desktopSession(d: Pick<AgentDeps, 'exec' | 'env'>): ReturnType<typeof sessionKind> {
  return sessionKind(d, d.env ?? process.env);
}
