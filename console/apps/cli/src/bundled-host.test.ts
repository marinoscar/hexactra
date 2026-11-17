// `hexactra deploy bundled-host` (#386): the bundled VPS browser host on or
// off, with a fake docker and a real .env in a temporary deployment.
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { needsAutoGenerate } from '@marinoscar/platform-cli/core';
import { describe, expect, it } from 'vitest';

import { bundledHostOff, bundledHostOn, bundledHostStatus, deploymentRoot, type Exec } from './bundled-host.js';

function deployment(env: string) {
  const apps = mkdtempSync(join(tmpdir(), 'bundled-host-'));
  const root = join(apps, 'hexactra');
  const dir = join(root, 'repo', 'console', 'infra', 'compose');
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, '.env'), env);
  return { apps, root, dir, env: () => readFileSync(join(dir, '.env'), 'utf8') };
}

function fakeDocker(dir: string, running: { fabricHost: boolean }) {
  const calls: string[][] = [];
  const exec: Exec = (argv) => {
    calls.push(argv);
    if (argv[1] === 'ps') {
      expect(argv).toContain(`label=com.docker.compose.project.working_dir=${dir}`);
      const rows = ['aaa111 api running', ...(running.fabricHost ? ['bbb222 fabric-host running'] : [])];
      return { status: 0, stdout: `${rows.join('\n')}\n`, stderr: '' };
    }
    if (argv[1] === 'inspect') return { status: 0, stdout: `hexactra|${dir}/base.compose.yml,${dir}/app.fabric.compose.yml\n`, stderr: '' };
    return { status: 0, stdout: '', stderr: '' };
  };
  return { exec, calls };
}

describe('hexactra deploy bundled-host', () => {
  it('finds the deployment under the apps root, or asks for --root', () => {
    const { apps, root } = deployment('A=1\n');
    expect(deploymentRoot(undefined, apps)).toBe(root);
    expect(deploymentRoot('/srv/x', apps)).toBe('/srv/x');
    expect(() => deploymentRoot(undefined, join(apps, 'nothing'))).toThrow(/pass --root/);
  });

  it('off writes none and stops and removes only fabric-host; status reports it', () => {
    const { root, dir, env } = deployment('POSTGRES_DB=hexactra\nCOMPOSE_PROFILES=bundled-host\nOTHER=x\n');
    const docker = fakeDocker(dir, { fabricHost: true });
    const lines: string[] = [];
    expect(bundledHostStatus({ exec: docker.exec, log: () => undefined }, root)).toEqual({ setting: 'on', running: true });
    bundledHostOff({ exec: docker.exec, log: (l) => lines.push(l) }, root);
    expect(env()).toBe('POSTGRES_DB=hexactra\nCOMPOSE_PROFILES=none\nOTHER=x\n');
    expect(docker.calls).toContainEqual(['docker', 'stop', 'bbb222']);
    expect(docker.calls).toContainEqual(['docker', 'rm', 'bbb222']);
    expect(docker.calls.flat()).not.toContain('aaa111');
    expect(docker.calls.some((c) => c.includes('volume'))).toBe(false);
    expect(lines.join('\n')).toMatch(/revoke it there/);
    // Idempotent: off again only rewrites the setting.
    const again = fakeDocker(dir, { fabricHost: false });
    bundledHostOff({ exec: again.exec, log: () => undefined }, root);
    expect(again.calls.filter((c) => c[1] !== 'ps')).toEqual([]);
    expect(bundledHostStatus({ exec: again.exec, log: () => undefined }, root)).toEqual({ setting: 'off', running: false });
  });

  it('on writes bundled-host and starts fabric-host with the stack\'s own compose files', () => {
    const { root, dir, env } = deployment('POSTGRES_DB=hexactra\nCOMPOSE_PROFILES=none\n');
    const docker = fakeDocker(dir, { fabricHost: false });
    bundledHostOn({ exec: docker.exec, log: () => undefined }, root);
    expect(env()).toBe('POSTGRES_DB=hexactra\nCOMPOSE_PROFILES=bundled-host\n');
    expect(docker.calls.at(-1)).toEqual([
      'docker', 'compose', '-p', 'hexactra', '--project-directory', dir, '--env-file', join(dir, '.env'),
      '-f', `${dir}/base.compose.yml`, '-f', `${dir}/app.fabric.compose.yml`,
      '--profile', 'bundled-host', 'up', '-d', 'fabric-host',
    ]);
  });

  it('adds the setting when the .env has none', () => {
    const { root, dir, env } = deployment('POSTGRES_DB=hexactra');
    bundledHostOff({ exec: fakeDocker(dir, { fabricHost: false }).exec, log: () => undefined }, root);
    expect(env()).toBe('POSTGRES_DB=hexactra\nCOMPOSE_PROFILES=none\n');
  });

  it('the choice survives deploy update: the generator only fills an empty value', () => {
    expect(needsAutoGenerate('none')).toBe(false);
    expect(needsAutoGenerate('bundled-host')).toBe(false);
    expect(needsAutoGenerate('')).toBe(true);
  });
});
