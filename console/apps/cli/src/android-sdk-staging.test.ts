import { existsSync, mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { createCli } from '@marinoscar/platform-cli';
import { resetCliForTests } from '@marinoscar/platform-cli/testing';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { sdkInstallRoot, sdkStagingDir, stageSdkDownloadNearSdk } from './android-sdk-staging.js';
import { APP_CLI_OPTIONS } from './app.js';

resetCliForTests();
createCli(APP_CLI_OPTIONS);

let home: string;
const managed = () => join(home, '.hexactra', 'android-sdk');
/** A machine whose temporary directory is on device 2 and everything else on device 1. */
const splitDevices = (path: string) => (path.startsWith('/tmp-other') ? 2 : 1);

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), 'hexactra-sdk-staging-'));
});
afterEach(() => rmSync(home, { recursive: true, force: true }));

describe('the SDK directory doctor --fix installs into (#480)', () => {
  it('is the managed directory by default, and an explicit ANDROID_HOME when set', () => {
    expect(sdkInstallRoot({ home, env: {}, platform: 'linux' })).toBe(managed());
    expect(sdkInstallRoot({ home, env: { ANDROID_HOME: '/opt/sdk' }, platform: 'linux' })).toBe('/opt/sdk');
  });

  it('is the first directory that exists, as the doctor picks it', () => {
    const studio = join(home, 'Android', 'Sdk');
    mkdirSync(studio, { recursive: true });
    expect(sdkInstallRoot({ home, env: {}, platform: 'linux' })).toBe(studio);
    mkdirSync(managed(), { recursive: true });
    expect(sdkInstallRoot({ home, env: {}, platform: 'linux' })).toBe(managed());
  });
});

describe('staging the SDK download (#480)', () => {
  it('leaves the temporary directory alone on one filesystem', () => {
    const env: NodeJS.ProcessEnv = {};
    expect(sdkStagingDir({ home, env, platform: 'linux', tmp: '/tmp', device: () => 1 })).toBeUndefined();
    expect(stageSdkDownloadNearSdk({ home, env, platform: 'linux', tmp: '/tmp', device: () => 1 })).toBeUndefined();
    expect(env['TMPDIR']).toBeUndefined();
  });

  it('stages beside what exists when the temporary directory is on another filesystem', () => {
    // No SDK yet: beside the nearest existing parent, so the doctor still picks the same SDK directory.
    expect(sdkStagingDir({ home, env: {}, platform: 'linux', tmp: '/tmp-other', device: splitDevices })).toBe(join(home, '.android-sdk-staging'));
    mkdirSync(managed(), { recursive: true });
    expect(sdkStagingDir({ home, env: {}, platform: 'linux', tmp: '/tmp-other', device: splitDevices })).toBe(
      join(managed(), '.android-sdk-staging'),
    );
  });

  it('points TMPDIR at the staging directory, says so, and removes it afterwards', () => {
    mkdirSync(managed(), { recursive: true });
    const env: NodeJS.ProcessEnv = {};
    const lines: string[] = [];
    const cleanup = stageSdkDownloadNearSdk({ home, env, platform: 'linux', tmp: '/tmp-other', device: splitDevices, warn: (line) => lines.push(line) });
    const staging = join(managed(), '.android-sdk-staging');
    expect(env['TMPDIR']).toBe(staging);
    expect(existsSync(staging)).toBe(true);
    expect(lines).toEqual([expect.stringContaining(staging)]);
    cleanup?.();
    expect(existsSync(staging)).toBe(false);
  });

  it('does nothing when a filesystem cannot be read', () => {
    expect(sdkStagingDir({ home, env: {}, platform: 'linux', tmp: '/tmp-other', device: () => undefined })).toBeUndefined();
  });
});
