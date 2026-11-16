import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, readlinkSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';

import { runPrivileged, type ChromeDeps, type PrivilegedStep } from './googleChrome.js';

/**
 * An unattended node (#340, docs/nodes.md): a persistent desktop that starts
 * at boot with nobody logged in, owned by a dedicated `hexactra` OS user.
 *
 * - **Display:** TigerVNC's Xvnc (the distribution's package) at 1920x1080,
 *   serving the desktop only on a Unix socket in a 0700 directory, never on
 *   TCP. XFCE runs on it.
 * - **Browser:** Google Chrome, one per profile, with the extension installed
 *   by policy. On a machine with Intel or AMD graphics, Chrome renders with the
 *   GPU (ANGLE on Vulkan through the render node), so WebGL reports real
 *   hardware rather than a software renderer.
 * - **Agent:** the same bundle, copied to /opt/hexactra (root-owned), run as
 *   `hexactra`, with its own host credential (0600, readable only by it).
 *
 * Three system units: the display, the desktop session and the agent.
 */

export const NODE_USER = 'hexactra';

export interface NodeLayout {
  home: string;
  opt: string;
  unitDir: string;
  runtimeDir: string;
  x11Dir: string;
  drmDir: string;
}

export const DEFAULT_LAYOUT: NodeLayout = {
  home: '/var/lib/hexactra',
  opt: '/opt/hexactra',
  unitDir: '/etc/systemd/system',
  runtimeDir: '/run/hexactra',
  x11Dir: '/tmp/.X11-unix',
  drmDir: '/sys/class/drm',
};

export const UNITS = {
  display: 'hexactra-desktop.service',
  session: 'hexactra-session.service',
  agent: 'hexactra-node-agent.service',
} as const;

export const APT_PACKAGES = [
  'tigervnc-standalone-server',
  'xfce4',
  'xfce4-terminal',
  'dbus-x11',
  'x11-xserver-utils',
  'fonts-noto-color-emoji',
  'fonts-liberation2',
  'mesa-vulkan-drivers',
] as const;

const GPU_DRIVERS = new Set(['i915', 'xe', 'amdgpu']);

export interface Gpu {
  /** e.g. /dev/dri/renderD128 */
  renderNode: string;
  driver: string;
}

/** The first Intel or AMD render node (the NVIDIA proprietary driver is not supported for this). */
export function detectGpu(layout: NodeLayout = DEFAULT_LAYOUT): Gpu | null {
  let entries: string[];
  try {
    entries = readdirSync(layout.drmDir).filter((e) => /^renderD\d+$/.test(e)).sort();
  } catch {
    return null;
  }
  for (const e of entries) {
    try {
      const driver = basename(readlinkSync(join(layout.drmDir, e, 'device', 'driver')));
      if (GPU_DRIVERS.has(driver)) return { renderNode: `/dev/dri/${e}`, driver };
    } catch {
      // not a usable device
    }
  }
  return null;
}

/** The first free X display number from 90 up. */
export function freeDisplay(layout: NodeLayout = DEFAULT_LAYOUT, from = 90): number {
  for (let n = from; n < from + 100; n++) {
    if (!existsSync(join(layout.x11Dir, `X${n}`)) && !existsSync(`/tmp/.X${n}-lock`)) return n;
  }
  throw new Error('No free X display between :90 and :189');
}

export interface UnattendedConfig {
  name: string;
  agentUrl: string;
  display: number;
  maxBrowsers: number;
  gpu: Gpu | null;
  resolution: string;
}

export const vncSocket = (layout: NodeLayout) => `${layout.runtimeDir}/vnc.sock`;

const q = (v: string) => `"${v.replace(/(["\\])/g, '\\$1')}"`;

/** Chrome flags for a node: no keyring (nobody logs in), and the GPU when there is one. */
export function chromeArgs(gpu: Gpu | null): string[] {
  const args = ['--password-store=basic'];
  if (gpu) args.push('--use-angle=vulkan', '--enable-features=Vulkan,DefaultANGLEVulkan,VulkanFromANGLE', '--ignore-gpu-blocklist');
  return args;
}

export function displayUnit(c: UnattendedConfig, layout: NodeLayout = DEFAULT_LAYOUT): string {
  return `# Written by \`hexactra agent install --mode unattended\` (#340). Do not edit: re-run the install.
[Unit]
Description=Hexactra node desktop (virtual display :${c.display})
After=network.target

[Service]
User=${NODE_USER}
Group=${NODE_USER}
RuntimeDirectory=${basename(layout.runtimeDir)}
RuntimeDirectoryMode=0700
RuntimeDirectoryPreserve=yes
# The desktop is served only on a Unix socket (0600) in a 0700 directory
# owned by ${NODE_USER}: no TCP port, and only the agent (same user) can
# connect, so the VNC protocol's own authentication is not needed. A person
# reaches it through the console, over the agent's outbound HTTPS tunnel.
ExecStart=/usr/bin/Xtigervnc :${c.display} -geometry ${c.resolution} -depth 24 -rfbunixpath ${vncSocket(layout)} -rfbunixmode 0600 -rfbport -1 -SecurityTypes None -nolisten tcp -AlwaysShared -desktop ${q(c.name)}
Restart=always
RestartSec=2

[Install]
WantedBy=multi-user.target
`;
}

export function sessionUnit(c: UnattendedConfig, layout: NodeLayout = DEFAULT_LAYOUT): string {
  return `# Written by \`hexactra agent install --mode unattended\` (#340). Do not edit: re-run the install.
[Unit]
Description=Hexactra node desktop session (XFCE on :${c.display})
Requires=${UNITS.display}
After=${UNITS.display}
PartOf=${UNITS.display}

[Service]
User=${NODE_USER}
Group=${NODE_USER}
Environment=DISPLAY=:${c.display}
Environment=HOME=${layout.home}
Environment=XDG_RUNTIME_DIR=${layout.runtimeDir}
ExecStartPre=/bin/sh -c 'for i in $(seq 100); do [ -S ${layout.x11Dir}/X${c.display} ] && exit 0; sleep 0.1; done; exit 1'
# No screen saver, blanking or power management: nobody sits at this desktop.
ExecStartPre=/usr/bin/xset s off -dpms s noblank
ExecStart=/usr/bin/dbus-run-session -- /usr/bin/startxfce4
Restart=always
RestartSec=2

[Install]
WantedBy=multi-user.target
`;
}

export function agentUnit(c: UnattendedConfig, layout: NodeLayout = DEFAULT_LAYOUT): string {
  const env: [string, string][] = [
    ['DISPLAY', `:${c.display}`],
    ['HOME', layout.home],
    ['XDG_CONFIG_HOME', `${layout.home}/.config`],
    ['XDG_DATA_HOME', `${layout.home}/.local/share`],
    ['XDG_RUNTIME_DIR', layout.runtimeDir],
    ['HEXACTRA_URL', c.agentUrl],
    ['HEXACTRA_HOST_NAME', c.name],
    ['HEXACTRA_HOST_MODE', 'unattended'],
    ['HEXACTRA_DESKTOP_VNC', `unix:${vncSocket(layout)}`],
    ['HEXACTRA_BROWSER', '/opt/google/chrome/chrome'],
    ['HEXACTRA_PROFILES_DIR', `${layout.home}/profiles`],
    ['HEXACTRA_MAX_BROWSERS', String(c.maxBrowsers)],
  ];
  const args = chromeArgs(c.gpu).map((a) => ` --browser-arg=${a}`).join('');
  return `# Written by \`hexactra agent install --mode unattended\` (#340). Do not edit: re-run the install.
# The host credential is ${layout.home}/.config/hexactra/host-credential.json (0600, ${NODE_USER} only), never in this file.
[Unit]
Description=Hexactra node agent (unattended browsers for ${c.name})
Wants=network-online.target
After=network-online.target ${UNITS.session}
Requires=${UNITS.display}

[Service]
User=${NODE_USER}
Group=${NODE_USER}
${env.map(([k, v]) => `Environment=${q(`${k}=${v}`)}`).join('\n')}
ExecStart=${layout.opt}/agent/current/bin/hexactra-agent daemon${args}
Restart=always
RestartSec=3
# Browsers flush cookies and sign-ins on SIGTERM.
TimeoutStopSec=45

[Install]
WantedBy=multi-user.target
`;
}

/** What `install --mode unattended` records for the owner (no secret). */
export interface UnattendedState {
  hostId: string;
  name: string;
  agentUrl: string;
  display: number;
  maxBrowsers: number;
  resolution: string;
  gpu: Gpu | null;
  bundle: string;
  installedAt: string;
  updatedAt: string;
}

export const unattendedStateFile = (agentDir: string) => join(agentDir, 'unattended.json');

export function readUnattended(agentDir: string): UnattendedState | null {
  try {
    return JSON.parse(readFileSync(unattendedStateFile(agentDir), 'utf8')) as UnattendedState;
  } catch {
    return null;
  }
}

export function writeUnattended(agentDir: string, s: UnattendedState): void {
  mkdirSync(agentDir, { recursive: true });
  writeFileSync(unattendedStateFile(agentDir), `${JSON.stringify(s, null, 2)}\n`);
}

/**
 * The root steps of an unattended install, in order. Files are staged in
 * `stage` (the caller's private temp directory) and installed from there.
 */
export function installSteps(
  c: UnattendedConfig,
  o: { bundleDir: string; bundleId: string; credential: string | null; stage: string; userExists: boolean },
  layout: NodeLayout = DEFAULT_LAYOUT,
): PrivilegedStep[] {
  const files: [string, string][] = [
    [UNITS.display, displayUnit(c, layout)],
    [UNITS.session, sessionUnit(c, layout)],
    [UNITS.agent, agentUnit(c, layout)],
  ];
  for (const [n, body] of files) writeFileSync(join(o.stage, n), body);
  const target = `${layout.opt}/agent/${o.bundleId}`;
  const steps: PrivilegedStep[] = [
    { what: `install the desktop packages (${APT_PACKAGES.join(', ')})`, argv: ['apt-get', 'install', '-y', '--no-install-recommends', ...APT_PACKAGES] },
  ];
  if (!o.userExists) {
    steps.push({ what: `create the system user ${NODE_USER} (no login shell; home ${layout.home})`, argv: ['useradd', '--system', '--create-home', '--home-dir', layout.home, '--shell', '/usr/sbin/nologin', NODE_USER] });
  }
  steps.push(
    { what: `let ${NODE_USER} use the graphics card (groups video and render)`, argv: ['usermod', '-aG', 'video,render', NODE_USER] },
    { what: `make ${layout.home} private to ${NODE_USER}`, argv: ['chmod', '0700', layout.home] },
    { what: `create ${target}`, argv: ['install', '-d', '-m', '0755', target] },
    { what: `copy the agent ${o.bundleId} there (root-owned, read-only for ${NODE_USER})`, argv: ['cp', '-a', '--no-preserve=ownership', `${o.bundleDir}/.`, `${target}/`] },
    { what: 'point the agent at this version', argv: ['ln', '-sfn', target, `${layout.opt}/agent/current`] },
  );
  if (o.credential) {
    steps.push(
      { what: `store the host credential for ${NODE_USER} (0600)`, argv: ['install', '-D', '-m', '0600', '-o', NODE_USER, '-g', NODE_USER, o.credential, `${layout.home}/.config/hexactra/host-credential.json`] },
    );
  }
  for (const [n] of files) {
    steps.push({ what: `install ${n}`, argv: ['install', '-m', '0644', '-o', 'root', '-g', 'root', join(o.stage, n), `${layout.unitDir}/${n}`] });
  }
  steps.push(
    { what: 'reload systemd', argv: ['systemctl', 'daemon-reload'] },
    { what: 'start the desktop and the agent now and at every boot', argv: ['systemctl', 'enable', '--now', UNITS.display, UNITS.session, UNITS.agent] },
    { what: 'restart the agent with this configuration', argv: ['systemctl', 'restart', UNITS.agent] },
  );
  return steps;
}

export function uninstallSteps(o: { purgeProfiles: boolean }, layout: NodeLayout = DEFAULT_LAYOUT): PrivilegedStep[] {
  const steps: PrivilegedStep[] = [
    { what: 'stop the unattended desktop and agent', argv: ['systemctl', 'disable', '--now', UNITS.agent, UNITS.session, UNITS.display] },
    { what: 'remove their units', argv: ['rm', '-f', ...Object.values(UNITS).map((u) => `${layout.unitDir}/${u}`)] },
    { what: 'reload systemd', argv: ['systemctl', 'daemon-reload'] },
    { what: `remove ${layout.opt}`, argv: ['rm', '-rf', layout.opt] },
  ];
  if (o.purgeProfiles) {
    steps.push({ what: `delete the ${NODE_USER} user, its browser profiles and sign-ins`, argv: ['userdel', '--remove', NODE_USER] });
  } else {
    steps.push({ what: `remove the host credential (profiles stay in ${layout.home}/profiles)`, argv: ['rm', '-f', `${layout.home}/.config/hexactra/host-credential.json`] });
  }
  return steps;
}

/** Runs root steps with files staged in a private temp directory. */
export function withStage<T>(work: (stage: string) => T): T {
  const stage = mkdtempSync(join(tmpdir(), 'hexactra-node-'));
  try {
    return work(stage);
  } finally {
    rmSync(stage, { recursive: true, force: true });
  }
}

export { runPrivileged, type ChromeDeps };
