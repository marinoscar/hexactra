import { spawnSync, type SpawnSyncOptions } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readlinkSync, rmSync, writeFileSync } from 'node:fs';
import { hostname, tmpdir } from 'node:os';
import { basename, dirname, join } from 'node:path';

import { activate, fetchBundle, type Fetch } from './bundle.js';
import { ensureChrome, needsSetuidSandbox, sandboxHelperCommands, sandboxHelperReady, chromeFor } from './chrome.js';
import { chromeSetup, chromeStatus, chromeTeardown, registerNativeHost, type ChromeStatus } from './googleChrome.js';
import { agentPaths, UNIT_NAME, type AgentPaths } from './paths.js';
import {
  DEFAULT_LAYOUT,
  NODE_USER,
  UNITS,
  detectGpu,
  freeDisplay,
  installSteps,
  readUnattended,
  runPrivileged,
  uninstallSteps,
  withStage,
  writeUnattended,
  type NodeLayout,
  type UnattendedState,
} from './unattended.js';
import { agentEnv, unitFile, type AgentConfig } from './service.js';

/** What `hexactra agent install` recorded (no secret: the credential is its own 0600 file). */
export interface AgentState extends AgentConfig {
  version: string;
  commit: string;
  hostId: string;
  browserKind: 'chrome-for-testing' | 'google-chrome' | 'custom';
  chromeVersion?: string | undefined;
  service: boolean;
  installedAt: string;
  updatedAt: string;
}

export interface ExecResult {
  code: number;
  stdout: string;
  stderr: string;
}

/** The console API surface this module needs (the CLI's logged-in client). */
export interface AgentApi {
  get<T>(path: string): Promise<T>;
  post<T>(path: string, body?: unknown): Promise<T>;
  delete(path: string): Promise<unknown>;
}

export interface AgentDeps {
  paths: AgentPaths;
  fetch: Fetch;
  /** POST JSON to the fabric (the enrollment exchange). */
  postJson(url: string, body: unknown): Promise<{ ok: boolean; status: number; json(): Promise<unknown> }>;
  api(): AgentApi;
  exec(argv: string[], opts?: { interactive?: boolean }): ExecResult;
  log(line: string): void;
  sleep(ms: number): Promise<void>;
  hostname(): string;
  platform: { os: string; arch: string };
}

export function defaultDeps(log: (line: string) => void, api: () => AgentApi): AgentDeps {
  return {
    paths: agentPaths(),
    fetch: (url) => fetch(url),
    postJson: (url, body) => fetch(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }),
    api,
    exec: (argv, opts) => {
      const o: SpawnSyncOptions = opts?.interactive ? { stdio: 'inherit' } : { encoding: 'utf8' };
      const r = spawnSync(argv[0]!, argv.slice(1), o);
      if (r.error) return { code: 127, stdout: '', stderr: r.error.message };
      return { code: r.status ?? 1, stdout: String(r.stdout ?? ''), stderr: String(r.stderr ?? '') };
    },
    log,
    sleep: (ms) => new Promise((r) => setTimeout(r, ms)),
    hostname,
    platform: { os: process.platform, arch: process.arch },
  };
}

export interface FleetHostView {
  id: string;
  name: string;
  online: boolean;
  browserConnected: boolean;
  version?: string;
}

export function readState(paths: AgentPaths): AgentState | null {
  try {
    return JSON.parse(readFileSync(paths.state, 'utf8')) as AgentState;
  } catch {
    return null;
  }
}

function writeState(paths: AgentPaths, s: AgentState): void {
  mkdirSync(paths.agentDir, { recursive: true });
  writeFileSync(paths.state, JSON.stringify(s, null, 2) + '\n');
}

function systemctl(d: AgentDeps, ...args: string[]): ExecResult {
  return d.exec(['systemctl', '--user', ...args]);
}

function must(r: ExecResult, what: string): ExecResult {
  if (r.code !== 0) throw new Error(`${what} failed: ${(r.stderr || r.stdout).trim() || `exit ${r.code}`}`);
  return r;
}

/** Makes Chrome's setuid sandbox helper usable (root-owned, 4755) with sudo; interactive asks for the password. */
export function ensureSandbox(d: AgentDeps, helper: string, interactive: boolean): void {
  if (sandboxHelperReady(helper)) return;
  d.log('This system restricts the user namespaces Chrome sandboxes with; installing Chrome\'s sandbox helper needs sudo once.');
  for (const argv of sandboxHelperCommands(helper)) {
    const cmd = interactive ? argv : [argv[0]!, '-n', ...argv.slice(1)];
    const r = d.exec(cmd, { interactive });
    if (r.code !== 0) {
      throw new Error(
        interactive
          ? `sudo failed (${r.code}); Chrome cannot sandbox without its helper.`
          : 'Installing Chrome\'s sandbox helper needs your sudo password: run `hexactra agent sandbox` in a terminal, then try again.',
      );
    }
  }
  d.log('Chrome sandbox helper installed');
}

export interface InstallOptions {
  name?: string | undefined;
  browser?: string | undefined;
  maxBrowsers?: number | undefined;
  bundle?: string | undefined;
  version?: string | undefined;
  service?: boolean | undefined;
  noDesktop?: boolean | undefined;
  reenroll?: boolean | undefined;
  /** Join with a token an admin minted (Fleet → Enroll host) instead of the console login. */
  enrollmentToken?: string | undefined;
  /** With `enrollmentToken`: where the fabric is (default `<console>/fabric`). */
  agentUrl?: string | undefined;
  /** Prompt for sudo (a terminal) or only try `sudo -n` (the TUI). */
  interactiveSudo?: boolean | undefined;
  /** Use Google Chrome with the extension installed by policy (`hexactra agent chrome setup`). */
  googleChrome?: boolean | undefined;
  /** Where the Chrome policy points for extension updates (a test or CI mirror). */
  extensionUpdateUrl?: string | undefined;
  /** Attended mode (#341): the person's own Google Chrome and X11 desktop. */
  attended?: boolean | undefined;
  waitSeconds?: number | undefined;
}

/**
 * Turns this machine into a browser host: verified bundle, a browser that
 * loads the extension, enrollment through the console login, the host
 * credential (0600), the systemd user service, then waits for Fleet to show
 * the host online. Re-running it repairs or reconfigures an install and keeps
 * the same host unless `reenroll`.
 */
export async function installAgent(d: AgentDeps, o: InstallOptions): Promise<AgentState> {
  if (d.platform.os !== 'linux' || d.platform.arch !== 'x64') {
    throw new Error(`hexactra agent supports Linux x86_64 for now (this is ${d.platform.os}/${d.platform.arch}).`);
  }
  const { paths } = d;
  const previous = readState(paths);
  const service = o.service !== false;
  if (service && systemctl(d, 'show-environment').code !== 0) {
    throw new Error('No systemd user session here. Install with --no-service and run the agent with `hexactra agent run`.');
  }

  const bundle = await fetchBundle(paths, { bundle: o.bundle, version: o.version }, d.fetch, d.log);

  let browser: string;
  let chromeVersion: string | undefined;
  let sandboxHelper: string | undefined;
  // A re-install keeps the browser chosen before unless a new one is given.
  const chosen = o.browser ?? (previous?.browserKind === 'custom' ? previous.browser : undefined);
  const attended = o.attended ?? previous?.attended ?? false;
  if (attended) requireX11(d);
  const useGoogle = attended || (!o.browser && (o.googleChrome ?? previous?.browserKind === 'google-chrome'));
  if (attended) ensureAttendedTools(d, o.interactiveSudo !== false);
  if (useGoogle) {
    const chrome = await chromeSetup(d, { interactive: o.interactiveSudo !== false, updateUrl: o.extensionUpdateUrl });
    browser = chrome.chrome.path;
    chromeVersion = chrome.chrome.version ?? undefined;
  } else if (chosen) {
    browser = chosen;
    d.log(`Using the browser at ${browser} (it must load unpacked extensions: Chromium or Chrome for Testing, not branded Chrome)`);
  } else {
    const chrome = await ensureChrome(paths, d.fetch, d.log);
    browser = chrome.binary;
    chromeVersion = chrome.version;
    if (needsSetuidSandbox()) {
      ensureSandbox(d, chrome.sandboxHelper, o.interactiveSudo !== false);
      sandboxHelper = chrome.sandboxHelper;
    }
  }

  // On a machine that is also an unattended node, the attended host has its own name.
  const base = o.name ?? previous?.name ?? d.hostname();
  const name = attended && readUnattended(d.paths.agentDir) && !base.endsWith('-attended') ? `${base}-attended` : base;
  let hostId = previous?.hostId;
  let agentUrl = previous?.agentUrl;
  if (!hostId || !agentUrl || !existsSync(paths.credential) || o.reenroll || o.enrollmentToken) {
    ({ hostId, agentUrl } = await enroll(d, name, o));
  } else {
    d.log(`Keeping this machine's host ${hostId.slice(0, 8)} (use --reenroll for a new one)`);
  }

  activate(paths, bundle);
  // The native host manifest points through `current`, so it stays valid across updates.
  if (useGoogle) registerNativeHost(d);
  const now = new Date().toISOString();
  const state: AgentState = {
    name,
    agentUrl,
    browser,
    maxBrowsers: o.maxBrowsers ?? previous?.maxBrowsers ?? 1,
    sandboxHelper,
    noDesktop: attended ? false : (o.noDesktop ?? previous?.noDesktop ?? false),
    attended,
    version: bundle.version,
    commit: bundle.commit,
    hostId,
    browserKind: useGoogle ? 'google-chrome' : chosen ? 'custom' : 'chrome-for-testing',
    chromeVersion,
    service,
    installedAt: previous?.installedAt ?? now,
    updatedAt: now,
  };
  writeState(paths, state);

  if (service) {
    startService(d, state);
    await waitOnline(d, hostId, o.waitSeconds ?? 90);
  } else {
    d.log('Installed without a service: run it with `hexactra agent run`.');
  }
  return state;
}

/** Creates an enrollment with the console login and exchanges it at the fabric; the token never leaves memory. */
async function enroll(
  d: AgentDeps,
  name: string,
  o: InstallOptions,
  into: { credential: string; hostIdFile: string | null } = { credential: d.paths.credential, hostIdFile: d.paths.hostIdFile },
): Promise<{ hostId: string; agentUrl: string }> {
  let token: string;
  let agentUrl: string;
  if (o.enrollmentToken) {
    if (!o.agentUrl) throw new Error('--enrollment-token needs --agent-url (the fabric URL the enroll command printed).');
    d.log(`Enrolling "${name}" with the given enrollment token`);
    token = o.enrollmentToken.trim();
    agentUrl = o.agentUrl.replace(/\/+$/, '');
  } else {
    d.log(`Enrolling "${name}" with the console`);
    const e = await d.api().post<{ enrollmentToken: string; agentUrl?: string }>('/fleet/enrollments', { name });
    token = e.enrollmentToken;
    agentUrl = (o.agentUrl ?? e.agentUrl ?? '').replace(/\/+$/, '');
  }
  if (!/^https?:\/\//.test(agentUrl)) throw new Error('The console did not return a fabric URL for new hosts; update the console.');
  const res = await d.postJson(`${agentUrl}/v1/hosts/enroll`, { enrollment_token: token, name, version: 'hexactra-cli' });
  if (!res.ok) throw new Error(`The fabric refused the enrollment (${res.status}) at ${agentUrl}`);
  const c = (await res.json()) as { host_id?: string; host_token?: string };
  if (!c.host_id || !c.host_token) throw new Error('The fabric returned no host credential');
  mkdirSync(dirname(into.credential), { recursive: true, mode: 0o700 });
  writeFileSync(into.credential, JSON.stringify({ host_id: c.host_id, host_token: c.host_token }, null, 2), { mode: 0o600 });
  if (into.hostIdFile) writeFileSync(into.hostIdFile, `${c.host_id}\n`);
  d.log(`Enrolled as host ${c.host_id.slice(0, 8)} at ${agentUrl}`);
  return { hostId: c.host_id, agentUrl };
}

function startService(d: AgentDeps, s: AgentState): void {
  mkdirSync(d.paths.unitDir, { recursive: true });
  writeFileSync(d.paths.unit, unitFile(d.paths, s));
  must(systemctl(d, 'daemon-reload'), 'systemctl --user daemon-reload');
  must(systemctl(d, 'enable', UNIT_NAME), `enabling ${UNIT_NAME}`);
  must(systemctl(d, 'restart', UNIT_NAME), `starting ${UNIT_NAME}`);
  const env = systemctl(d, 'show-environment').stdout;
  if (!s.noDesktop && !/^(DISPLAY|WAYLAND_DISPLAY)=/m.test(env)) {
    d.log('No desktop session is open: the host comes online now, and its browser opens once you are logged in to the desktop.');
  }
  d.log(`Service ${UNIT_NAME} started`);
}

async function waitOnline(d: AgentDeps, hostId: string, seconds: number): Promise<void> {
  d.log('Waiting for the host to come online in Fleet');
  const until = Date.now() + seconds * 1000;
  while (Date.now() < until) {
    try {
      const hosts = await d.api().get<FleetHostView[]>('/fleet/hosts');
      if (hosts.find((h) => h.id === hostId)?.online) {
        d.log('The host is online in Fleet');
        return;
      }
    } catch (e) {
      // Joined with a token and not logged in: nothing to ask; the service runs anyway.
      if (/not logged in|login/i.test(e instanceof Error ? e.message : String(e))) {
        d.log('Not logged in to the console, so Fleet is not checked: see the host on the Fleet page.');
        return;
      }
      // otherwise keep waiting: the console may be briefly unreachable
    }
    await d.sleep(2000);
  }
  throw new Error(`The host did not come online within ${seconds}s. See \`hexactra agent logs\`.`);
}

export interface AgentStatus {
  installed: boolean;
  state: AgentState | null;
  activeBundle: string | null;
  service: { active: string; sub: string } | null;
  fleet: FleetHostView | null;
  fleetError: string | null;
}

export async function agentStatus(d: AgentDeps): Promise<AgentStatus> {
  const state = readState(d.paths);
  let activeBundle: string | null = null;
  try {
    activeBundle = readlinkSync(d.paths.current);
  } catch {
    // not installed
  }
  let service: AgentStatus['service'] = null;
  if (state?.service) {
    const r = systemctl(d, 'show', UNIT_NAME, '-p', 'ActiveState', '-p', 'SubState');
    const v = Object.fromEntries(r.stdout.split('\n').filter(Boolean).map((l) => l.split('=', 2) as [string, string]));
    service = { active: v.ActiveState ?? 'unknown', sub: v.SubState ?? 'unknown' };
  }
  let fleet: FleetHostView | null = null;
  let fleetError: string | null = null;
  if (state) {
    try {
      fleet = (await d.api().get<FleetHostView[]>('/fleet/hosts')).find((h) => h.id === state.hostId) ?? null;
      if (!fleet) fleetError = 'This host is not in Fleet any more (revoked?). Run `hexactra agent install --reenroll`.';
    } catch (e) {
      fleetError = e instanceof Error ? e.message : String(e);
    }
  }
  return { installed: !!state, state, activeBundle, service, fleet, fleetError };
}

function requireState(d: AgentDeps): AgentState {
  const s = readState(d.paths);
  if (!s) throw new Error('No agent is installed on this machine. Run `hexactra agent install`.');
  return s;
}

/** Latest (or `version`) bundle; also moves Chrome for Testing to its current stable. Restarts the service. */
export async function updateAgent(d: AgentDeps, o: { bundle?: string; version?: string; force?: boolean }): Promise<AgentState> {
  const s = requireState(d);
  const bundle = await fetchBundle(d.paths, o, d.fetch, d.log);
  let next: AgentState = { ...s, version: bundle.version, commit: bundle.commit, updatedAt: new Date().toISOString() };
  if (s.browserKind === 'chrome-for-testing') {
    const chrome = await ensureChrome(d.paths, d.fetch, d.log);
    if (chrome.version !== s.chromeVersion && s.sandboxHelper) ensureSandbox(d, chrome.sandboxHelper, true);
    next = { ...next, browser: chrome.binary, chromeVersion: chrome.version, sandboxHelper: s.sandboxHelper ? chrome.sandboxHelper : undefined };
  }
  if (!o.force && s.commit === bundle.commit && next.browser === s.browser) {
    d.log(`Already up to date (${s.version}, ${s.commit.slice(0, 7)})`);
    return s;
  }
  activate(d.paths, bundle);
  writeState(d.paths, next);
  if (s.service) startService(d, next);
  d.log(`Updated to ${bundle.version} (${bundle.commit.slice(0, 7)})`);
  return next;
}

export function serviceControl(d: AgentDeps, action: 'start' | 'stop' | 'restart'): void {
  const s = requireState(d);
  if (!s.service) throw new Error('This agent runs without a service; use `hexactra agent run`.');
  must(systemctl(d, action, UNIT_NAME), `${action} ${UNIT_NAME}`);
  d.log(`${UNIT_NAME}: ${action}ed`.replace('stoped', 'stopped'));
}

/** The service's journal: last `lines`, or follow (interactive). */
export function agentLogs(d: AgentDeps, lines: number, follow: boolean): ExecResult {
  const argv = ['journalctl', '--user', '-u', UNIT_NAME, '-n', String(lines), '--no-pager', '-o', 'short-iso'];
  return d.exec(follow ? [...argv, '-f'] : argv, { interactive: follow });
}

export async function uninstallAgent(d: AgentDeps, o: { keepHost?: boolean; purgeProfiles?: boolean; interactiveSudo?: boolean }): Promise<void> {
  const s = readState(d.paths);
  if (s?.browserKind === 'google-chrome') chromeTeardown(d, o.interactiveSudo !== false);
  if (s?.service || existsSync(d.paths.unit)) {
    systemctl(d, 'disable', '--now', UNIT_NAME);
    rmSync(d.paths.unit, { force: true });
    systemctl(d, 'daemon-reload');
    d.log(`Service ${UNIT_NAME} removed`);
  }
  if (s && !o.keepHost) {
    try {
      await d.api().delete(`/fleet/hosts/${s.hostId}`);
      d.log(`Host ${s.hostId.slice(0, 8)} revoked in Fleet`);
    } catch (e) {
      d.log(`Could not revoke the host in Fleet (${e instanceof Error ? e.message : String(e)}); revoke it on the Fleet page.`);
    }
  }
  rmSync(d.paths.credential, { force: true });
  rmSync(d.paths.hostIdFile, { force: true });
  rmSync(d.paths.agentDir, { recursive: true, force: true });
  rmSync(d.paths.chromeDir, { recursive: true, force: true });
  if (o.purgeProfiles) {
    rmSync(d.paths.profilesDir, { recursive: true, force: true });
    d.log('Browser profiles deleted');
  } else if (existsSync(d.paths.profilesDir)) {
    d.log(`Browser profiles kept in ${d.paths.profilesDir} (they hold sign-ins; --purge-profiles deletes them)`);
  }
  d.log('The agent is uninstalled');
}

/** The agent in the foreground with the installed configuration (no systemd; CI, servers). */
export function runAgentForeground(d: AgentDeps): number {
  const s = requireState(d);
  const env = agentEnv(d.paths, s);
  const r = spawnSync(join(d.paths.current, 'bin', 'hexactra-agent'), ['daemon'], { stdio: 'inherit', env: { ...process.env, ...env } });
  return r.status ?? 1;
}

/** Re-runs the sandbox helper step for the installed Chrome for Testing (needs a terminal for sudo). */
export function sandboxAgain(d: AgentDeps): void {
  const s = requireState(d);
  if (s.browserKind === 'google-chrome') {
    d.log('Google Chrome ships its own sandbox helper; nothing to set up.');
    return;
  }
  if (s.browserKind !== 'chrome-for-testing' || !s.chromeVersion) throw new Error('This agent uses its own browser; there is no Chrome for Testing helper to set up.');
  ensureSandbox(d, chromeFor(d.paths, s.chromeVersion).sandboxHelper, true);
}

export interface DoctorCheck {
  name: string;
  ok: boolean;
  detail: string;
  /** Works, but worth fixing (does not fail the doctor). */
  warning?: boolean;
}

/**
 * Every check `hexactra agent doctor` runs, in the order to fix them:
 * system, browser, policy, native host, agent, service, Fleet.
 */
export async function agentDoctor(d: AgentDeps): Promise<DoctorCheck[]> {
  const st = await agentStatus(d);
  const s = st.state;
  const google = s?.browserKind === 'google-chrome';
  const checks: DoctorCheck[] = [];
  const add = (name: string, ok: boolean, detail: string) => checks.push({ name, ok, detail });
  add('system', d.platform.os === 'linux' && d.platform.arch === 'x64', `${d.platform.os}/${d.platform.arch}`);
  if (s?.attended) {
    const kind = sessionKind(d);
    add('session', kind === 'x11', kind === 'x11' ? 'X11 desktop session' : kind === 'wayland' ? WAYLAND_HELP.split('\n')[0]! : 'no desktop session here (run doctor from your desktop)');
    add('x11vnc', d.exec(['dpkg', '-s', 'x11vnc']).code === 0, 'shares your desktop only while someone views it');
  }
  if (google || !s) {
    const c: ChromeStatus = chromeStatus(d);
    add('os', c.os.supported, c.os.pretty);
    add('chrome', c.chrome.installed, c.chrome.installed ? `Google Chrome ${c.chrome.version ?? ''}`.trim() : 'not installed: run `hexactra agent chrome setup`');
    add('policy', c.policy.current, c.policy.current ? `${c.policy.path} installs the extension (check chrome://policy)` : `${c.policy.present ? 'out of date' : 'missing'}: run \`hexactra agent chrome setup\`, then restart Chrome`);
    add('native-host', c.nativeHost.current, c.nativeHost.current ? c.nativeHost.path : 'missing or out of date: run `hexactra agent chrome setup`');
  } else {
    add('browser', existsSync(s.browser), `${s.browserKind}: ${s.browser}`);
  }
  const u = unattendedStatus(d);
  if (u.state) {
    for (const [unit, st] of Object.entries(u.units)) add(unit.replace('.service', ''), st === 'active', st === 'active' ? 'active' : `${st}: run \`hexactra agent logs --mode unattended\``);
    checks.push({
      name: 'graphics',
      ok: true,
      warning: !u.state.gpu,
      detail: u.state.gpu ? `${u.state.gpu.driver} (${u.state.gpu.renderNode}); check chrome://gpu on the desktop` : 'software rendering: no Intel or AMD GPU found, so sites can tell more easily',
    });
  }
  if (!s) {
    if (!u.state) add('agent', false, 'not installed: run `hexactra agent install`');
    return checks;
  }
  add('agent', !!st.activeBundle && existsSync(join(d.paths.current, 'bin', 'hexactra-agent')), `${s.version} (${s.commit.slice(0, 7)})`);
  add('credential', existsSync(d.paths.credential), existsSync(d.paths.credential) ? 'present (0600)' : 'missing: run `hexactra agent install --reenroll`');
  if (s.service) add('service', st.service?.active === 'active', `${UNIT_NAME}: ${st.service?.active ?? 'unknown'} (${st.service?.sub ?? 'unknown'})`);
  add('fleet', !!st.fleet?.online, st.fleet ? `${st.fleet.online ? 'online' : 'offline'}${st.fleet.browserConnected ? ', extension connected' : ', extension not connected yet'}` : (st.fleetError ?? 'unknown'));
  return checks;
}

export interface UnattendedOptions extends InstallOptions {
  /** e.g. 1920x1080 */
  resolution?: string | undefined;
  /** Where the node's files go (tests). */
  layout?: NodeLayout | undefined;
}

/**
 * `hexactra agent install --mode unattended` (#340): Google Chrome with the
 * extension by policy, then one sudo prompt for the rest: the desktop
 * packages, the `hexactra` user, the agent in /opt/hexactra, its credential
 * and three system units that start at boot with nobody logged in. Then it
 * waits for Fleet to show the host online with its desktop.
 */
export async function installUnattended(d: AgentDeps, o: UnattendedOptions): Promise<UnattendedState> {
  if (d.platform.os !== 'linux' || d.platform.arch !== 'x64') {
    throw new Error(`Unattended nodes run on Linux x86_64 (this is ${d.platform.os}/${d.platform.arch}).`);
  }
  const layout = o.layout ?? DEFAULT_LAYOUT;
  const interactive = o.interactiveSudo !== false;
  const resolution = o.resolution ?? readUnattended(d.paths.agentDir)?.resolution ?? '1920x1080';
  if (!/^\d{3,4}x\d{3,4}$/.test(resolution)) throw new Error(`--resolution must look like 1920x1080 (got ${resolution})`);
  await chromeSetup(d, { interactive, updateUrl: o.extensionUpdateUrl });
  const bundle = await fetchBundle(d.paths, { bundle: o.bundle, version: o.version }, d.fetch, d.log);
  const prev = readUnattended(d.paths.agentDir);
  const name = o.name ?? prev?.name ?? d.hostname();
  const credDir = mkdtempSync(join(tmpdir(), 'hexactra-enroll-'));
  try {
    let hostId = prev?.hostId;
    let agentUrl = prev?.agentUrl;
    let credential: string | null = null;
    if (!hostId || !agentUrl || o.reenroll || o.enrollmentToken) {
      credential = join(credDir, 'host-credential.json');
      ({ hostId, agentUrl } = await enroll(d, name, o, { credential, hostIdFile: null }));
    } else {
      d.log(`Keeping this node's host ${hostId.slice(0, 8)} (use --reenroll for a new one)`);
    }
    const gpu = detectGpu(layout);
    d.log(gpu ? `Graphics: ${gpu.driver} at ${gpu.renderNode}; Chrome will render with it` : 'Graphics: no Intel or AMD GPU found; Chrome renders in software, which sites can detect more easily');
    const display = prev?.display ?? freeDisplay(layout);
    const config = { name, agentUrl, display, maxBrowsers: o.maxBrowsers ?? prev?.maxBrowsers ?? 2, gpu, resolution };
    const userExists = d.exec(['id', '-u', NODE_USER]).code === 0;
    const bundleId = basename(bundle.dir);
    withStage((stage) => runPrivileged(d, installSteps(config, { bundleDir: bundle.dir, bundleId, credential, stage, userExists }, layout), interactive));
    const now = new Date().toISOString();
    const state: UnattendedState = { hostId, ...config, bundle: bundleId, installedAt: prev?.installedAt ?? now, updatedAt: now };
    writeUnattended(d.paths.agentDir, state);
    d.log(`Unattended desktop :${display} (${resolution}) and agent started; they start at every boot`);
    await waitOnline(d, hostId, o.waitSeconds ?? 120);
    d.log('Open its desktop from Fleet, then set up a profile: `hexactra fleet profile show <host> <profile>` opens the Google sign-in there.');
    return state;
  } finally {
    rmSync(credDir, { recursive: true, force: true });
  }
}

export interface UnattendedStatus {
  installed: boolean;
  state: UnattendedState | null;
  units: Record<string, string>;
}

export function unattendedStatus(d: AgentDeps): UnattendedStatus {
  const state = readUnattended(d.paths.agentDir);
  const units: Record<string, string> = {};
  if (state) for (const u of Object.values(UNITS)) units[u] = (d.exec(['systemctl', 'is-active', u]).stdout.trim() || 'unknown');
  return { installed: !!state, state, units };
}

/** Starts, stops or restarts the unattended desktop and agent (sudo). */
export function unattendedControl(d: AgentDeps, action: 'start' | 'stop' | 'restart', interactive = true): void {
  if (!readUnattended(d.paths.agentDir)) throw new Error('No unattended node is installed here. Run `hexactra agent install --mode unattended`.');
  const units = action === 'stop' ? [UNITS.agent, UNITS.session, UNITS.display] : [UNITS.display, UNITS.session, UNITS.agent];
  runPrivileged(d, [{ what: `${action} the unattended desktop and agent`, argv: ['systemctl', action, ...units] }], interactive);
}

/** The unattended agent's journal (system unit: readable with sudo or the adm group). */
export function unattendedLogs(d: AgentDeps, lines: number, follow: boolean): ExecResult {
  const argv = ['journalctl', '-u', UNITS.agent, '-u', UNITS.display, '-n', String(lines), '--no-pager', '-o', 'short-iso'];
  const full = follow ? [...argv, '-f'] : argv;
  const plain = d.exec(full, { interactive: follow });
  if (follow || /\S/.test(plain.stdout.replace(/^-- No entries --\s*$/m, ''))) return plain;
  return d.exec(['sudo', '-n', ...full]);
}

/** Copies the active bundle to the node and restarts its agent (sudo). */
export function updateUnattended(d: AgentDeps, interactive = true, layout: NodeLayout = DEFAULT_LAYOUT): void {
  const s = readUnattended(d.paths.agentDir);
  if (!s) return;
  const dir = readlinkSync(d.paths.current);
  const bundleId = basename(dir);
  if (bundleId === s.bundle) return;
  const target = `${layout.opt}/agent/${bundleId}`;
  runPrivileged(
    d,
    [
      { what: `copy the agent ${bundleId} to ${target}`, argv: ['install', '-d', '-m', '0755', target] },
      { what: 'copy the agent files', argv: ['cp', '-a', '--no-preserve=ownership', `${dir}/.`, `${target}/`] },
      { what: 'point the agent at this version', argv: ['ln', '-sfn', target, `${layout.opt}/agent/current`] },
      { what: 'restart the unattended agent', argv: ['systemctl', 'restart', UNITS.agent] },
    ],
    interactive,
  );
  writeUnattended(d.paths.agentDir, { ...s, bundle: bundleId, updatedAt: new Date().toISOString() });
  d.log(`Unattended agent updated to ${bundleId}`);
}

export async function uninstallUnattended(d: AgentDeps, o: { keepHost?: boolean; purgeProfiles?: boolean; interactiveSudo?: boolean; layout?: NodeLayout }): Promise<void> {
  const s = readUnattended(d.paths.agentDir);
  if (!s) throw new Error('No unattended node is installed here.');
  runPrivileged(d, uninstallSteps({ purgeProfiles: !!o.purgeProfiles }, o.layout ?? DEFAULT_LAYOUT), o.interactiveSudo !== false);
  if (!o.keepHost) {
    try {
      await d.api().delete(`/fleet/hosts/${s.hostId}`);
      d.log(`Host ${s.hostId.slice(0, 8)} revoked in Fleet`);
    } catch (e) {
      d.log(`Could not revoke the host in Fleet (${e instanceof Error ? e.message : String(e)}); revoke it on the Fleet page.`);
    }
  }
  rmSync(join(d.paths.agentDir, 'unattended.json'), { force: true });
  d.log(o.purgeProfiles ? 'The unattended node and its profiles are removed' : 'The unattended node is removed (its browser profiles stay; --purge-profiles deletes them)');
}

/** An attended (user service) agent is installed here. */
export function agentStatusInstalled(d: AgentDeps): boolean {
  return readState(d.paths) !== null;
}

/** Downloads, verifies and activates a bundle (for an unattended-only machine's update). */
export async function fetchAndActivate(d: AgentDeps, o: { bundle?: string; version?: string }): Promise<void> {
  activate(d.paths, await fetchBundle(d.paths, o, d.fetch, d.log));
}

export type SessionKind = 'x11' | 'wayland' | 'none';

/** The person's graphical session, from the environment and logind. */
export function sessionKind(d: Pick<AgentDeps, 'exec'>, env: NodeJS.ProcessEnv = process.env): SessionKind {
  const type = env.XDG_SESSION_TYPE ?? (env.XDG_SESSION_ID ? d.exec(['loginctl', 'show-session', env.XDG_SESSION_ID, '-p', 'Type', '--value']).stdout.trim() : '');
  if (type === 'wayland' || (env.WAYLAND_DISPLAY && !env.DISPLAY)) return 'wayland';
  if (type === 'x11' || env.DISPLAY) return 'x11';
  return 'none';
}

export const WAYLAND_HELP = [
  'Attended mode shares your live desktop, which Wayland does not allow; it needs an X11 session for now.',
  '  - On the login screen, choose your user, click the gear and pick "Ubuntu on Xorg"; or',
  '  - set WaylandEnable=false in /etc/gdm3/custom.conf and reboot.',
  'Then run `hexactra agent install --mode attended` again. (Unattended mode works on any session.)',
].join('\n');

function requireX11(d: AgentDeps, env: NodeJS.ProcessEnv = process.env): void {
  const kind = sessionKind(d, env);
  if (kind === 'wayland') throw new Error(WAYLAND_HELP);
  if (kind === 'none') throw new Error('Attended mode runs in your desktop session: run this from a terminal in your logged-in X11 desktop.');
}

/** x11vnc (screen sharing) and notify-send (the on-screen notice), with sudo if missing. */
function ensureAttendedTools(d: AgentDeps, interactive: boolean): void {
  const missing = ['x11vnc', 'libnotify-bin'].filter((p) => d.exec(['dpkg', '-s', p]).code !== 0);
  if (missing.length) runPrivileged(d, [{ what: `install ${missing.join(' and ')} (sharing your desktop while someone views it, and the notice)`, argv: ['apt-get', 'install', '-y', '--no-install-recommends', ...missing] }], interactive);
  // The agent's user service needs the session's DISPLAY: import it now and at every login.
  d.exec(['systemctl', '--user', 'import-environment', 'DISPLAY', 'XAUTHORITY']);
  const autostart = join(dirname(dirname(d.paths.unitDir)), 'autostart');
  mkdirSync(autostart, { recursive: true });
  writeFileSync(
    join(autostart, 'hexactra-session.desktop'),
    ['[Desktop Entry]', 'Type=Application', 'Name=Hexactra session', 'Comment=Gives the Hexactra agent this desktop session', 'Exec=systemctl --user import-environment DISPLAY XAUTHORITY', 'NoDisplay=true', 'X-GNOME-Autostart-enabled=true', ''].join('\n'),
  );
}
