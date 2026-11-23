// `hexactra agent update`, end to end (#902): the agent is updated, the person's Chrome restarted so it loads the new extension, the
// extension's version checked; the command and the terminal UI run this same routine.
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { AgentDeps, AgentState, ExecResult } from './agent.js';

const state = vi.hoisted(() => ({ before: null as unknown, after: null as unknown, unattended: null as unknown, calls: [] as string[] }));
vi.mock('./agent.js', () => ({
  readState: vi.fn(() => (state.calls.includes('updateAgent') ? state.after : state.before)),
  updateTargets: vi.fn(() => ({ attended: state.before !== null, unattended: state.unattended !== null })),
  updateAgent: vi.fn(async () => void state.calls.push('updateAgent')),
  fetchAndActivate: vi.fn(async () => void state.calls.push('fetchAndActivate')),
  updateUnattended: vi.fn(() => void state.calls.push('updateUnattended')),
}));
vi.mock('./unattended.js', () => ({ readUnattended: vi.fn(() => state.unattended) }));

const { atLeast, connectedExtensionVersion, mainChromePids, updateEverything, waitForExtension } = await import('./update.js');

const attended = (commit: string): AgentState => ({ version: '0.2.0', commit, attended: true, browserKind: 'google-chrome', service: true } as unknown as AgentState);

interface Fake {
  d: AgentDeps;
  logs: string[];
  argv: string[][];
  chrome: { running: boolean };
  journal: string[];
}

function fake(opts: { chromeRunning?: boolean; reconnectWith?: string | null; extension?: string } = {}): Fake {
  const home = mkdtempSync(join(tmpdir(), 'hx-update-'));
  const current = join(home, 'current');
  mkdirSync(join(current, 'extension'), { recursive: true });
  writeFileSync(join(current, 'extension', 'manifest.json'), JSON.stringify({ version: opts.extension ?? '0.2.0' }));
  const f: Fake = { d: null as unknown as AgentDeps, logs: [], argv: [], chrome: { running: opts.chromeRunning ?? true }, journal: ['INFO hexactra_agent::browser_bridge: browser extension connected version=Some("0.1.0.79")'] };
  let base = Number.MAX_SAFE_INTEGER;
  const exec = (argv: string[]): ExecResult => {
    f.argv.push(argv);
    if (argv[0] === 'ps') return { code: 0, stdout: f.chrome.running ? '  4242 /opt/google/chrome/chrome --restore-last-session\n  4243 /opt/google/chrome/chrome --type=renderer\n  7 /usr/bin/bash\n' : '  7 /usr/bin/bash\n', stderr: '' };
    if (argv[0] === 'kill') {
      f.chrome.running = false;
      return { code: 0, stdout: '', stderr: '' };
    }
    if (argv[0] === 'env' && argv.includes('setsid')) {
      f.chrome.running = true;
      base = f.journal.length;
      if (opts.reconnectWith !== null) f.journal.push(`INFO hexactra_agent::browser_bridge: browser extension connected version=Some("${opts.reconnectWith ?? '0.2.0.81'}")`);
      return { code: 0, stdout: '', stderr: '' };
    }
    // `--since` the update started: only what was logged after Chrome restarted (a real journal filters by time).
    if (argv[0] === 'journalctl') return { code: 0, stdout: (argv[argv.indexOf('--since') + 1]!.startsWith('1970') ? f.journal : f.journal.slice(base)).join('\n'), stderr: '' };
    return { code: 0, stdout: '', stderr: '' };
  };
  f.d = {
    paths: { current, agentDir: home } as unknown as AgentDeps['paths'],
    exec,
    log: (l: string) => void f.logs.push(l),
    sleep: async () => undefined,
    env: { DISPLAY: ':1' },
  } as unknown as AgentDeps;
  return f;
}

beforeEach(() => {
  state.calls = [];
  state.unattended = null;
  state.before = attended('aaaaaaa1111');
  state.after = attended('bbbbbbb2222');
});

describe('agent update helpers (#902)', () => {
  it('compares versions by their numeric parts', () => {
    expect(atLeast('0.2.0.81', '0.2.0')).toBe(true);
    expect(atLeast('0.1.0.79', '0.2.0')).toBe(false);
    expect(atLeast('0.10.0', '0.2.0')).toBe(true);
    expect(atLeast('0.2.0', '0.2.0')).toBe(true);
  });

  it('reads the last connected extension version from the agent journal', () => {
    const f = fake();
    f.journal.push('INFO other line', 'INFO hexactra_agent::browser_bridge: browser extension connected version=Some("0.2.0.81")');
    expect(connectedExtensionVersion(f.d, new Date(0))).toBe('0.2.0.81');
    expect(f.argv.at(-1)).toEqual(expect.arrayContaining(['journalctl', '--user', '-u', 'hexactra-agent.service']));
  });

  it("finds Chrome's main processes, not its renderers", () => {
    expect(mainChromePids(fake().d)).toEqual([4242]);
  });

  it('waits for the extension to reconnect as new as the bundle', async () => {
    const f = fake();
    expect(await waitForExtension(f.d, new Date(0), '0.2.0', 10_000)).toBe('0.1.0.79');
    f.journal.push('INFO x: browser extension connected version=Some("0.2.0.81")');
    expect(await waitForExtension(f.d, new Date(0), '0.2.0', 10_000)).toBe('0.2.0.81');
  });
});

describe('agent update, end to end (#902)', () => {
  it('updates the agent, restarts Chrome gracefully with its tabs, and confirms the new extension', async () => {
    const f = fake();
    const lines = await updateEverything(f.d, {});
    expect(state.calls).toEqual(['updateAgent', 'updateUnattended']);
    expect(f.argv.find((a) => a[0] === 'kill')).toEqual(['kill', '-TERM', '4242']);
    expect(f.argv.find((a) => a.includes('setsid'))).toEqual(['env', 'DISPLAY=:1', 'setsid', '-f', expect.stringMatching(/chrome/), '--restore-last-session']);
    expect(lines).toEqual(['Agent 0.2.0 (bbbbbbb)', 'Extension 0.2.0.81 connected']);
    expect(f.logs).toContain('Restarting Google Chrome so it loads the new extension (your tabs are restored)…');
  });

  it('starts Chrome when it was not running', async () => {
    const f = fake({ chromeRunning: false });
    await updateEverything(f.d, {});
    expect(f.argv.some((a) => a[0] === 'kill')).toBe(false);
    expect(f.argv.some((a) => a.includes('setsid'))).toBe(true);
  });

  it('says so, and how to fix it, when Chrome still has the old extension or the extension never connects', async () => {
    await expect(updateEverything(fake({ reconnectWith: '0.1.0.79' }).d, {})).rejects.toThrow(/older than 0\.2\.0.*run `hexactra agent update` again/);
    await expect(updateEverything(fake({ reconnectWith: null }).d, {})).rejects.toThrow(/did not connect.*hexactra agent doctor/);
  });

  it('leaves Chrome alone when the agent and the extension are already current', async () => {
    state.after = state.before;
    const f = fake();
    f.journal = ['INFO x: browser extension connected version=Some("0.2.0.81")'];
    const lines = await updateEverything(f.d, {});
    expect(f.argv.some((a) => a[0] === 'kill' || a.includes('setsid'))).toBe(false);
    expect(lines).toContain('Extension 0.2.0.81 connected (already current)');
  });

  it('updates an unattended-only machine and says its browsers restart with the new extension', async () => {
    state.before = null;
    state.after = null;
    state.unattended = { hostId: 'h' };
    const lines = await updateEverything(fake().d, { interactive: false });
    expect(state.calls).toEqual(['fetchAndActivate', 'updateUnattended']);
    expect(lines).toEqual(['Unattended node updated: its browsers restarted and start with the new extension at their next run']);
  });
});
