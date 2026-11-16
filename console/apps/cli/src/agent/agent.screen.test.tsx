// The Agent screen (#374): dashboard, doctor with dependencies, the sudo
// prompt, the install wizard and live logs, through the platform's TUI harness.
import { mkdirSync, mkdtempSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { createCli } from '@marinoscar/platform-cli';
import { resetCliForTests } from '@marinoscar/platform-cli/testing';
import { renderTuiScreen, stripAnsi, type TuiTestHandle } from '@marinoscar/platform-cli/tui/testing';
import { afterEach, describe, expect, it } from 'vitest';

import { APP_CLI_OPTIONS } from '../app.js';

import type { AgentDeps, ExecResult } from './agent.js';
import { AgentScreen } from './agent.screen.js';
import { agentPaths } from './paths.js';

// The frame names the CLI: give the screen the app's identity, as the TUI does.
resetCliForTests();
createCli(APP_CLI_OPTIONS);

const PASSWORD = 'correct horse';

interface Fake {
  deps: (log: (l: string) => void) => AgentDeps;
  exec: { argv: string[]; input?: string }[];
  state: { sudo: boolean; missing: Set<string>; journal: string };
  logs: string[];
}

function fake(o: { installed?: boolean } = {}): Fake {
  const home = mkdtempSync(join(tmpdir(), 'hx-screen-'));
  const paths = agentPaths({ XDG_DATA_HOME: join(home, 'data'), XDG_CONFIG_HOME: join(home, 'config') }, home);
  if (o.installed) {
    mkdirSync(paths.agentDir, { recursive: true });
    writeFileSync(
      paths.state,
      JSON.stringify({ name: 'mini-pc', agentUrl: 'https://c/fabric', browser: '/x', maxBrowsers: 1, version: '1.2.0', commit: 'abcdef1234', hostId: '0123456789abcdef', browserKind: 'chrome-for-testing', chromeVersion: '142', service: true, installedAt: '', updatedAt: '' }),
    );
    const bundle = join(home, 'bundle');
    mkdirSync(join(bundle, 'bin'), { recursive: true });
    mkdirSync(join(paths.current, '..'), { recursive: true });
    symlinkSync(bundle, paths.current);
  }
  const state = { sudo: false, missing: new Set(['xdotool', 'imagemagick']), journal: 'Nov 16 agent started\nNov 16 ERROR could not reach the fabric\n' };
  const exec: Fake['exec'] = [];
  const logs: string[] = [];
  const run = (argv: string[], opts?: { input?: string }): ExecResult => {
    exec.push({ argv, ...(opts?.input !== undefined ? { input: opts.input } : {}) });
    const ok = { code: 0, stdout: '', stderr: '' };
    if (argv[0] === 'dpkg') return { ...ok, code: state.missing.has(argv[2]!) ? 1 : 0 };
    if (argv[0] === 'sudo' && argv[1] === '-n' && argv[2] === 'true') return { ...ok, code: state.sudo ? 0 : 1 };
    if (argv[0] === 'sudo' && argv[1] === '-S') {
      state.sudo = opts?.input === `${PASSWORD}\n`;
      return { ...ok, code: state.sudo ? 0 : 1 };
    }
    if (argv[0] === 'sudo' && argv[1] === '-n' && argv[2] === 'apt-get') {
      for (const p of argv.slice(7)) state.missing.delete(p);
      return ok;
    }
    if (argv[0] === 'systemctl' && argv.includes('show')) return { ...ok, stdout: 'ActiveState=active\nSubState=running\n' };
    if (argv[0] === 'journalctl') return { ...ok, stdout: state.journal };
    return ok;
  };
  return {
    state,
    exec,
    logs,
    deps: (log) => ({
      paths,
      fetch: async (url) => {
        throw new Error(`unexpected download ${url}`);
      },
      postJson: async () => ({ ok: true, status: 200, json: async () => ({}) }),
      api: () => ({
        get: async <T,>() => [{ id: '0123456789abcdef', name: 'mini-pc', online: true, browserConnected: true }] as T,
        post: async <T,>() => ({}) as T,
        delete: async () => undefined,
      }),
      exec: run,
      log: (l) => {
        logs.push(l);
        log(l);
      },
      sleep: async () => undefined,
      hostname: () => 'mini-pc',
      platform: { os: 'linux', arch: 'x64' },
      env: {},
    }),
  };
}

let screen: TuiTestHandle | undefined;
afterEach(() => {
  screen?.unmount();
  screen = undefined;
});

async function open(f: Fake, columns = 100): Promise<TuiTestHandle> {
  screen = await renderTuiScreen((p) => <AgentScreen {...p} deps={f.deps} />, { columns });
  return screen;
}

const text = (s: TuiTestHandle) => stripAnsi(s.lastFrame() ?? '');

describe('the Agent screen', () => {
  it('shows a machine with nothing installed, its health and what to do', async () => {
    const s = await open(fake());
    const frame = await s.waitForFrame((f) => f.includes('Health'));
    expect(frame).toContain('Not set up');
    expect(frame).toContain('Install…');
    expect(frame).toContain('Doctor and dependencies');
    expect(frame).not.toContain('Uninstall');
  });

  it('shows an installed agent with Fleet, and its actions', async () => {
    const s = await open(fake({ installed: true }));
    const frame = await s.waitForFrame((f) => f.includes('Fleet') && f.includes('online'));
    expect(frame).toContain('mini-pc (01234567)');
    expect(frame).toMatch(/active[\s│]*\(running\)/);
    expect(frame).toContain('Stop the agent');
    expect(frame).toContain('Uninstall…');
  });

  it('doctor lists the dependencies, asks for sudo in the TUI and installs the missing ones; the password is never shown', async () => {
    const f = fake();
    const s = await open(f);
    await s.waitForFrame((fr) => fr.includes('Health'));
    await s.press('d');
    let frame = await s.waitForFrame((fr) => fr.includes('Dependencies'));
    expect(frame).toMatch(/○ xdotool\s+missing/);
    expect(frame).toMatch(/○ imagemagick\s+missing/);
    expect(frame).toContain('m install missing');

    await s.press('m');
    await s.waitForFrame((fr) => fr.includes('administrator rights'));
    await s.type('wrong');
    await s.press('enter');
    await s.waitForFrame((fr) => fr.includes('did not accept that password'));
    await s.type(PASSWORD);
    expect(text(s)).toContain('•'.repeat(PASSWORD.length));
    await s.press('enter');
    frame = await s.waitForFrame((fr) => fr.includes('✓ Done'), 5000);
    expect(frame).toContain('Installed xdotool, imagemagick.');
    expect(f.exec.map((e) => e.argv)).toContainEqual(['sudo', '-n', 'apt-get', 'install', '-y', '--no-install-recommends', 'xdotool', 'imagemagick']);
    // The password went to sudo's stdin only: not to argv, a log line or any frame.
    const everywhere = [...s.frames.map(stripAnsi), ...f.logs, ...f.exec.map((e) => e.argv.join(' '))].join('\n');
    expect(everywhere).not.toContain(PASSWORD);
    expect(f.exec.filter((e) => e.input === `${PASSWORD}\n`).map((e) => e.argv)).toEqual([['sudo', '-S', '-p', '', '-v']]);
  });

  it('install wizard: mode, then a review of what it needs, with the name and resolution', async () => {
    const s = await open(fake());
    await s.waitForFrame((fr) => fr.includes('Health'));
    await s.press('i');
    let frame = await s.waitForFrame((fr) => fr.includes('choose how the agent runs'));
    expect(frame).toContain('Unattended: its own desktop from boot');
    await s.press('3');
    frame = await s.waitForFrame((fr) => fr.includes('review'));
    expect(frame).toContain('Resolution');
    expect(frame).toContain('1920x1080');
    expect(frame).toMatch(/tigervnc-standalone-server/);
    expect(frame).toMatch(/to install \(sudo\)/);
    await s.press('n');
    await s.waitForFrame((fr) => fr.includes('Host name in Fleet'));
    for (let i = 0; i < 'mini-pc'.length; i++) await s.press('backspace');
    await s.type('home-node');
    await s.press('enter');
    frame = await s.waitForFrame((fr) => fr.includes('review') && fr.includes('home-node'));
    await s.press('esc');
    await s.waitForFrame((fr) => fr.includes('choose how the agent runs'));
  });

  it('logs: live from the agent service, errors highlighted, follow toggles', async () => {
    const f = fake({ installed: true });
    const s = await open(f);
    await s.waitForFrame((fr) => fr.includes('Fleet'));
    await s.press('l');
    let frame = await s.waitForFrame((fr) => fr.includes('Logs · agent service · live'));
    expect(frame).toContain('ERROR could not reach the fabric');
    f.state.journal += 'Nov 16 reconnected\n';
    frame = await s.waitForFrame((fr) => fr.includes('reconnected'), 5000);
    await s.press('f');
    frame = await s.waitForFrame((fr) => fr.includes('Logs · agent service') && !fr.includes('· live'));
    expect(frame).toContain('f follow');
    await s.press('esc');
    await s.waitForFrame((fr) => fr.includes('Health'));
  });
});
