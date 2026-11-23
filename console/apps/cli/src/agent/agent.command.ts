import { Option, type Command } from 'commander';
import type { CliCommandRegistration } from '@marinoscar/platform-cli/core';

import { consoleApi } from '../console-api.js';
import { dependencyLines, dependencyReport, installedModes, installMissing, type InstallMode } from './dependencies.js';
import { chromeSetup, chromeStatus, chromeStatusLines } from './googleChrome.js';
import { installChoice, uninstallTarget } from './lifecycle.js';
import {
  installUnattended,
  uninstallUnattended,
  unattendedControl,
  unattendedLogs,
  unattendedStatus,
  type UnattendedStatus,
  agentDoctor,
  agentLogs,
  agentStatus,
  defaultDeps,
  installAgent,
  runAgentForeground,
  sandboxAgain,
  serviceControl,
  uninstallAgent,
  type AgentStatus,
} from './agent.js';
import { updateEverything } from './update.js';

const out = (s: string): void => {
  process.stdout.write(`${s}\n`);
};
const deps = () => defaultDeps((line) => out(`  ${line}`), () => consoleApi());
const int = (v: string) => Number.parseInt(v, 10);

/** The unattended node's lines for `agent status` (and the TUI). */
export function unattendedLines(u: UnattendedStatus): string[] {
  if (!u.state) return [];
  const s = u.state;
  return [
    '',
    `Unattended: ${s.name} (${s.hostId.slice(0, 8)}), desktop :${s.display} ${s.resolution}, user hexactra`,
    `Graphics:   ${s.gpu ? `${s.gpu.driver} (${s.gpu.renderNode})` : 'software rendering (no Intel or AMD GPU found)'}`,
    `Units:      ${Object.entries(u.units).map(([k, v]) => `${k.replace('.service', '')} ${v}`).join(', ')}`,
  ];
}

const mode = (v: string | undefined): 'attended' | 'unattended' => {
  if (v === undefined || v === 'attended') return 'attended';
  if (v === 'unattended') return 'unattended';
  throw new Error(`--mode must be attended or unattended (got ${v})`);
};

const installMode = (v: string | undefined): 'default' | 'attended' | 'unattended' | 'both' => {
  if (v === undefined) return 'default';
  if (v === 'attended' || v === 'unattended' || v === 'both') return v;
  throw new Error(`--mode must be attended, unattended or both (got ${v})`);
};

/** One readable block for `agent status` (and the TUI). */
export function statusLines(s: AgentStatus): string[] {
  if (!s.installed || !s.state) return ['No agent is installed on this machine. Run `hexactra agent install`.'];
  const st = s.state;
  return [
    `Host:     ${st.name} (${st.hostId.slice(0, 8)})`,
    `Fabric:   ${st.agentUrl}`,
    `Agent:    ${st.version} (${st.commit.slice(0, 7)})`,
    `Browser:  ${st.browserKind === 'chrome-for-testing' ? `Chrome for Testing ${st.chromeVersion}` : st.browserKind === 'google-chrome' ? `Google Chrome ${st.chromeVersion ?? ''} (extension by policy)`.replace('  ', ' ') : st.browser}${st.sandboxHelper ? ' (setuid sandbox)' : ''}`,
    `Service:  ${st.service ? `${s.service?.active ?? 'unknown'} (${s.service?.sub ?? 'unknown'})` : 'none (run with `hexactra agent run`)'}`,
    `Fleet:    ${s.fleet ? `${s.fleet.online ? 'online' : 'offline'}${s.fleet.browserConnected ? ', browser connected' : ''}` : (s.fleetError ?? 'unknown')}`,
  ];
}

/**
 * `hexactra agent …`: make THIS machine a browser host and manage it. No
 * script, no source build: the CLI downloads and verifies the agent bundle,
 * installs Chrome for Testing when no browser is given, enrolls through your
 * console login and runs a systemd user service.
 */
export const agentCommand: CliCommandRegistration = (program: Command) => {
  const agent = program.command('agent').description('Run this machine as a browser host (install, status, logs, update, uninstall)');

  agent
    .command('install')
    .description('Install the agent on this machine, enroll it and start it')
    .option('--name <name>', 'host name in Fleet (default: this machine\'s hostname)')
    .option('--browser <path>', 'use this browser instead of downloading Chrome for Testing (must load unpacked extensions)')
    .option('--max-browsers <n>', 'profiles open at once (300-600 MB each)', int)
    .option('--bundle <file|url>', 'agent bundle to install (default: the latest release)')
    .option('--version <version>', 'agent release to install (default: latest)')
    .option('--no-service', 'do not create the systemd user service (run it with `hexactra agent run`)')
    .option('--no-desktop', 'start with the user manager instead of the desktop session')
    .option('--reenroll', 'enroll as a new host even if this machine is enrolled')
    .option('--enrollment-token <hxe>', 'join with a token an admin minted (Fleet → Enroll host) instead of your login')
    .option('--agent-url <url>', 'the fabric URL for --enrollment-token (the enroll command prints it)')
    .option('--wait <seconds>', 'how long to wait for the host to come online', int)
    .option('--google-chrome', 'use Google Chrome, with the extension installed by policy (one sudo step)')
    .option('--mode <mode>', 'attended (your own Google Chrome and X11 desktop), unattended (its own desktop from boot, user hexactra) or both')
    .option('--resolution <WxH>', 'unattended: the desktop size (default 1920x1080)')
    .addOption(new Option('--extension-update-url <url>', 'where the Chrome policy gets the extension (a test mirror)').hideHelp())
    .action(async (o: { mode?: string; resolution?: string; googleChrome?: boolean; extensionUpdateUrl?: string; name?: string; browser?: string; maxBrowsers?: number; bundle?: string; version?: string; service?: boolean; desktop?: boolean; reenroll?: boolean; enrollmentToken?: string; agentUrl?: string; wait?: number }) => {
      const m = installMode(o.mode);
      const done = await installChoice(deps(), m, {
        name: o.name,
        browser: o.browser,
        maxBrowsers: o.maxBrowsers,
        bundle: o.bundle,
        version: o.version,
        service: o.service,
        noDesktop: o.desktop === false,
        reenroll: o.reenroll,
        enrollmentToken: o.enrollmentToken ?? process.env.HEXACTRA_ENROLLMENT_TOKEN,
        agentUrl: o.agentUrl,
        interactiveSudo: true,
        waitSeconds: o.wait,
        googleChrome: o.googleChrome,
        extensionUpdateUrl: o.extensionUpdateUrl ?? process.env.HEXACTRA_EXTENSION_UPDATE_URL,
        resolution: o.resolution,
      });
      for (const line of done) out(`Done: ${line}`);
    });

  agent
    .command('status')
    .description('Show the agent on this machine: version, browser, service and Fleet state')
    .option('--json', 'print JSON')
    .action(async (o: { json?: boolean }) => {
      const s = await agentStatus(deps());
      const u = unattendedStatus(deps());
      if (o.json) return out(JSON.stringify({ ...s, unattended: u }, null, 2));
      for (const line of u.installed && !s.installed ? unattendedLines(u).slice(1) : [...statusLines(s), ...unattendedLines(u)]) out(line);
    });

  agent
    .command('logs')
    .description("Show the agent service's log")
    .option('-n, --lines <n>', 'lines to show', int, 100)
    .option('-f, --follow', 'keep printing new lines')
    .option('--mode <mode>', 'attended (default) or unattended')
    .action((o: { lines: number; follow?: boolean; mode?: string }) => {
      const r = mode(o.mode) === 'unattended' ? unattendedLogs(deps(), o.lines, !!o.follow) : agentLogs(deps(), o.lines, !!o.follow);
      if (!o.follow) process.stdout.write(r.stdout || r.stderr);
    });

  agent
    .command('update')
    .description('Update everything on this node to the latest release: the agent, the extension (Chrome is restarted, its tabs restored) and the unattended node; then check what runs')
    .option('--bundle <file|url>', 'agent bundle to install')
    .option('--version <version>', 'agent release to install')
    .option('--force', 'reinstall even when up to date')
    .action(async (o: { bundle?: string; version?: string; force?: boolean }) => {
      await updateEverything(deps(), o);
    });

  for (const action of ['start', 'stop', 'restart'] as const) {
    agent
      .command(action)
      .description(`${action[0]!.toUpperCase()}${action.slice(1)} the agent service (--mode unattended: the node's desktop and agent, with sudo)`)
      .option('--mode <mode>', 'attended (default) or unattended')
      .action((o: { mode?: string }) => (mode(o.mode) === 'unattended' ? unattendedControl(deps(), action) : serviceControl(deps(), action)));
  }

  agent
    .command('run')
    .description('Run the installed agent in the foreground (no service; for servers and CI)')
    .action(() => {
      process.exitCode = runAgentForeground(deps());
    });

  agent
    .command('sandbox')
    .description("Install Chrome's sandbox helper with sudo (needed once on Ubuntu 23.10 and later)")
    .action(() => sandboxAgain(deps()));

  const chrome = agent.command('chrome').description('Google Chrome on this machine: install it, force-install the extension by policy, register the native host');
  chrome
    .command('status')
    .description('Show Google Chrome, the extension policy and the native host on this machine')
    .option('--json', 'print JSON')
    .action((o: { json?: boolean }) => {
      const s = chromeStatus(deps());
      if (o.json) return out(JSON.stringify(s, null, 2));
      for (const line of chromeStatusLines(s)) out(line);
    });
  chrome
    .command('setup')
    .description('Install Google Chrome if needed, write the extension policy and register the native host (asks for sudo once)')
    .addOption(new Option('--extension-update-url <url>', 'where the Chrome policy gets the extension (a test mirror)').hideHelp())
    .action(async (o: { extensionUpdateUrl?: string }) => {
      const s = await chromeSetup(deps(), { interactive: true, updateUrl: o.extensionUpdateUrl ?? process.env.HEXACTRA_EXTENSION_UPDATE_URL });
      for (const line of chromeStatusLines(s)) out(line);
    });

  agent
    .command('doctor')
    .description('Check everything this machine needs as a browser host, and say how to fix what is wrong')
    .option('--json', 'print JSON')
    .action(async (o: { json?: boolean }) => {
      const checks = await agentDoctor(deps());
      if (o.json) out(JSON.stringify(checks, null, 2));
      else for (const c of checks) out(`${!c.ok ? 'FAIL' : c.warning ? 'warn' : 'ok  '}  ${c.name.padEnd(22)} ${c.detail}`);
      if (checks.some((c) => !c.ok)) process.exitCode = 1;
    });

  agent
    .command('deps')
    .description('List the packages this machine needs as a browser host, installed or missing (--install adds the missing ones)')
    .option('--mode <mode>', 'default, attended or unattended (default: the modes installed here, or all)')
    .option('--install', 'install the missing packages (sudo)')
    .option('--json', 'print JSON')
    .action((o: { mode?: string; install?: boolean; json?: boolean }) => {
      const d = deps();
      if (o.mode !== undefined && !['default', 'attended', 'unattended'].includes(o.mode)) throw new Error(`--mode must be default, attended or unattended (got ${o.mode})`);
      const modes = o.mode ? [o.mode as InstallMode] : installedModes(d);
      let rows = dependencyReport(d, modes);
      if (o.install) {
        installMissing(d, rows, true);
        rows = dependencyReport(d, modes);
      }
      if (o.json) return out(JSON.stringify(rows, null, 2));
      out(`Packages for: ${modes.join(', ')}`);
      for (const line of dependencyLines(rows)) out(line);
      if (rows.some((r) => !r.installed)) process.exitCode = 1;
    });

  agent
    .command('uninstall')
    .description('Stop and remove the agent, and revoke this host in Fleet')
    .option('--keep-host', 'keep the host in Fleet')
    .option('--purge-profiles', 'also delete the browser profiles (they hold sign-ins)')
    .option('--yes', 'confirm')
    .option('--mode <mode>', 'attended (default) or unattended')
    .action(async (o: { keepHost?: boolean; purgeProfiles?: boolean; yes?: boolean; mode?: string }) => {
      if (!o.yes) throw new Error('Uninstalling stops this host and revokes it in Fleet; pass --yes.');
      await uninstallTarget(deps(), mode(o.mode) === 'unattended' ? 'node' : 'agent', o);
    });
};
