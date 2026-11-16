// An unattended node (#340): the units serve the desktop on a private Unix
// socket only and carry no secret; the GPU is detected from the render nodes;
// the install asks for sudo once and hands the credential to the node user only.
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { agentDoctor, installUnattended, unattendedControl, uninstallUnattended, type AgentDeps, type ExecResult } from './agent.js';
import { BUNDLE_NAME } from './bundle.js';
import { policyText } from './googleChrome.js';
import { agentPaths } from './paths.js';
import {
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
