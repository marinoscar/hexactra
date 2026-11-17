import type { Command } from 'commander';
import type { CliCommandRegistration } from '@marinoscar/platform-cli/core';

import { bundledHostOff, bundledHostOn, bundledHostStatus, deploymentRoot, realExec } from './bundled-host.js';

const out = (s: string): void => {
  process.stdout.write(`${s}\n`);
};

/**
 * `hexactra deploy bundled-host status|on|off` (#386): the browser host the
 * VPS stack bundles. It browses from the server's datacenter IP, so most
 * deployments keep it off and use home nodes (docs/nodes.md). Runs on the
 * server, next to the deployment (docker access needed).
 */
export const bundledHostCommand: CliCommandRegistration = (program: Command) => {
  const parent = program.commands.find((c) => c.name() === 'deploy') ?? program.command('deploy');
  const cmd = parent.command('bundled-host').description('Turn the bundled VPS browser host on or off (runs on the server)');
  const deps = () => ({ exec: realExec, log: out });
  cmd
    .command('status')
    .option('--root <dir>', 'the deployment (default: the one under /opt/infra/apps)')
    .action((o: { root?: string }) => {
      const s = bundledHostStatus(deps(), deploymentRoot(o.root));
      out(`bundled host: ${s.setting}, container ${s.running ? 'running' : 'not running'}`);
    });
  cmd
    .command('off')
    .description('Stop and remove the bundled host; it stays off across updates')
    .option('--root <dir>', 'the deployment (default: the one under /opt/infra/apps)')
    .action((o: { root?: string }) => bundledHostOff(deps(), deploymentRoot(o.root)));
  cmd
    .command('on')
    .description('Start the bundled host; it stays on across updates')
    .option('--root <dir>', 'the deployment (default: the one under /opt/infra/apps)')
    .action((o: { root?: string }) => bundledHostOn(deps(), deploymentRoot(o.root)));
};
