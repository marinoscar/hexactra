// An unattended node (#340): the units serve the desktop on a private Unix
// socket only and carry no secret; the GPU is detected from the render nodes;
// the install asks for sudo once and hands the credential to the node user only.
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { ATTENDED_PACKAGES, agentDoctor, installAgent, installUnattended, sessionKind, unattendedControl, uninstallUnattended, updateUnattended, type AgentDeps, type ExecResult } from './agent.js';
import { DESKTOP_INPUT_PACKAGES } from './desktopTools.js';
import { BUNDLE_NAME } from './bundle.js';
import { policyText } from './googleChrome.js';
import { agentPaths } from './paths.js';
import {
  APT_PACKAGES,
  agentUnit,
  chromeArgs,
  detectGpu,
  displayUnit,
  freeDisplay,
  installSteps,
  readUnattended,
  sessionUnit,
  uninstallSteps,
  UNITS,
  type NodeLayout,
  type UnattendedConfig,
} from './unattended.js';

const HOST_ID = '77777777-7777-4777-8777-777777777777';
const HOST_TOKEN = 'hxh_unattended_secret_token_0123456789';

function layoutIn(root: string): NodeLayout {
  return {
    home: join(root, 'var/lib/hexactra'),
    opt: join(root, 'opt/hexactra'),
    unitDir: join(root, 'etc/systemd/system'),
    runtimeDir: '/run/hexactra',
    x11Dir: join(root, 'tmp/.X11-unix'),
    drmDir: join(root, 'sys/class/drm'),
  };
}

function gpuDevice(layout: NodeLayout, node: string, driver: string) {
  mkdirSync(join(layout.drmDir, node, 'device'), { recursive: true });
  const drv = join(layout.drmDir, '..', '..', 'bus', driver);
  mkdirSync(drv, { recursive: true });
  symlinkSync(drv, join(layout.drmDir, node, 'device', 'driver'));
}

const config: UnattendedConfig = { name: 'mini pc', agentUrl: 'https://console.example.test/fabric', display: 90, maxBrowsers: 2, gpu: null, resolution: '1920x1080' };

describe('the unattended units', () => {
  it('serve the desktop only on a private Unix socket, as the hexactra user', () => {
    const u = displayUnit(config);
    expect(u).toContain('User=hexactra');
    expect(u).toContain('RuntimeDirectoryMode=0700');
    expect(u).toContain('ExecStart=/usr/bin/Xtigervnc :90 -geometry 1920x1080 -depth 24 -rfbunixpath /run/hexactra/vnc.sock -rfbunixmode 0600 -rfbport -1 -SecurityTypes None -nolisten tcp -AlwaysShared -desktop "mini pc"');
    expect(u).toContain('WantedBy=multi-user.target');
    expect(sessionUnit(config)).toContain('ExecStart=/usr/bin/dbus-run-session -- /usr/bin/startxfce4');
    expect(sessionUnit(config)).toContain('xset s off -dpms');
  });

  it('runs the agent with Google Chrome, the desktop socket and no secret', () => {
    const u = agentUnit(config);
    for (const env of ['DISPLAY=:90', 'HEXACTRA_HOST_MODE=unattended', 'HEXACTRA_DESKTOP_VNC=unix:/run/hexactra/vnc.sock', 'HEXACTRA_BROWSER=/opt/google/chrome/chrome', 'HEXACTRA_URL=https://console.example.test/fabric', 'XDG_CONFIG_HOME=/var/lib/hexactra/.config']) {
      expect(u).toContain(`Environment="${env}"`);
    }
    expect(u).toContain('ExecStart=/opt/hexactra/agent/current/bin/hexactra-agent daemon --browser-arg=--password-store=basic\n');
    expect(u).not.toMatch(/hx[hes]_|TOKEN=|--load-extension|--remote-debugging|--enable-automation|--headless/);
    const gpu = agentUnit({ ...config, gpu: { renderNode: '/dev/dri/renderD128', driver: 'i915' } });
    expect(gpu).toContain('--browser-arg=--use-angle=vulkan');
    expect(chromeArgs(null)).toEqual(['--password-store=basic']);
  });
});

describe('graphics and display detection', () => {
  it('finds an Intel or AMD render node, not NVIDIA', () => {
    const l = layoutIn(mkdtempSync(join(tmpdir(), 'hx-gpu-')));
    expect(detectGpu(l)).toBeNull();
    gpuDevice(l, 'renderD128', 'nvidia');
    expect(detectGpu(l)).toBeNull();
    gpuDevice(l, 'renderD129', 'amdgpu');
    expect(detectGpu(l)).toEqual({ renderNode: '/dev/dri/renderD129', driver: 'amdgpu' });
  });

  it('picks the first free display from :90', () => {
    const l = layoutIn(mkdtempSync(join(tmpdir(), 'hx-x11-')));
    mkdirSync(l.x11Dir, { recursive: true });
    expect(freeDisplay(l)).toBe(90);
    writeFileSync(join(l.x11Dir, 'X90'), '');
    expect(freeDisplay(l)).toBe(91);
  });
});

describe('install and uninstall steps', () => {
  it('creates the user only when missing and gives the credential to it only', () => {
    const stage = mkdtempSync(join(tmpdir(), 'hx-stage-'));
    const steps = installSteps(config, { bundleDir: '/b', bundleId: '0.3.0-abcdef1', credential: join(stage, 'c.json'), stage, userExists: false });
    const cmds = steps.map((s) => s.argv.join(' '));
    expect(cmds[0]).toMatch(/^apt-get install -y --no-install-recommends tigervnc-standalone-server xfce4 /);
    expect(cmds).toContain('useradd --system --create-home --home-dir /var/lib/hexactra --shell /usr/sbin/nologin hexactra');
    expect(cmds).toContain(`install -D -m 0600 -o hexactra -g hexactra ${join(stage, 'c.json')} /var/lib/hexactra/.config/hexactra/host-credential.json`);
    expect(cmds).toContain('ln -sfn /opt/hexactra/agent/0.3.0-abcdef1 /opt/hexactra/agent/current');
    // The agent (user hexactra) can write next to its credential.
    expect(cmds).toContain('install -d -m 0700 -o hexactra -g hexactra /var/lib/hexactra/.config /var/lib/hexactra/.config/hexactra');
    expect(cmds.indexOf('install -d -m 0700 -o hexactra -g hexactra /var/lib/hexactra/.config /var/lib/hexactra/.config/hexactra')).toBeLessThan(cmds.findIndex((c) => c.includes('host-credential.json')));
    expect(cmds.at(-2)).toBe(`systemctl enable --now ${UNITS.display} ${UNITS.session} ${UNITS.agent}`);
    expect(readdirSync(stage).sort()).toEqual(['hexactra-desktop.service', 'hexactra-node-agent.service', 'hexactra-session.service']);

    const again = installSteps(config, { bundleDir: '/b', bundleId: 'x', credential: null, stage, userExists: true }).map((s) => s.argv[0]);
    expect(again).not.toContain('useradd');
    expect(installSteps(config, { bundleDir: '/b', bundleId: 'x', credential: null, stage, userExists: true }).some((s) => s.argv.includes('-o') && s.argv.includes('0600'))).toBe(false);
  });

  it('keeps profiles on uninstall unless asked to purge them', () => {
    expect(uninstallSteps({ purgeProfiles: false }).map((s) => s.argv[0])).not.toContain('userdel');
    expect(uninstallSteps({ purgeProfiles: true }).at(-1)!.argv).toEqual(['userdel', '--remove', 'hexactra']);
  });
});

function makeBundle(dir: string): string {
  const root = join(dir, 'stage', BUNDLE_NAME);
  mkdirSync(join(root, 'bin'), { recursive: true });
  mkdirSync(join(root, 'extension'), { recursive: true });
  writeFileSync(join(root, 'bin', 'hexactra-agent'), '#!/bin/sh\n', { mode: 0o755 });
  writeFileSync(join(root, 'bin', 'hexactra-native-host'), '#!/bin/sh\n', { mode: 0o755 });
  writeFileSync(join(root, 'extension', 'manifest.json'), '{}');
  const sha = (f: string) => createHash('sha256').update(readFileSync(join(root, f))).digest('hex');
  const files = Object.fromEntries(['bin/hexactra-agent', 'bin/hexactra-native-host', 'extension/manifest.json'].map((f) => [f, sha(f)]));
  writeFileSync(join(root, 'BUNDLE.json'), JSON.stringify({ name: BUNDLE_NAME, version: '0.3.0', commit: 'abcdef1234567890', files }));
  const archive = join(dir, `${BUNDLE_NAME}.tar.gz`);
  execFileSync('tar', ['-czf', archive, '-C', join(dir, 'stage'), BUNDLE_NAME]);
  writeFileSync(`${archive}.sha256`, `${createHash('sha256').update(readFileSync(archive)).digest('hex')}  x\n`);
  return archive;
}

function harness(o: { userExists?: boolean } = {}) {
  const root = mkdtempSync(join(tmpdir(), 'hx-node-'));
  const layout = layoutIn(root);
  mkdirSync(layout.x11Dir, { recursive: true });
  const base = agentPaths({ XDG_DATA_HOME: join(root, 'home/data'), XDG_CONFIG_HOME: join(root, 'home/config') }, join(root, 'home'));
  const paths = { ...base, googleChrome: join(root, 'opt/google/chrome/chrome'), chromePolicyFile: join(root, 'etc/opt/chrome/policies/managed/hexactra.json'), osRelease: join(root, 'os-release') };
  writeFileSync(paths.osRelease, 'ID=ubuntu\nPRETTY_NAME="Ubuntu 24.04"\n');
  mkdirSync(dirname(paths.googleChrome), { recursive: true });
  writeFileSync(paths.googleChrome, '');
  mkdirSync(dirname(paths.chromePolicyFile), { recursive: true });
  writeFileSync(paths.chromePolicyFile, policyText());
  const exec: string[][] = [];
  const logs: string[] = [];
  const credentialsSeen: string[] = [];
  const run = (argv: string[]): ExecResult => {
    exec.push(argv);
    if (argv[0] === paths.googleChrome) return { code: 0, stdout: 'Google Chrome 142.0.0.0\n', stderr: '' };
    if (argv[0] === 'id') return { code: o.userExists ? 0 : 1, stdout: '', stderr: '' };
    if (argv[0] === 'systemctl' && argv[1] === 'is-active') return { code: 0, stdout: 'active\n', stderr: '' };
    if (argv[0] === 'sudo' && argv[2] === 'install' && argv.includes('0600')) {
      const src = argv.at(-2)!;
      credentialsSeen.push(readFileSync(src, 'utf8'));
      const dest = join(root, 'credential-copy.json');
      copyFileSync(src, dest);
    }
    return { code: 0, stdout: '', stderr: '' };
  };
  const d: AgentDeps = {
    paths,
    fetch: async (url) => {
      throw new Error(`unexpected download ${url}`);
    },
    postJson: async () => ({ ok: true, status: 200, json: async () => ({ host_id: HOST_ID, host_token: HOST_TOKEN }) }),
    api: () => ({
      get: async <T,>() => [{ id: HOST_ID, name: 'mini-pc', online: true, browserConnected: true }] as T,
      post: async <T,>() => ({ enrollmentToken: 'hxe_once', agentUrl: 'https://console.example.test/fabric' }) as T,
      delete: async () => undefined,
    }),
    exec: run,
    log: (l) => logs.push(l),
    sleep: async () => {},
    hostname: () => 'mini-pc',
    platform: { os: 'linux', arch: 'x64' },
  };
  return { root, layout, paths, d, exec, logs, credentialsSeen };
}

describe('hexactra agent install --mode unattended', () => {
  it('asks sudo once, enrolls, hands the credential to the node user and records no secret', async () => {
    const h = harness();
    const s = await installUnattended(h.d, { bundle: makeBundle(join(h.root, 'b')), layout: h.layout });
    expect(s).toMatchObject({ hostId: HOST_ID, name: 'mini-pc', display: 90, resolution: '1920x1080', gpu: null });
    const sudo = h.exec.filter((a) => a[0] === 'sudo');
    expect(sudo.filter((a) => a[2] === 'true')).toHaveLength(1);
    expect(sudo.map((a) => a[2])).toEqual(expect.arrayContaining(['apt-get', 'useradd', 'install', 'cp', 'ln', 'systemctl']));
    expect(h.credentialsSeen).toHaveLength(1);
    expect(JSON.parse(h.credentialsSeen[0]!)).toEqual({ host_id: HOST_ID, host_token: HOST_TOKEN });
    // The owner keeps no copy of the node's credential; the temp file is gone.
    expect(existsSync(h.paths.credential)).toBe(false);
    const everywhere = [readFileSync(join(h.paths.agentDir, 'unattended.json'), 'utf8'), ...h.logs, ...h.exec.flat()].join('\n');
    expect(everywhere).not.toContain(HOST_TOKEN);
    expect(readUnattended(h.paths.agentDir)?.hostId).toBe(HOST_ID);
    expect(h.logs.join('\n')).toMatch(/software, which sites can detect more easily/);

    // A re-run keeps the host and does not hand over a credential again.
    h.exec.length = 0;
    await installUnattended(h.d, { bundle: makeBundle(join(h.root, 'b2')), layout: h.layout });
    expect(h.credentialsSeen).toHaveLength(1);

    const checks = await agentDoctor(h.d);
    expect(checks.find((c) => c.name === 'hexactra-desktop')).toMatchObject({ ok: true });
    expect(checks.find((c) => c.name === 'graphics')).toMatchObject({ ok: true, warning: true });
  });

  it('controls and removes the node with sudo, keeping profiles by default', async () => {
    const h = harness({ userExists: true });
    await installUnattended(h.d, { bundle: makeBundle(join(h.root, 'b')), layout: h.layout });
    // `agent update` activates the bundle locally first; here it is the one the node runs.
    mkdirSync(dirname(h.paths.current), { recursive: true });
    symlinkSync(join(h.root, 'bundles', readUnattended(h.paths.agentDir)!.bundle), h.paths.current);
    h.exec.length = 0;
    unattendedControl(h.d, 'restart');
    expect(h.exec.find((a) => a[2] === 'systemctl')).toEqual(['sudo', '-n', 'systemctl', 'restart', UNITS.display, UNITS.session, UNITS.agent]);
    await uninstallUnattended(h.d, { layout: h.layout });
    expect(h.exec.some((a) => a.includes('userdel'))).toBe(false);
    expect(readUnattended(h.paths.agentDir)).toBeNull();
  });

  it('refuses a malformed resolution', async () => {
    const h = harness();
    await expect(installUnattended(h.d, { resolution: 'big', layout: h.layout })).rejects.toThrow(/1920x1080/);
  });
});

describe('hexactra agent install --mode attended (#341)', () => {
  const withEnv = async <T,>(env: Record<string, string | undefined>, fn: () => Promise<T>): Promise<T> => {
    const saved = Object.fromEntries(Object.keys(env).map((k) => [k, process.env[k]]));
    for (const [k, v] of Object.entries(env)) v === undefined ? delete process.env[k] : (process.env[k] = v);
    try {
      return await fn();
    } finally {
      for (const [k, v] of Object.entries(saved)) v === undefined ? delete process.env[k] : (process.env[k] = v);
    }
  };

  it('drives your own Chrome: attach mode, desktop shared on demand, its own name next to an unattended node', async () => {
    const h = harness();
    await installUnattended(h.d, { bundle: makeBundle(join(h.root, 'b')), layout: h.layout });
    // `agent update` activates the bundle locally first; here it is the one the node runs.
    mkdirSync(dirname(h.paths.current), { recursive: true });
    symlinkSync(join(h.root, 'bundles', readUnattended(h.paths.agentDir)!.bundle), h.paths.current);
    h.exec.length = 0;
    const s = await withEnv({ DISPLAY: ':0', XDG_SESSION_TYPE: 'x11', WAYLAND_DISPLAY: undefined }, () =>
      installAgent(h.d, { bundle: makeBundle(join(h.root, 'b2')), attended: true }),
    );
    expect(s).toMatchObject({ attended: true, name: 'mini-pc-attended', browserKind: 'google-chrome' });
    const unit = readFileSync(h.paths.unit, 'utf8');
    expect(unit).toContain('Environment="HEXACTRA_HOST_MODE=attended"');
    expect(unit).toContain('Environment="HEXACTRA_DESKTOP_VNC=x11vnc"');
    expect(unit).not.toContain('HEXACTRA_BROWSER');
    expect(unit).toContain('WantedBy=graphical-session.target');
    expect(h.exec).toContainEqual(['systemctl', '--user', 'import-environment', 'DISPLAY', 'XAUTHORITY']);
    expect(readFileSync(join(dirname(dirname(h.paths.unitDir)), 'autostart', 'hexactra-session.desktop'), 'utf8')).toContain('Exec=systemctl --user import-environment DISPLAY XAUTHORITY');
    // The native host is registered for your own Chrome.
    expect(existsSync(join(h.paths.chromeNativeHostDir, 'com.hexactra.nativehost.json'))).toBe(true);
  });

  it('refuses a Wayland session and says how to switch', async () => {
    const h = harness();
    await expect(withEnv({ XDG_SESSION_TYPE: 'wayland', DISPLAY: ':0' }, () => installAgent(h.d, { bundle: makeBundle(join(h.root, 'b')), attended: true }))).rejects.toThrow(/Ubuntu on Xorg[\s\S]*WaylandEnable=false/);
    expect(h.exec.some((a) => a[0] === 'sudo')).toBe(false);
  });

  it('installs x11vnc and the notice tool only when missing', async () => {
    const h = harness();
    const exec = h.d.exec;
    h.d.exec = (argv, o) => (argv[0] === 'dpkg' ? { code: argv[2] === 'x11vnc' ? 1 : 0, stdout: '', stderr: '' } : exec(argv, o));
    await withEnv({ DISPLAY: ':0', XDG_SESSION_TYPE: 'x11' }, () => installAgent(h.d, { bundle: makeBundle(join(h.root, 'b')), attended: true }));
    expect(h.exec).toContainEqual(['sudo', '-n', 'apt-get', 'install', '-y', '--no-install-recommends', 'x11vnc']);
  });

  it('tells X11 from Wayland', () => {
    const d = { exec: (): ExecResult => ({ code: 0, stdout: 'wayland\n', stderr: '' }) };
    expect(sessionKind(d, { XDG_SESSION_TYPE: 'x11', DISPLAY: ':0' })).toBe('x11');
    expect(sessionKind(d, { XDG_SESSION_TYPE: 'wayland', DISPLAY: ':0' })).toBe('wayland');
    expect(sessionKind(d, { XDG_SESSION_ID: '3' })).toBe('wayland');
    expect(sessionKind(d, { WAYLAND_DISPLAY: 'wayland-0' })).toBe('wayland');
    expect(sessionKind({ exec: () => ({ code: 1, stdout: '', stderr: '' }) }, {})).toBe('none');
  });
});

describe('the desktop tools the agent drives the whole screen with (#373)', () => {
  const APT = ['apt-get', 'install', '-y', '--no-install-recommends'];
  /** dpkg reports `missing` as not installed. */
  const missing = (h: ReturnType<typeof harness>, names: readonly string[]) => {
    const exec = h.d.exec;
    h.d.exec = (argv, o) => (argv[0] === 'dpkg' ? { code: names.includes(argv[2]!) ? 1 : 0, stdout: '', stderr: '' } : exec(argv, o));
  };
  const aptCalls = (h: ReturnType<typeof harness>) => h.exec.filter((a) => a[0] === 'sudo' && a[2] === 'apt-get');

  it('are part of every node install', () => {
    expect(DESKTOP_INPUT_PACKAGES).toEqual(['xdotool', 'imagemagick']);
    expect(APT_PACKAGES).toEqual(expect.arrayContaining(['xdotool', 'imagemagick']));
    expect(ATTENDED_PACKAGES).toEqual(expect.arrayContaining(['x11vnc', 'libnotify-bin', 'xdotool', 'imagemagick']));
  });

  it('unattended: installed with the desktop packages, in the one sudo step', async () => {
    const h = harness();
    await installUnattended(h.d, { bundle: makeBundle(join(h.root, 'b')), layout: h.layout });
    const apt = aptCalls(h);
    expect(apt).toHaveLength(1);
    expect(apt[0]).toEqual(expect.arrayContaining(['xdotool', 'imagemagick', 'xfce4']));
  });

  it('attended: only the missing ones are installed', async () => {
    const h = harness();
    missing(h, ['xdotool', 'imagemagick']);
    h.d.env = { DISPLAY: ':0', XDG_SESSION_TYPE: 'x11' };
    const saved = { DISPLAY: process.env.DISPLAY, XDG_SESSION_TYPE: process.env.XDG_SESSION_TYPE };
    Object.assign(process.env, { DISPLAY: ':0', XDG_SESSION_TYPE: 'x11' });
    try {
      await installAgent(h.d, { bundle: makeBundle(join(h.root, 'b')), attended: true });
    } finally {
      for (const [k, v] of Object.entries(saved)) v === undefined ? delete process.env[k] : (process.env[k] = v);
    }
    expect(aptCalls(h)).toEqual([['sudo', '-n', ...APT, 'xdotool', 'imagemagick']]);
  });

  it('default mode in an X11 session: installs the missing ones', async () => {
    const h = harness();
    missing(h, ['imagemagick']);
    h.d.env = { DISPLAY: ':0', XDG_SESSION_TYPE: 'x11' };
    await installAgent(h.d, { bundle: makeBundle(join(h.root, 'b')), browser: '/usr/bin/true', service: false });
    expect(aptCalls(h)).toEqual([['sudo', '-n', ...APT, 'imagemagick']]);
  });

  it('default mode without a desktop (a server, CI, --no-desktop): skips them, says why, and never asks for sudo', async () => {
    for (const [env, noDesktop] of [[{}, false], [{ DISPLAY: ':0', XDG_SESSION_TYPE: 'x11' }, true]] as const) {
      const h = harness();
      missing(h, ['xdotool', 'imagemagick']);
      h.d.env = env;
      await installAgent(h.d, { bundle: makeBundle(join(h.root, 'b')), browser: '/usr/bin/true', service: false, noDesktop });
      expect(h.exec.some((a) => a[0] === 'sudo')).toBe(false);
      expect(h.logs.join('\n')).toMatch(/skipping the desktop tools \(xdotool, imagemagick\)/);
    }
  });

  it('agent update installs them on an unattended node installed before #373, even with the same agent', async () => {
    const h = harness();
    await installUnattended(h.d, { bundle: makeBundle(join(h.root, 'b')), layout: h.layout });
    // `agent update` activates the bundle locally first; here it is the one the node runs.
    mkdirSync(dirname(h.paths.current), { recursive: true });
    symlinkSync(join(h.root, 'bundles', readUnattended(h.paths.agentDir)!.bundle), h.paths.current);
    h.exec.length = 0;
    updateUnattended(h.d, true, h.layout);
    expect(aptCalls(h)).toEqual([]); // nothing missing, same agent: nothing to do
    missing(h, ['xdotool']);
    updateUnattended(h.d, true, h.layout);
    expect(aptCalls(h)).toEqual([['sudo', '-n', ...APT, 'xdotool']]);
    expect(h.exec).toContainEqual(['sudo', '-n', 'systemctl', 'restart', UNITS.agent]);
    expect(h.exec.some((a) => a[2] === 'cp')).toBe(false);
  });

  it('doctor reports them and how to fix them', async () => {
    const h = harness();
    await installUnattended(h.d, { bundle: makeBundle(join(h.root, 'b')), layout: h.layout });
    expect((await agentDoctor(h.d)).find((c) => c.name === 'desktop-input')).toMatchObject({ ok: true });
    missing(h, ['xdotool']);
    expect((await agentDoctor(h.d)).find((c) => c.name === 'desktop-input')).toMatchObject({ ok: false, detail: expect.stringContaining('hexactra agent update') });
  });
});
