import type { Command } from 'commander';
import type { CliCommandRegistration } from '@marinoscar/platform-cli/core';

import { consoleApi } from './console-api.js';
import { readStdinLine } from './inbox.js';

const out = (s: string): void => {
  process.stdout.write(`${s}\n`);
};

interface FabricConnectionView {
  configured: boolean;
  url: string | null;
  token: { hint: string; updatedAt: string } | null;
}
interface FabricConnectionTest {
  reachable: boolean;
  authenticated: boolean;
  version: string | null;
  latencyMs: number | null;
  hosts: number;
  onlineHosts: number;
  error: string | null;
}

function show(v: FabricConnectionView): void {
  if (!v.configured) return out('Not connected to a fabric (hexactra fabric set <url> --token-stdin).');
  out(`url    ${v.url}`);
  out(`token  …${v.token?.hint ?? ''} (changed ${v.token?.updatedAt ?? 'never'})`);
}

/**
 * `hexactra fabric …`: the Hexactra Fabric control plane this console drives
 * (Admin → Settings → Fabric on the web). The service token is write-only and
 * is read from stdin, never from an argument.
 */
export const fabricCommand: CliCommandRegistration = (program: Command) => {
  const fabric = program.command('fabric').description('The fabric connection (admin)');
  fabric
    .command('show')
    .option('--json', 'print JSON')
    .action(async (o: { json?: boolean }) => {
      const v = await consoleApi().get<FabricConnectionView>('/fabric/connection');
      if (o.json) return out(JSON.stringify(v, null, 2));
      show(v);
    });
  fabric
    .command('test')
    .description('Probe the stored connection: health, then an authenticated host list')
    .option('--json', 'print JSON')
    .action(async (o: { json?: boolean }) => {
      const t = await consoleApi().post<FabricConnectionTest>('/fabric/connection/test', {});
      if (o.json) out(JSON.stringify(t, null, 2));
      else if (t.error) out(`failed: ${t.error}`);
      else out(`ok: fabric ${t.version ?? '?'} in ${t.latencyMs ?? '?'} ms, ${t.onlineHosts}/${t.hosts} hosts online`);
      if (t.error) process.exitCode = 1;
    });
  fabric
    .command('set <url>')
    .description('Set the fabric URL, and the hxs_ service token with --token-stdin')
    .option('--token-stdin', 'read the service token from stdin')
    .action(async (url: string, o: { tokenStdin?: boolean }) => {
      const token = o.tokenStdin ? await readStdinLine() : undefined;
      show(await consoleApi().put<FabricConnectionView>('/fabric/connection', { url, ...(token ? { token } : {}) }));
    });
  fabric
    .command('clear')
    .description('Forget the URL and the token')
    .option('--yes', 'confirm')
    .action(async (o: { yes?: boolean }) => {
      if (!o.yes) throw new Error('This disconnects the console from its browsers: pass --yes.');
      await consoleApi().delete('/fabric/connection');
      out('disconnected');
    });
};
