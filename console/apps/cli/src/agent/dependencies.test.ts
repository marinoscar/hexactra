// The dependency report and the TUI's sudo (#374).
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import type { AgentDeps, ExecResult } from './agent.js';
import { dependencyLines, dependencyReport, installedModes, installMissing, packagesFor, sudoAuthenticate, sudoReady } from './dependencies.js';
import { agentPaths } from './paths.js';

function fake(missing: string[] = []) {
  const home = mkdtempSync(join(tmpdir(), 'hx-deps-'));
  const exec: { argv: string[]; input?: string }[] = [];
  const logs: string[] = [];
  const d = {
    paths: agentPaths({ XDG_DATA_HOME: join(home, 'data'), XDG_CONFIG_HOME: join(home, 'config') }, home),
    exec: (argv: string[], o?: { input?: string }): ExecResult => {
      exec.push({ argv, ...(o?.input !== undefined ? { input: o.input } : {}) });
      if (argv[0] === 'dpkg') return { code: missing.includes(argv[2]!) ? 1 : 0, stdout: '', stderr: '' };
      if (argv[0] === 'sudo' && argv[1] === '-S') return { code: o?.input === 'right\n' ? 0 : 1, stdout: '', stderr: '' };
      return { code: 0, stdout: '', stderr: '' };
    },
    log: (l: string) => logs.push(l),
  } as unknown as AgentDeps;
  return { d, exec, logs, home };
}

describe('the dependency report', () => {
  it('lists what each mode needs, merged, with what is missing', () => {
    expect(packagesFor('default')).toEqual(['xdotool', 'imagemagick']);
    expect(packagesFor('attended')).toEqual(expect.arrayContaining(['google-chrome-stable', 'x11vnc', 'libnotify-bin', 'xdotool', 'imagemagick']));
    expect(packagesFor('unattended')).toEqual(expect.arrayContaining(['google-chrome-stable', 'tigervnc-standalone-server', 'xfce4', 'xdotool']));
    const { d } = fake(['xdotool', 'google-chrome-stable']);
    const rows = dependencyReport(d, ['default', 'attended']);
    const xdotool = rows.find((r) => r.name === 'xdotool')!;
    expect(xdotool).toMatchObject({ installed: false, neededBy: ['default', 'attended'], purpose: 'mouse and keyboard on the whole desktop' });
    expect(rows.find((r) => r.name === 'x11vnc')).toMatchObject({ installed: true, neededBy: ['attended'] });
    expect(rows.find((r) => r.name === 'google-chrome-stable')).toMatchObject({ chrome: true, installed: false });
    expect(rows.some((r) => r.name === 'xfce4')).toBe(false);
    expect(dependencyLines(rows).find((l) => l.includes('xdotool'))).toMatch(/^MISSING\s+xdotool/);
  });

  it('installs only the missing apt packages; Google Chrome is left to Chrome setup', () => {
    const { d, exec, logs } = fake(['xdotool', 'google-chrome-stable']);
    exec.length = 0;
    const r = installMissing(d, dependencyReport(d, ['attended']), false);
    expect(r).toEqual({ installed: ['xdotool'], chromeMissing: true });
    expect(exec.map((e) => e.argv)).toContainEqual(['sudo', '-n', 'apt-get', 'install', '-y', '--no-install-recommends', 'xdotool']);
    expect(logs.join('\n')).toMatch(/Google Chrome is missing/);
  });

  it('reports the installed modes, or every mode when nothing is installed', () => {
    const { d } = fake();
    expect(installedModes(d)).toEqual(['default', 'attended', 'unattended']);
    mkdirSync(d.paths.agentDir, { recursive: true });
    writeFileSync(d.paths.state, JSON.stringify({ attended: true }));
    writeFileSync(join(d.paths.agentDir, 'unattended.json'), JSON.stringify({ name: 'n' }));
    expect(installedModes(d)).toEqual(['attended', 'unattended']);
  });
});

describe('sudo from the TUI', () => {
  it('feeds the password to sudo -S on stdin only, and reports whether it worked', () => {
    const { d, exec } = fake();
    expect(sudoAuthenticate(d, 'wrong')).toBe(false);
    expect(sudoAuthenticate(d, 'right')).toBe(true);
    const calls = exec.filter((e) => e.argv[0] === 'sudo');
    expect(calls.map((c) => c.argv)).toEqual([
      ['sudo', '-S', '-p', '', '-v'],
      ['sudo', '-S', '-p', '', '-v'],
    ]);
    // The password is never in argv.
    expect(JSON.stringify(calls.map((c) => c.argv))).not.toMatch(/right|wrong/);
    expect(sudoReady(d)).toBe(true);
  });
});
