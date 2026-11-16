import { join } from 'node:path';

import type { AgentPaths } from './paths.js';

/** What the agent runs with, recorded in install.json and rendered into the unit. */
export interface AgentConfig {
  name: string;
  agentUrl: string;
  browser: string;
  maxBrowsers: number;
  /** Set when Chrome needs its setuid sandbox helper. */
  sandboxHelper?: string | undefined;
  /** Run without a desktop session (WantedBy=default.target); the browser then needs a display some other way. */
  noDesktop?: boolean | undefined;
  /**
   * Attended mode (#341): the agent drives the person's own Google Chrome
   * (extension by policy) and shares their X11 desktop on demand; it
   * launches no browser of its own.
   */
  attended?: boolean | undefined;
}

/** The agent's environment: no secret in it (the host credential is a 0600 file the agent reads). */
export function agentEnv(paths: AgentPaths, c: AgentConfig): Record<string, string> {
  if (c.attended) {
    return {
      HEXACTRA_URL: c.agentUrl,
      HEXACTRA_HOST_NAME: c.name,
      HEXACTRA_HOST_MODE: 'attended',
      // x11vnc on a private socket, only while someone views (with a notice on screen).
      HEXACTRA_DESKTOP_VNC: 'x11vnc',
    };
  }
  return {
    HEXACTRA_URL: c.agentUrl,
    HEXACTRA_HOST_NAME: c.name,
    HEXACTRA_BROWSER: c.browser,
    HEXACTRA_EXTENSION_DIR: join(paths.current, 'extension'),
    HEXACTRA_NATIVE_HOST: join(paths.current, 'bin', 'hexactra-native-host'),
    HEXACTRA_PROFILES_DIR: paths.profilesDir,
    HEXACTRA_MAX_BROWSERS: String(c.maxBrowsers),
    ...(c.sandboxHelper ? { CHROME_DEVEL_SANDBOX: c.sandboxHelper } : {}),
  };
}

const quote = (v: string) => `"${v.replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/%/g, '%%')}"`;

/**
 * The systemd user unit. It belongs to the desktop session, so the browser
 * gets the session's display (DISPLAY / WAYLAND_DISPLAY come from the user
 * manager's environment, which the desktop imports at login). No
 * `NoNewPrivileges`: it would stop Chrome's setuid sandbox helper.
 */
export function unitFile(paths: AgentPaths, c: AgentConfig): string {
  const target = c.noDesktop ? 'default.target' : 'graphical-session.target';
  const env = Object.entries(agentEnv(paths, c)).map(([k, v]) => `Environment=${quote(`${k}=${v}`)}`);
  return [
    '# Managed by `hexactra agent`; edits are replaced by the next install or update.',
    '[Unit]',
    `Description=Hexactra browser host (hexactra agent${c.attended ? ', attended: your own Chrome and desktop' : ''})`,
    ...(c.noDesktop ? [] : ['PartOf=graphical-session.target', 'After=graphical-session.target']),
    '',
    '[Service]',
    `ExecStart=${quote(join(paths.current, 'bin', 'hexactra-agent'))} daemon`,
    ...env,
    'Restart=on-failure',
    'RestartSec=3',
    // Browsers get time to flush cookies on stop.
    'TimeoutStopSec=30',
    '',
    '[Install]',
    `WantedBy=${target}`,
    '',
  ].join('\n');
}
