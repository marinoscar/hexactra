import { existsSync, mkdirSync, readFileSync, rmSync, statSync } from 'node:fs';
import { join } from 'node:path';

import type { Fetch } from './bundle.js';
import type { AgentPaths } from './paths.js';
import { unzipTo } from './unzip.js';

/**
 * The browser the agent launches. Default: Chrome for Testing, because it
 * loads the unpacked Hexactra extension (`--load-extension`), which branded
 * Google Chrome ignores, and runs the native messaging host, which the snap
 * Chromium's confinement blocks.
 */
export const CFT_JSON = 'https://googlechromelabs.github.io/chrome-for-testing/last-known-good-versions-with-downloads.json';

export interface ChromeInstall {
  version: string;
  binary: string;
  /** Chrome's setuid sandbox helper (only used when user namespaces are restricted). */
  sandboxHelper: string;
}

export function chromeFor(paths: AgentPaths, version: string): ChromeInstall {
  const dir = join(paths.chromeDir, version, 'chrome-linux64');
  return { version, binary: join(dir, 'chrome'), sandboxHelper: join(dir, 'chrome_sandbox') };
}

/** Downloads the current stable Chrome for Testing for linux64, or reuses it. */
export async function ensureChrome(paths: AgentPaths, fetch: Fetch, log: (line: string) => void): Promise<ChromeInstall> {
  const res = await fetch(CFT_JSON);
  if (!res.ok) throw new Error(`could not read the Chrome for Testing versions (${res.status})`);
  const stable = (JSON.parse(await res.text()) as {
    channels: { Stable: { version: string; downloads: { chrome: { platform: string; url: string }[] } } };
  }).channels.Stable;
  const install = chromeFor(paths, stable.version);
  if (existsSync(install.binary)) {
    log(`Chrome for Testing ${stable.version} already installed`);
    return install;
  }
  const url = stable.downloads.chrome.find((d) => d.platform === 'linux64')?.url;
  if (!url) throw new Error('Chrome for Testing has no linux64 download');
  log(`Downloading Chrome for Testing ${stable.version}`);
  const zip = await fetch(url);
  if (!zip.ok) throw new Error(`Chrome for Testing download failed (${zip.status})`);
  const dir = join(paths.chromeDir, stable.version);
  rmSync(dir, { recursive: true, force: true });
  mkdirSync(dir, { recursive: true });
  unzipTo(Buffer.from(await zip.arrayBuffer()), dir);
  if (!existsSync(install.binary)) throw new Error('the Chrome for Testing archive has no chrome binary');
  log(`Chrome for Testing ${stable.version} installed`);
  return install;
}

/**
 * Whether Chrome needs its setuid sandbox helper here: Ubuntu 23.10 and later
 * restrict unprivileged user namespaces (AppArmor), which Chrome's default
 * sandbox needs, and so do kernels with `unprivileged_userns_clone=0`.
 */
export function needsSetuidSandbox(read: (p: string) => string | null = readProc): boolean {
  return read('/proc/sys/kernel/apparmor_restrict_unprivileged_userns') === '1' || read('/proc/sys/kernel/unprivileged_userns_clone') === '0';
}

function readProc(p: string): string | null {
  try {
    return readFileSync(p, 'utf8').trim();
  } catch {
    return null;
  }
}

/** Whether the helper is already root-owned and setuid (what Chrome requires). */
export function sandboxHelperReady(helper: string): boolean {
  try {
    const s = statSync(helper);
    return s.uid === 0 && (s.mode & 0o4000) !== 0;
  } catch {
    return false;
  }
}

/** The two privileged commands that make the helper usable, run with sudo. */
export function sandboxHelperCommands(helper: string): string[][] {
  return [
    ['sudo', 'chown', 'root:root', helper],
    ['sudo', 'chmod', '4755', helper],
  ];
}
