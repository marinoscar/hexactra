// `hexactra agent` (#327): the bundle is verified before anything is
// installed, Chrome for Testing's zip is unpacked safely, the systemd unit
// carries no secret, and install / re-install / uninstall run in order
// against fakes, with the host token only ever in the 0600 credential file.
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, readlinkSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { deflateRawSync } from 'node:zlib';

import { describe, expect, it } from 'vitest';

import { agentStatus, ensureSandbox, installAgent, uninstallAgent, updateAgent, updateTargets, type AgentDeps, type ExecResult } from './agent.js';
import { readUnattended } from './unattended.js';
import { BUNDLE_NAME, bundleSource, fetchBundle } from './bundle.js';
import { needsSetuidSandbox } from './chrome.js';
import { agentPaths } from './paths.js';
import { unitFile } from './service.js';
import { unzipTo } from './unzip.js';

const HOST_TOKEN = 'hxh_secret_host_token_0123456789';
const HOST_ID = '22222222-2222-4222-8222-222222222222';
const sha = (b: Buffer) => createHash('sha256').update(b).digest('hex');

/** A real (tiny) bundle archive, made the way scripts/package-agent-bundle.mjs makes one. */
function makeBundle(dir: string, version = '0.1.0', commit = 'abcdef1234567890'): string {
  const root = join(dir, 'stage', BUNDLE_NAME);
  mkdirSync(join(root, 'bin'), { recursive: true });
  mkdirSync(join(root, 'extension'), { recursive: true });
  writeFileSync(join(root, 'bin', 'hexactra-agent'), '#!/bin/sh\necho agent\n', { mode: 0o755 });
  writeFileSync(join(root, 'bin', 'hexactra-native-host'), '#!/bin/sh\n', { mode: 0o755 });
  writeFileSync(join(root, 'extension', 'manifest.json'), '{"manifest_version":3,"key":"k"}');
  const files: Record<string, string> = {};
  for (const f of ['bin/hexactra-agent', 'bin/hexactra-native-host', 'extension/manifest.json']) files[f] = sha(readFileSync(join(root, f)));
  writeFileSync(join(root, 'BUNDLE.json'), JSON.stringify({ name: BUNDLE_NAME, version, commit, files }));
  const archive = join(dir, `${BUNDLE_NAME}-${commit.slice(0, 4)}.tar.gz`);
  execFileSync('tar', ['-czf', archive, '-C', join(dir, 'stage'), BUNDLE_NAME]);
  writeFileSync(`${archive}.sha256`, `${sha(readFileSync(archive))}  ${BUNDLE_NAME}.tar.gz\n`);
  execFileSync('rm', ['-rf', join(dir, 'stage')]);
  return archive;
}

/** A zip with the given entries (deflated), for unzipTo. */
function makeZip(entries: { name: string; data?: string; mode?: number }[]): Buffer {
  const locals: Buffer[] = [];
  const centrals: Buffer[] = [];
  let offset = 0;
  for (const e of entries) {
    const name = Buffer.from(e.name);
    const raw = Buffer.from(e.data ?? '');
    const comp = e.name.endsWith('/') ? Buffer.alloc(0) : deflateRawSync(raw);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(8, 8);
    local.writeUInt32LE(comp.length, 18);
    local.writeUInt32LE(raw.length, 22);
    local.writeUInt16LE(name.length, 26);
    locals.push(local, name, comp);
    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(8, 10);
    central.writeUInt32LE(comp.length, 20);
    central.writeUInt32LE(raw.length, 24);
    central.writeUInt16LE(name.length, 28);
    central.writeUInt32LE(((e.mode ?? 0o100644) << 16) >>> 0, 38);
    central.writeUInt32LE(offset, 42);
    centrals.push(central, name);
    offset += 30 + name.length + comp.length;
  }
  const cd = Buffer.concat(centrals);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(entries.length, 8);
  eocd.writeUInt16LE(entries.length, 10);
  eocd.writeUInt32LE(cd.length, 12);
  eocd.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, cd, eocd]);
}

function harness(opts: { online?: boolean; showEnv?: string } = {}) {
  const home = mkdtempSync(join(tmpdir(), 'hx-agent-'));
  const paths = agentPaths({ XDG_DATA_HOME: join(home, 'data'), XDG_CONFIG_HOME: join(home, 'config') }, home);
  const exec: string[][] = [];
  const logs: string[] = [];
  const api = { posts: [] as [string, unknown][], deletes: [] as string[] };
  const d: AgentDeps = {
    paths,
    fetch: async (url) => {
      throw new Error(`unexpected download ${url}`);
    },
    postJson: async (url, body) => {
      api.posts.push([url, body]);
      return { ok: true, status: 200, json: async () => ({ host_id: HOST_ID, host_token: HOST_TOKEN }) };
    },
    api: () => ({
      get: async <T,>() => [{ id: HOST_ID, name: 'mini-pc', online: opts.online ?? true, browserConnected: false }] as T,
      post: async <T,>(path: string, body?: unknown) => {
        api.posts.push([path, body]);
        return { enrollmentToken: 'hxe_once', agentUrl: 'https://console.example.test/fabric' } as T;
      },
      delete: async (path: string) => {
        api.deletes.push(path);
      },
    }),
    exec: (argv): ExecResult => {
      exec.push(argv);
      if (argv.includes('show-environment')) return { code: 0, stdout: opts.showEnv ?? 'DISPLAY=:0\n', stderr: '' };
      if (argv.includes('show')) return { code: 0, stdout: 'ActiveState=active\nSubState=running\n', stderr: '' };
      return { code: 0, stdout: '', stderr: '' };
    },
    log: (l) => logs.push(l),
    sleep: async () => {},
    hostname: () => 'mini-pc',
    platform: { os: 'linux', arch: 'x64' },
  };
  return { home, paths, d, exec, logs, api };
}

describe('the agent bundle', () => {
  it('installs a verified bundle and refuses a tampered one', async () => {
    const { home, paths, d } = harness();
    const good = makeBundle(home);
    const b = await fetchBundle(paths, { bundle: good }, d.fetch, () => {});
    expect(b).toMatchObject({ version: '0.1.0', commit: 'abcdef1234567890' });
    expect(existsSync(join(b.dir, 'bin', 'hexactra-agent'))).toBe(true);

    const bad = makeBundle(home, '0.1.0', 'ffff000011112222');
    writeFileSync(`${bad}.sha256`, `${'0'.repeat(64)}  x\n`);
    await expect(fetchBundle(paths, { bundle: bad }, d.fetch, () => {})).rejects.toThrow(/checksum mismatch/);
  });

  it('downloads the latest release by default, or a pinned version', () => {
    expect(bundleSource({}).archive).toBe('https://github.com/marinoscar/hexactra/releases/download/agent-latest/hexactra-agent-linux-x86_64.tar.gz');
    expect(bundleSource({ version: 'v0.2.0' }).checksum).toMatch(/agent-v0\.2\.0\/hexactra-agent-linux-x86_64\.tar\.gz\.sha256$/);
  });
});

describe('unzipTo (Chrome for Testing)', () => {
  it('keeps executable modes and refuses entries outside the destination', () => {
    const dest = mkdtempSync(join(tmpdir(), 'hx-zip-'));
    unzipTo(makeZip([{ name: 'chrome-linux64/' }, { name: 'chrome-linux64/chrome', data: 'bin', mode: 0o100755 }]), dest);
    expect(readFileSync(join(dest, 'chrome-linux64/chrome'), 'utf8')).toBe('bin');
    expect(statSync(join(dest, 'chrome-linux64/chrome')).mode & 0o777).toBe(0o755);
    expect(() => unzipTo(makeZip([{ name: '../escape', data: 'x' }]), dest)).toThrow(/escapes/);
  });
});

describe('the systemd unit', () => {
  it('runs the active bundle in the desktop session, with no secret and no NoNewPrivileges', () => {
    const { paths } = harness();
    const unit = unitFile(paths, { name: 'mini pc', agentUrl: 'https://console.example.test/fabric', browser: '/opt/chrome', maxBrowsers: 2, sandboxHelper: '/opt/chrome_sandbox' });
    expect(unit).toContain(`ExecStart="${paths.current}/bin/hexactra-agent" daemon`);
    expect(unit).toContain('Environment="HEXACTRA_URL=https://console.example.test/fabric"');
    expect(unit).toContain('Environment="HEXACTRA_HOST_NAME=mini pc"');
    expect(unit).toContain('Environment="CHROME_DEVEL_SANDBOX=/opt/chrome_sandbox"');
    expect(unit).toContain('WantedBy=graphical-session.target');
    expect(unit).not.toMatch(/NoNewPrivileges|TOKEN|hx[hes]_/);
  });
});

describe('install, re-install and uninstall', () => {
  it('enrolls through the console, keeps the token in a 0600 file only, starts the service and waits for Fleet', async () => {
    const { home, paths, d, exec, logs, api } = harness();
    const s = await installAgent(d, { bundle: makeBundle(home), browser: '/usr/bin/chromium', maxBrowsers: 2 });

    expect(api.posts[0]).toEqual(['/fleet/enrollments', { name: 'mini-pc' }]);
    expect(api.posts[1]).toEqual(['https://console.example.test/fabric/v1/hosts/enroll', { enrollment_token: 'hxe_once', name: 'mini-pc', version: 'hexactra-cli' }]);
    expect(JSON.parse(readFileSync(paths.credential, 'utf8'))).toEqual({ host_id: HOST_ID, host_token: HOST_TOKEN });
    expect(statSync(paths.credential).mode & 0o777).toBe(0o600);
    expect(s).toMatchObject({ hostId: HOST_ID, name: 'mini-pc', agentUrl: 'https://console.example.test/fabric', browserKind: 'custom', maxBrowsers: 2, service: true });
    expect(readlinkSync(paths.current)).toContain('0.1.0-abcdef1');

    expect(exec.map((a) => a.slice(2).join(' '))).toEqual(['show-environment', 'daemon-reload', 'enable hexactra-agent.service', 'restart hexactra-agent.service', 'show-environment']);
    const everywhere = [readFileSync(paths.unit, 'utf8'), readFileSync(paths.state, 'utf8'), ...logs, ...exec.flat()].join('\n');
    expect(everywhere).not.toContain(HOST_TOKEN);
    expect(everywhere).not.toContain('hxe_once');
    expect(logs).toContain('The host is online in Fleet');

    // Re-running keeps the same host: no second enrollment.
    api.posts.length = 0;
    await installAgent(d, { bundle: makeBundle(home, '0.1.0', '1234567abcdef') });
    expect(api.posts).toEqual([]);
    expect(readlinkSync(paths.current)).toContain('0.1.0-1234567');

    const st = await agentStatus(d);
    expect(st).toMatchObject({ installed: true, service: { active: 'active', sub: 'running' }, fleet: { id: HOST_ID, online: true } });

    writeFileSync(join(paths.root, 'marker'), '');
    mkdirSync(paths.profilesDir, { recursive: true });
    await uninstallAgent(d, {});
    expect(exec.some((a) => a.join(' ') === 'systemctl --user disable --now hexactra-agent.service')).toBe(true);
    expect(api.deletes).toEqual([`/fleet/hosts/${HOST_ID}`]);
    expect(existsSync(paths.credential) || existsSync(paths.unit) || existsSync(paths.agentDir)).toBe(false);
    expect(existsSync(paths.profilesDir)).toBe(true);
  });

  it('keeps the unattended node\'s record when only the agent is uninstalled (#376)', async () => {
    const { home, paths, d } = harness();
    await installAgent(d, { bundle: makeBundle(home), browser: '/usr/bin/chromium' });
    const record = join(paths.agentDir, 'unattended.json');
    writeFileSync(record, JSON.stringify({ display: 90, resolution: '1920x1080' }));
    await uninstallAgent(d, {});
    expect(existsSync(paths.credential) || existsSync(paths.unit) || existsSync(paths.current) || existsSync(paths.state)).toBe(false);
    expect(readdirSync(paths.agentDir)).toEqual(['unattended.json']);
    expect(readUnattended(paths.agentDir)).toMatchObject({ display: 90 });
  });

  it('joins with an admin-minted token without the console login', async () => {
    const { home, paths, d, api, logs } = harness();
    const noLogin: AgentDeps = {
      ...d,
      api: () => {
        throw new Error('Not logged in. Run `hexactra login` first.');
      },
    };
    const s = await installAgent(noLogin, {
      bundle: makeBundle(home),
      browser: '/usr/bin/chromium',
      enrollmentToken: 'hxe_given',
      agentUrl: 'https://console.example.test/fabric/',
    });
    expect(api.posts).toEqual([['https://console.example.test/fabric/v1/hosts/enroll', { enrollment_token: 'hxe_given', name: 'mini-pc', version: 'hexactra-cli' }]]);
    expect(s.agentUrl).toBe('https://console.example.test/fabric');
    expect(readFileSync(paths.unit, 'utf8')).not.toContain('hxe_given');
    expect(logs.join('\n')).toMatch(/Fleet is not checked/);
    await expect(installAgent(noLogin, { bundle: makeBundle(home), browser: '/x', enrollmentToken: 'hxe_x' })).rejects.toThrow(/--agent-url/);
  });

  it('refuses another platform, and needs a user session for the service', async () => {
    const { d } = harness();
    await expect(installAgent({ ...d, platform: { os: 'darwin', arch: 'arm64' } }, {})).rejects.toThrow(/Linux x86_64/);
    await expect(installAgent({ ...d, exec: () => ({ code: 1, stdout: '', stderr: 'no bus' }) }, {})).rejects.toThrow(/--no-service/);
  });

  it('fails clearly when the host never comes online', async () => {
    const { home, d } = harness({ online: false });
    await expect(installAgent(d, { bundle: makeBundle(home), browser: '/usr/bin/chromium', waitSeconds: 0.01 })).rejects.toThrow(/did not come online/);
  });

  it('update swaps the bundle and restarts; the same build is a no-op', async () => {
    const { home, paths, d, exec } = harness();
    await installAgent(d, { bundle: makeBundle(home), browser: '/usr/bin/chromium' });
    exec.length = 0;
    await updateAgent(d, { bundle: makeBundle(home) });
    expect(exec.some((a) => a.includes('restart'))).toBe(false);
    await updateAgent(d, { bundle: makeBundle(home, '0.1.1', '9999999aaaaaaa') });
    expect(readlinkSync(paths.current)).toContain('0.1.1-9999999');
    expect(exec.some((a) => a.join(' ') === 'systemctl --user restart hexactra-agent.service')).toBe(true);
  });
});

describe('agent update with nothing recorded (#411)', () => {
  it('says there is nothing to update instead of exiting silently', () => {
    const { d } = harness();
    expect(() => updateTargets({ ...d, exec: () => ({ code: 3, stdout: 'inactive\n', stderr: '' }) })).toThrow(/No agent is installed for this user: nothing to update\. Run `hexactra agent install`/);
  });

  it('points to adopting an unattended node that runs without its record', () => {
    const { d } = harness();
    const exec: string[][] = [];
    const running: AgentDeps = { ...d, exec: (argv) => (exec.push(argv), { code: 0, stdout: 'active\n', stderr: '' }) };
    expect(() => updateTargets(running)).toThrow(/unattended node is running here \(hexactra-node-agent\.service\).*\n.*hexactra agent install --mode unattended/s);
    expect(exec).toEqual([['systemctl', 'is-active', 'hexactra-node-agent.service']]);
  });

  it('updates the attended agent when it is recorded', async () => {
    const { d, home } = harness();
    await installAgent(d, { bundle: makeBundle(home), browser: '/usr/bin/chromium' });
    expect(updateTargets(d)).toEqual({ attended: true, unattended: false });
  });
});

describe("Chrome's sandbox helper", () => {
  it('is needed where user namespaces are restricted', () => {
    expect(needsSetuidSandbox((p) => (p.endsWith('apparmor_restrict_unprivileged_userns') ? '1' : null))).toBe(true);
    expect(needsSetuidSandbox((p) => (p.endsWith('unprivileged_userns_clone') ? '0' : null))).toBe(true);
    expect(needsSetuidSandbox(() => null)).toBe(false);
  });

  it('uses sudo -n from the TUI and says to run `hexactra agent sandbox` when it needs a password', () => {
    const { d, exec } = harness();
    const failing: AgentDeps = { ...d, exec: (argv) => (exec.push(argv), { code: 1, stdout: '', stderr: 'a password is required' }) };
    expect(() => ensureSandbox(failing, '/tmp/no-such-helper', false)).toThrow(/hexactra agent sandbox/);
    expect(exec[0]).toEqual(['sudo', '-n', 'chown', 'root:root', '/tmp/no-such-helper']);
  });
});
