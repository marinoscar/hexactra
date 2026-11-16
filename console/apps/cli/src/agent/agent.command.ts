import type { Command } from 'commander';
import type { CliCommandRegistration } from '@marinoscar/platform-cli/core';

import { consoleApi } from '../console-api.js';
import {
  agentLogs,
  agentStatus,
  defaultDeps,
  installAgent,
  runAgentForeground,
  sandboxAgain,
  serviceControl,
  uninstallAgent,
  updateAgent,
  type AgentStatus,
} from './agent.js';

const out = (s: string): void => {
  process.stdout.write(`${s}\n`);
};
const deps = () => defaultDeps((line) => out(`  ${line}`), () => consoleApi());
const int = (v: string) => Number.parseInt(v, 10);

/** One readable block for `agent status` (and the TUI). */
export function statusLines(s: AgentStatus): string[] {
  if (!s.installed || !s.state) return ['No agent is installed on this machine. Run `hexactra agent install`.'];
  const st = s.state;
  return [
    `Host:     ${st.name} (${st.hostId.slice(0, 8)})`,
    `Fabric:   ${st.agentUrl}`,
    `Agent:    ${st.version} (${st.commit.slice(0, 7)})`,
    `Browser:  ${st.browserKind === 'chrome-for-testing' ? `Chrome for Testing ${st.chromeVersion}` : st.browser}${st.sandboxHelper ? ' (setuid sandbox)' : ''}`,
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
    .action(async (o: { name?: string; browser?: string; maxBrowsers?: number; bundle?: string; version?: string; service?: boolean; desktop?: boolean; reenroll?: boolean; enrollmentToken?: string; agentUrl?: string; wait?: number }) => {
      out('Installing the Hexactra agent on this machine');
      const s = await installAgent(deps(), {
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
      });
      out(`Done: "${s.name}" is a browser host. Create profiles for it on the Fleet page or with \`hexactra fleet profile create\`.`);
    });

  agent
    .command('status')
    .description('Show the agent on this machine: version, browser, service and Fleet state')
    .option('--json', 'print JSON')
    .action(async (o: { json?: boolean }) => {
      const s = await agentStatus(deps());
      if (o.json) return out(JSON.stringify(s, null, 2));
      for (const line of statusLines(s)) out(line);
    });

  agent
    .command('logs')
    .description("Show the agent service's log")
    .option('-n, --lines <n>', 'lines to show', int, 100)
    .option('-f, --follow', 'keep printing new lines')
    .action((o: { lines: number; follow?: boolean }) => {
      const r = agentLogs(deps(), o.lines, !!o.follow);
      if (!o.follow) process.stdout.write(r.stdout || r.stderr);
    });

  agent
    .command('update')
    .description('Update the agent (and Chrome for Testing) to the latest release and restart it')
    .option('--bundle <file|url>', 'agent bundle to install')
    .option('--version <version>', 'agent release to install')
    .option('--force', 'reinstall even when up to date')
    .action(async (o: { bundle?: string; version?: string; force?: boolean }) => {
      await updateAgent(deps(), o);
    });

  for (const action of ['start', 'stop', 'restart'] as const) {
    agent
      .command(action)
      .description(`${action[0]!.toUpperCase()}${action.slice(1)} the agent service`)
      .action(() => serviceControl(deps(), action));
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

  agent
    .command('uninstall')
    .description('Stop and remove the agent, and revoke this host in Fleet')
    .option('--keep-host', 'keep the host in Fleet')
    .option('--purge-profiles', 'also delete the browser profiles (they hold sign-ins)')
    .option('--yes', 'confirm')
    .action(async (o: { keepHost?: boolean; purgeProfiles?: boolean; yes?: boolean }) => {
      if (!o.yes) throw new Error('Uninstalling stops this host and revokes it in Fleet; pass --yes.');
      await uninstallAgent(deps(), o);
    });
};
