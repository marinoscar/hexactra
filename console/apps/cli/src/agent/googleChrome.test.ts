// Google Chrome on a node (#337): the exact policy, the shared extension id,
// one sudo prompt for the root steps, nothing root on a re-run, and a clear
// list of commands when there is no terminal to ask for a password.
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { agentDoctor, installAgent, type AgentDeps, type ExecResult } from './agent.js';
import { BUNDLE_NAME } from './bundle.js';
import {
  chromeSetup,
  chromeStatus,
  chromeTeardown,
  EXTENSION_ID,
  nativeHostFile,
  nativeHostManifest,
  osInfo,
  policyText,
  type ChromeDeps,
} from './googleChrome.js';
import { agentPaths, type AgentPaths } from './paths.js';

/** A tiny real bundle, as scripts/package-agent-bundle.mjs makes one (see agent.test.ts). */
function makeBundle(dir: string): string {
  const root = join(dir, 'stage', BUNDLE_NAME);
  mkdirSync(join(root, 'bin'), { recursive: true });
  mkdirSync(join(root, 'extension'), { recursive: true });
  writeFileSync(join(root, 'bin', 'hexactra-agent'), '#!/bin/sh\n', { mode: 0o755 });
  writeFileSync(join(root, 'bin', 'hexactra-native-host'), '#!/bin/sh\n', { mode: 0o755 });
  writeFileSync(join(root, 'extension', 'manifest.json'), '{"manifest_version":3}');
  const sha = (f: string) => createHash('sha256').update(readFileSync(join(root, f))).digest('hex');
  const files = Object.fromEntries(['bin/hexactra-agent', 'bin/hexactra-native-host', 'extension/manifest.json'].map((f) => [f, sha(f)]));
  writeFileSync(join(root, 'BUNDLE.json'), JSON.stringify({ name: BUNDLE_NAME, version: '0.1.0', commit: 'abcdef1234567890', files }));
  const archive = join(dir, `${BUNDLE_NAME}.tar.gz`);
  execFileSync('tar', ['-czf', archive, '-C', join(dir, 'stage'), BUNDLE_NAME]);
  writeFileSync(`${archive}.sha256`, `${createHash('sha256').update(readFileSync(archive)).digest('hex')}  x\n`);
  return archive;
}

const UBUNTU = 'PRETTY_NAME="Ubuntu 24.04.1 LTS"\nID=ubuntu\nID_LIKE=debian\n';
const repo = (...p: string[]) => join(__dirname, '..', '..', '..', '..', '..', ...p);

function harness(o: { os?: string; sudo?: boolean; chromeInstalled?: boolean } = {}) {
  const home = mkdtempSync(join(tmpdir(), 'hx-chrome-'));
  const base = agentPaths({ XDG_DATA_HOME: join(home, 'data'), XDG_CONFIG_HOME: join(home, 'config') }, home);
  const paths: AgentPaths = {
    ...base,
    googleChrome: join(home, 'opt', 'google', 'chrome', 'chrome'),
    chromePolicyFile: join(home, 'etc', 'opt', 'chrome', 'policies', 'managed', 'hexactra.json'),
    osRelease: join(home, 'os-release'),
  };
  writeFileSync(paths.osRelease, o.os ?? UBUNTU);
  const install = (p: string) => {
    mkdirSync(dirname(p), { recursive: true });
    writeFileSync(p, '#!/bin/sh\n');
  };
  if (o.chromeInstalled) install(paths.googleChrome);
  const exec: string[][] = [];
  const logs: string[] = [];
  const downloads: string[] = [];
  const run = (argv: string[]): ExecResult => {
    exec.push(argv);
    if (argv[0] === paths.googleChrome) return { code: 0, stdout: 'Google Chrome 142.0.7444.59 \n', stderr: '' };
    if (argv[0] !== 'sudo') return { code: 0, stdout: '', stderr: '' };
    if (o.sudo === false) return { code: 1, stdout: '', stderr: 'sudo: a password is required' };
    const [, , cmd, ...rest] = argv; // sudo -n <cmd> …
    if (cmd === 'apt-get') install(paths.googleChrome);
    if (cmd === 'install') {
      const [src, dest] = rest.slice(-2) as [string, string];
      mkdirSync(dirname(dest), { recursive: true });
      copyFileSync(src, dest);
    }
    return { code: 0, stdout: '', stderr: '' };
  };
  const d: ChromeDeps = {
    paths,
    exec: run,
    log: (l) => logs.push(l),
    fetch: async (url) => {
      downloads.push(url);
      return { ok: true, status: 200, arrayBuffer: async () => new Uint8Array([1, 2, 3]).buffer };
    },
  };
  return { home, paths, d, exec, logs, downloads };
}

describe('the Chrome policy and the native host', () => {
  it('force-installs, pins and updates the extension from our update manifest, and nothing else', () => {
    expect(JSON.parse(policyText())).toEqual({
      ExtensionSettings: {
        ahpjoclfeibdmlnbaednepiihpamklcl: {
          installation_mode: 'force_installed',
          update_url: 'https://github.com/marinoscar/hexactra/releases/download/agent-latest/updates.xml',
          override_update_url: true,
          toolbar_pin: 'force_pinned',
        },
      },
    });
    expect(JSON.parse(policyText('http://127.0.0.1:8099/updates.xml')).ExtensionSettings[EXTENSION_ID].update_url).toBe('http://127.0.0.1:8099/updates.xml');
  });

  it('allows only the Hexactra extension, the same id as the manifest key and the Rust native host', () => {
    expect(nativeHostManifest('/x/hexactra-native-host')).toEqual({
      name: 'com.hexactra.nativehost',
      description: 'Hexactra remote control bridge',
      path: '/x/hexactra-native-host',
      type: 'stdio',
      allowed_origins: [`chrome-extension://${EXTENSION_ID}/`],
    });
    const key = (JSON.parse(readFileSync(repo('apps', 'chrome-extension', 'manifest', 'manifest.json'), 'utf8')) as { key: string }).key;
    const hex = createHash('sha256').update(Buffer.from(key, 'base64')).digest('hex').slice(0, 32);
    expect([...hex].map((c) => String.fromCharCode(97 + parseInt(c, 16))).join('')).toBe(EXTENSION_ID);
    expect(readFileSync(repo('crates', 'hexactra-core', 'src', 'bridge.rs'), 'utf8')).toContain(`EXTENSION_ID: &str = "${EXTENSION_ID}"`);
  });

  it('supports Debian and Ubuntu families only', () => {
    expect(osInfo(UBUNTU)).toMatchObject({ id: 'ubuntu', supported: true });
    expect(osInfo('ID=debian\nPRETTY_NAME="Debian GNU/Linux 12"\n').supported).toBe(true);
    expect(osInfo('ID=linuxmint\nID_LIKE="ubuntu debian"\n').supported).toBe(true);
    expect(osInfo('ID=fedora\n').supported).toBe(false);
    expect(osInfo(null).supported).toBe(false);
  });
});

describe('hexactra agent chrome setup', () => {
  it('installs Chrome and the policy with one sudo, registers the native host, and needs no sudo on a re-run', async () => {
    const { d, paths, exec, downloads, logs } = harness();
    const s = await chromeSetup(d, { interactive: true });
    expect(downloads).toEqual(['https://dl.google.com/linux/direct/google-chrome-stable_current_amd64.deb']);
    const sudo = exec.filter((a) => a[0] === 'sudo').map((a) => a.slice(0, 3).join(' '));
    expect(sudo).toEqual(['sudo -n true', 'sudo -n apt-get', 'sudo -n install']);
    expect(exec.find((a) => a[2] === 'install')).toEqual(expect.arrayContaining(['-m', '0644', '-o', 'root', '-g', 'root', paths.chromePolicyFile]));
    expect(readFileSync(paths.chromePolicyFile, 'utf8')).toBe(policyText());
    expect(JSON.parse(readFileSync(nativeHostFile(paths), 'utf8')).path).toBe(join(paths.current, 'bin', 'hexactra-native-host'));
    expect(s).toMatchObject({ chrome: { installed: true, version: '142.0.7444.59' }, policy: { current: true }, nativeHost: { current: true } });
    expect(logs.join('\n')).toMatch(/Managed by your organization/);

    exec.length = 0;
    await chromeSetup(d, { interactive: true });
    expect(exec.filter((a) => a[0] === 'sudo')).toEqual([]);
  });

  it('keeps an installed Chrome and only fixes an out-of-date policy', async () => {
    const { d, paths, exec, downloads } = harness({ chromeInstalled: true });
    mkdirSync(dirname(paths.chromePolicyFile), { recursive: true });
    writeFileSync(paths.chromePolicyFile, '{}');
    expect(chromeStatus(d).policy).toMatchObject({ present: true, current: false });
    await chromeSetup(d, { interactive: false, updateUrl: 'http://127.0.0.1:8099/updates.xml' });
    expect(downloads).toEqual([]);
    expect(exec.filter((a) => a[0] === 'sudo').map((a) => a[2])).toEqual(['true', 'install']);
    expect(chromeStatus(d).policy.updateUrl).toBe('http://127.0.0.1:8099/updates.xml');
  });

  it('without a terminal and no cached sudo, lists the exact commands and changes nothing that needs root', async () => {
    const { d, paths, exec } = harness({ sudo: false, chromeInstalled: true });
    await expect(chromeSetup(d, { interactive: false })).rejects.toThrow(/Run `hexactra agent chrome setup` in a terminal, or run:\n {2}sudo install -D -m 0644 -o root -g root .*hexactra\.json/);
    expect(existsSync(paths.chromePolicyFile)).toBe(false);
    expect(exec.filter((a) => a[0] === 'sudo').map((a) => a.slice(0, 3).join(' '))).toEqual(['sudo -n true']);
  });

  it('refuses a system Google does not ship Chrome for as a .deb', async () => {
    const { d } = harness({ os: 'ID=fedora\nPRETTY_NAME="Fedora Linux 41"\n' });
    await expect(chromeSetup(d, { interactive: true })).rejects.toThrow(/Debian or Ubuntu .*Fedora Linux 41/);
  });

  it('uninstall removes the policy and the native host, never Chrome', async () => {
    const { d, paths, exec } = harness();
    await chromeSetup(d, { interactive: true });
    exec.length = 0;
    chromeTeardown(d, true);
    expect(existsSync(nativeHostFile(paths))).toBe(false);
    expect(exec.filter((a) => a[0] === 'sudo').map((a) => a.slice(2).join(' '))).toEqual(['true', `rm -f ${paths.chromePolicyFile}`]);
    expect(exec.some((a) => a.includes('apt-get') && a.includes('remove'))).toBe(false);
    expect(existsSync(paths.googleChrome)).toBe(true);
  });
});

describe('install with --google-chrome and the doctor', () => {
  function agentHarness() {
    const h = harness({ chromeInstalled: true });
    const d: AgentDeps = {
      ...h.d,
      postJson: async () => ({ ok: true, status: 200, json: async () => ({ host_id: '33333333-3333-4333-8333-333333333333', host_token: 'hxh_x' }) }),
      api: () => ({
        get: async <T,>() => [{ id: '33333333-3333-4333-8333-333333333333', name: 'mini-pc', online: true, browserConnected: true }] as T,
        post: async <T,>() => ({ enrollmentToken: 'hxe_once', agentUrl: 'https://console.example.test/fabric' }) as T,
        delete: async () => undefined,
      }),
      exec: (argv, opts) => {
        if (argv.includes('show')) return { code: 0, stdout: 'ActiveState=active\nSubState=running\n', stderr: '' };
        return h.d.exec(argv, opts);
      },
      sleep: async () => {},
      hostname: () => 'mini-pc',
      platform: { os: 'linux', arch: 'x64' },
      fetch: h.d.fetch as AgentDeps['fetch'],
    };
    return { ...h, d };
  }

  it('doctor without an install says what to run', async () => {
    const { d } = agentHarness();
    const checks = await agentDoctor(d);
    expect(checks.find((c) => c.name === 'policy')).toMatchObject({ ok: false });
    expect(checks.find((c) => c.name === 'agent')).toMatchObject({ ok: false, detail: expect.stringMatching(/hexactra agent install/) });
  });

  it('installs with Google Chrome and the doctor then passes', async () => {
    const { d, paths, home } = agentHarness();
    const s = await installAgent(d, { bundle: makeBundle(join(home, 'b')), googleChrome: true, interactiveSudo: true });
    expect(s).toMatchObject({ browserKind: 'google-chrome', browser: paths.googleChrome, chromeVersion: '142.0.7444.59' });
    const checks = await agentDoctor(d);
    expect(checks.filter((c) => !c.ok)).toEqual([]);
  });
});
