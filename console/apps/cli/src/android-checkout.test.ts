import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { createCli } from '@marinoscar/platform-cli';
import { resetCliForTests } from '@marinoscar/platform-cli/testing';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  PLATFORM_CORE_DIR,
  androidPreflight,
  applyAndroidCheckout,
  locateAndroidCheckout,
  missingDependenciesMessage,
  repoRootEnvVar,
} from './android-checkout.js';
import { androidScreenNotice } from './android.screen.js';
import { APP_CLI_OPTIONS } from './app.js';

resetCliForTests();
createCli(APP_CLI_OPTIONS);

let tree: string;
let repo: string;
let consoleDir: string;

/** A clone: `<repo>/console/apps/android`, with or without the installed platform library. */
function clone(options: { installed: boolean }): void {
  mkdirSync(join(consoleDir, 'apps', 'android'), { recursive: true });
  mkdirSync(join(repo, 'crates', 'hexactra-core'), { recursive: true });
  writeFileSync(join(consoleDir, 'apps', 'android', 'version.properties'), 'versionName=1.0.0\nversionCode=1\n');
  if (options.installed) {
    mkdirSync(join(consoleDir, PLATFORM_CORE_DIR), { recursive: true });
    writeFileSync(join(consoleDir, PLATFORM_CORE_DIR, 'build.gradle.kts'), '');
  }
}

beforeEach(() => {
  tree = mkdtempSync(join(tmpdir(), 'hexactra-android-checkout-'));
  repo = join(tree, 'hexactra');
  consoleDir = join(repo, 'console');
  mkdirSync(join(tree, 'elsewhere'), { recursive: true });
});
afterEach(() => rmSync(tree, { recursive: true, force: true }));

describe('locating the Android app (#478)', () => {
  it('finds it from console/ and from a directory inside it, as the platform does', () => {
    clone({ installed: true });
    expect(locateAndroidCheckout({ cwd: consoleDir, env: {} })).toEqual({ root: consoleDir, nested: false, explicit: false });
    expect(locateAndroidCheckout({ cwd: join(consoleDir, 'apps', 'android'), env: {} }).root).toBe(consoleDir);
  });

  it('finds console/ from the repository root and from another directory of the repository', () => {
    clone({ installed: true });
    expect(locateAndroidCheckout({ cwd: repo, env: {} })).toEqual({ root: consoleDir, nested: true, explicit: false });
    expect(locateAndroidCheckout({ cwd: join(repo, 'crates', 'hexactra-core'), env: {} }).root).toBe(consoleDir);
  });

  it('finds nothing outside the repository', () => {
    clone({ installed: true });
    expect(locateAndroidCheckout({ cwd: join(tree, 'elsewhere'), env: {} }).root).toBeUndefined();
  });

  it('takes an explicit root as given, accepting the repository root for console/', () => {
    clone({ installed: true });
    const variable = repoRootEnvVar();
    expect(locateAndroidCheckout({ cwd: tree, env: { [variable]: repo } })).toEqual({ root: consoleDir, nested: true, explicit: true });
    expect(locateAndroidCheckout({ cwd: consoleDir, env: { [variable]: join(tree, 'elsewhere') } })).toEqual({
      root: undefined,
      nested: false,
      explicit: true,
    });
  });

  it('points the platform at console/ only when the app is one level down', () => {
    clone({ installed: true });
    const fromRoot: NodeJS.ProcessEnv = {};
    applyAndroidCheckout({ cwd: repo, env: fromRoot });
    expect(fromRoot[repoRootEnvVar()]).toBe(consoleDir);
    const fromConsole: NodeJS.ProcessEnv = {};
    applyAndroidCheckout({ cwd: consoleDir, env: fromConsole });
    expect(fromConsole[repoRootEnvVar()]).toBeUndefined();
  });
});

describe('the check before an android command (#478)', () => {
  const run = (subcommand: string, cwd: string) => {
    const lines: string[] = [];
    const env: NodeJS.ProcessEnv = {};
    androidPreflight(subcommand, { cwd, env, warn: (line) => lines.push(line) });
    return { lines, env };
  };

  it('says nothing in a ready checkout', () => {
    clone({ installed: true });
    expect(run('release', consoleDir).lines).toEqual([]);
  });

  it('says which folder it uses from the repository root', () => {
    clone({ installed: true });
    const { lines, env } = run('doctor', repo);
    expect(lines).toEqual([expect.stringContaining(`Using the Android app in ${consoleDir}`)]);
    expect(env[repoRootEnvVar()]).toBe(consoleDir);
  });

  it('warns the doctor that this is the wrong folder', () => {
    clone({ installed: true });
    const elsewhere = join(tree, 'elsewhere');
    expect(run('doctor', elsewhere).lines).toEqual([expect.stringMatching(/^⚠ .*elsewhere is not inside the hexactra repository/)]);
    // The platform's own error covers the commands that cannot go on.
    expect(run('release', elsewhere).lines).toEqual([]);
  });

  it('stops build and release when the dependencies are not installed', () => {
    clone({ installed: false });
    for (const subcommand of ['build', 'release']) {
      expect(() => run(subcommand, repo)).toThrow(`cd ${consoleDir} && npm ci`);
    }
  });

  it('only warns the doctor about missing dependencies, and leaves the other commands alone', () => {
    clone({ installed: false });
    expect(run('doctor', consoleDir).lines).toEqual([expect.stringContaining('dependencies are not installed')]);
    expect(run('keystore', consoleDir).lines).toEqual([]);
    expect(run('releases', consoleDir).lines).toEqual([]);
  });

  it('names the missing library', () => {
    clone({ installed: false });
    expect(missingDependenciesMessage(consoleDir)).toContain(join(consoleDir, PLATFORM_CORE_DIR));
    clone({ installed: true });
    expect(missingDependenciesMessage(consoleDir)).toBeUndefined();
  });
});

describe('`android release` through the CLI (#478)', () => {
  it('fails before the version bump when the dependencies are not installed', async () => {
    clone({ installed: false });
    const versionFile = join(consoleDir, 'apps', 'android', 'version.properties');
    const before = process.cwd();
    const variable = repoRootEnvVar();
    const saved = process.env[variable];
    delete process.env[variable];
    let err = '';
    const write = process.stderr.write.bind(process.stderr);
    process.stderr.write = ((chunk: string | Uint8Array) => {
      err += String(chunk);
      return true;
    }) as typeof process.stderr.write;
    try {
      process.chdir(repo);
      resetCliForTests();
      const code = await createCli(APP_CLI_OPTIONS).run(['android', 'release', '--bump', 'patch', '--notes', 'x']);
      expect(code).not.toBe(0);
    } finally {
      process.stderr.write = write;
      process.chdir(before);
      if (saved === undefined) delete process.env[variable];
      else process.env[variable] = saved;
    }
    expect(err).toContain(`cd ${consoleDir} && npm ci`);
    const { readFileSync } = await import('node:fs');
    expect(readFileSync(versionFile, 'utf8')).toBe('versionName=1.0.0\nversionCode=1\n');
  });
});

describe('the Android screen notice (#478)', () => {
  it('reports the wrong folder, the missing dependencies, or the folder in use', () => {
    clone({ installed: false });
    expect(androidScreenNotice({ cwd: join(tree, 'elsewhere'), env: {} }).problem).toContain('not inside the hexactra repository');
    expect(androidScreenNotice({ cwd: repo, env: {} }).problem).toContain('npm ci');
    clone({ installed: true });
    expect(androidScreenNotice({ cwd: repo, env: {} })).toEqual({ note: expect.stringContaining(consoleDir) });
    expect(androidScreenNotice({ cwd: consoleDir, env: {} })).toEqual({});
  });
});
