import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type { AgentPaths } from './paths.js';

/**
 * Google Chrome on a node (#337, docs/nodes.md). Branded Chrome no longer
 * loads unpacked extensions, so the Hexactra extension is force-installed by
 * ONE enterprise policy file, from the signed CRX the agent release publishes
 * (apps/chrome-extension/README.md). The native host is registered per user.
 */

/** The extension id, from the public key in its manifest (scripts/extension-id.mjs checks every copy). */
export const EXTENSION_ID = 'ahpjoclfeibdmlnbaednepiihpamklcl';
export const NATIVE_HOST_NAME = 'com.hexactra.nativehost';
export const DEFAULT_UPDATE_URL = 'https://github.com/marinoscar/hexactra/releases/download/agent-latest/updates.xml';
export const CHROME_DEB_URL = 'https://dl.google.com/linux/direct/google-chrome-stable_current_amd64.deb';

export interface Exec {
  (argv: string[], opts?: { interactive?: boolean; input?: string }): { code: number; stdout: string; stderr: string };
}

export interface ChromeDeps {
  paths: AgentPaths;
  exec: Exec;
  log(line: string): void;
  fetch(url: string): Promise<{ ok: boolean; status: number; arrayBuffer(): Promise<ArrayBuffer> }>;
}

/** The policy Hexactra writes: the extension, force-installed, pinned, updated from our manifest. */
export function chromePolicy(updateUrl = DEFAULT_UPDATE_URL): Record<string, unknown> {
  return {
    ExtensionSettings: {
      [EXTENSION_ID]: {
        installation_mode: 'force_installed',
        update_url: updateUrl,
        override_update_url: true,
        toolbar_pin: 'force_pinned',
      },
    },
  };
}

export function policyText(updateUrl?: string): string {
  return `${JSON.stringify(chromePolicy(updateUrl), null, 2)}\n`;
}

/** The per-user native messaging host manifest: only the Hexactra extension may connect. */
export function nativeHostManifest(binary: string): Record<string, unknown> {
  return {
    name: NATIVE_HOST_NAME,
    description: 'Hexactra remote control bridge',
    path: binary,
    type: 'stdio',
    allowed_origins: [`chrome-extension://${EXTENSION_ID}/`],
  };
}

export function nativeHostFile(paths: AgentPaths): string {
  return join(paths.chromeNativeHostDir, `${NATIVE_HOST_NAME}.json`);
}

export interface OsInfo {
  id: string;
  supported: boolean;
  pretty: string;
}

/** Debian and Ubuntu (and their derivatives) are supported: Google ships Chrome for them as a .deb. */
export function osInfo(text: string | null): OsInfo {
  const kv = Object.fromEntries(
    (text ?? '')
      .split('\n')
      .map((l) => /^([A-Z_]+)=(.*)$/.exec(l.trim()))
      .filter((m): m is RegExpExecArray => !!m)
      .map((m) => [m[1]!, m[2]!.replace(/^"|"$/g, '')]),
  );
  const id = kv.ID ?? 'unknown';
  const family = `${id} ${kv.ID_LIKE ?? ''}`;
  return { id, supported: /\b(debian|ubuntu)\b/.test(family), pretty: kv.PRETTY_NAME ?? id };
}

const read = (p: string): string | null => {
  try {
    return readFileSync(p, 'utf8');
  } catch {
    return null;
  }
};

export interface ChromeStatus {
  os: OsInfo;
  chrome: { installed: boolean; version: string | null; path: string };
  policy: { present: boolean; current: boolean; path: string; updateUrl: string | null };
  nativeHost: { present: boolean; current: boolean; path: string };
}

/** What is set up for Google Chrome, without changing anything. */
export function chromeStatus(d: ChromeDeps, o: { updateUrl?: string | undefined } = {}): ChromeStatus {
  const { paths } = d;
  const installed = existsSync(paths.googleChrome);
  const v = installed ? d.exec([paths.googleChrome, '--version']) : null;
  const version = v && v.code === 0 ? (/(\d+(?:\.\d+)+)/.exec(v.stdout)?.[1] ?? null) : null;
  const policyRaw = read(paths.chromePolicyFile);
  let updateUrl: string | null = null;
  try {
    const p = JSON.parse(policyRaw ?? 'null') as { ExtensionSettings?: Record<string, { update_url?: string }> } | null;
    updateUrl = p?.ExtensionSettings?.[EXTENSION_ID]?.update_url ?? null;
  } catch {
    updateUrl = null;
  }
  const wantUrl = o.updateUrl ?? updateUrl ?? DEFAULT_UPDATE_URL;
  const nh = nativeHostFile(paths);
  const nhRaw = read(nh);
  return {
    os: osInfo(read(paths.osRelease)),
    chrome: { installed, version, path: paths.googleChrome },
    policy: { present: policyRaw !== null, current: policyRaw === policyText(wantUrl), path: paths.chromePolicyFile, updateUrl },
    nativeHost: {
      present: nhRaw !== null,
      current: nhRaw === `${JSON.stringify(nativeHostManifest(join(paths.current, 'bin', 'hexactra-native-host')), null, 2)}\n`,
      path: nh,
    },
  };
}

export function chromeStatusLines(s: ChromeStatus): string[] {
  return [
    `System:      ${s.os.pretty}${s.os.supported ? '' : ' (not supported: Debian or Ubuntu only)'}`,
    `Chrome:      ${s.chrome.installed ? `Google Chrome ${s.chrome.version ?? '(version unknown)'}` : 'not installed'}`,
    `Policy:      ${s.policy.current ? 'installs the Hexactra extension' : s.policy.present ? 'out of date' : 'missing'} (${s.policy.path})`,
    `Native host: ${s.nativeHost.current ? 'registered' : s.nativeHost.present ? 'out of date' : 'missing'} (${s.nativeHost.path})`,
  ];
}

/** A step that needs root, shown to the person before sudo asks for a password. */
export interface PrivilegedStep {
  what: string;
  argv: string[];
}

export interface ChromeSetupOptions {
  /** Ask for the sudo password in this terminal (false: only `sudo -n`, as in the TUI). */
  interactive: boolean;
  /** Where the policy points Chrome for updates (a test or CI mirror). */
  updateUrl?: string | undefined;
}

/**
 * Installs Google Chrome if missing, writes the policy, registers the native
 * host. Root is needed only for the first two, once: the steps are listed,
 * `sudo -v` asks once, then each runs with `sudo -n`. Re-running with
 * everything current needs no sudo at all.
 */
export async function chromeSetup(d: ChromeDeps, o: ChromeSetupOptions): Promise<ChromeStatus> {
  const before = chromeStatus(d, { updateUrl: o.updateUrl });
  if (!before.os.supported) {
    throw new Error(`Google Chrome nodes run on Debian or Ubuntu for now (this is ${before.os.pretty}). Windows and macOS nodes are planned.`);
  }
  const stage = mkdtempSync(join(tmpdir(), 'hexactra-chrome-'));
  try {
    const steps: PrivilegedStep[] = [];
    if (!before.chrome.installed) {
      d.log(`Downloading Google Chrome (${CHROME_DEB_URL})`);
      const res = await d.fetch(CHROME_DEB_URL);
      if (!res.ok) throw new Error(`Google Chrome download failed (${res.status})`);
      const deb = join(stage, 'google-chrome-stable_current_amd64.deb');
      writeFileSync(deb, Buffer.from(await res.arrayBuffer()));
      // apt verifies the package's dependencies, and the package adds Google's apt repository for updates.
      steps.push({ what: 'install Google Chrome (it adds Google\'s apt repository, so the system keeps it updated)', argv: ['apt-get', 'install', '-y', deb] });
    }
    if (!before.policy.current) {
      const file = join(stage, 'hexactra.json');
      writeFileSync(file, policyText(o.updateUrl ?? before.policy.updateUrl ?? undefined));
      steps.push({
        what: `write ${d.paths.chromePolicyFile}: Chrome installs the Hexactra extension and shows "Managed by your organization", which refers to this one file`,
        argv: ['install', '-D', '-m', '0644', '-o', 'root', '-g', 'root', file, d.paths.chromePolicyFile],
      });
    }
    if (steps.length) runPrivileged(d, steps, o.interactive);
  } finally {
    rmSync(stage, { recursive: true, force: true });
  }
  registerNativeHost(d);
  const after = chromeStatus(d, { updateUrl: o.updateUrl });
  if (!after.chrome.installed) throw new Error('Google Chrome is still not installed; see the apt output above.');
  d.log(after.policy.current ? 'Google Chrome is set up for Hexactra. Restart Chrome once if it is open.' : 'The policy is not in place; run `hexactra agent chrome setup` again.');
  return after;
}

/** Runs root steps with one password prompt; without a terminal, says exactly what to run. */
export function runPrivileged(d: ChromeDeps, steps: PrivilegedStep[], interactive: boolean): void {
  d.log('These steps need administrator rights (sudo), once:');
  for (const s of steps) d.log(`  - ${s.what}`);
  const ready = d.exec(['sudo', '-n', 'true']).code === 0 || (interactive && d.exec(['sudo', '-v'], { interactive: true }).code === 0);
  if (!ready) {
    const cmds = steps.map((s) => `sudo ${s.argv.join(' ')}`).join('\n  ');
    throw new Error(
      interactive
        ? 'sudo did not succeed, so nothing that needs root was changed.'
        : `This needs your sudo password. Run \`hexactra agent chrome setup\` in a terminal, or run:\n  ${cmds}`,
    );
  }
  for (const s of steps) {
    const r = d.exec(['sudo', '-n', ...s.argv], { interactive });
    if (r.code !== 0) throw new Error(`Could not ${s.what.split(':')[0]} (${(r.stderr || r.stdout).trim() || `exit ${r.code}`})`);
  }
}

/** The per-user native host manifest, pointing at the active agent bundle. */
export function registerNativeHost(d: ChromeDeps): string {
  const file = nativeHostFile(d.paths);
  mkdirSync(d.paths.chromeNativeHostDir, { recursive: true });
  writeFileSync(file, `${JSON.stringify(nativeHostManifest(join(d.paths.current, 'bin', 'hexactra-native-host')), null, 2)}\n`);
  d.log(`Native messaging host registered (${file})`);
  return file;
}

/** Removes the policy (sudo) and the native host manifest. Never removes Chrome itself. */
export function chromeTeardown(d: ChromeDeps, interactive: boolean): void {
  rmSync(nativeHostFile(d.paths), { force: true });
  if (existsSync(d.paths.chromePolicyFile)) {
    try {
      runPrivileged(d, [{ what: `remove ${d.paths.chromePolicyFile}`, argv: ['rm', '-f', d.paths.chromePolicyFile] }], interactive);
      d.log('Chrome policy removed (Google Chrome itself stays installed)');
    } catch (e) {
      d.log(`The Chrome policy stays: ${e instanceof Error ? e.message : String(e)}`);
    }
  }
}
