import type { Command } from 'commander';
import type { CliCommandRegistration } from '@marinoscar/platform-cli/core';

import { consoleApi, consoleWebUrl } from './console-api.js';
import { desktopUrl, findHost, hostLine, type FleetCommandResult, type FleetEnrollment, type FleetHost } from './fleet.js';

const out = (s: string): void => {
  process.stdout.write(`${s}\n`);
};
const json = (v: unknown): void => out(JSON.stringify(v, null, 2));

async function hostId(ref: string): Promise<string> {
  return findHost(await consoleApi().get<FleetHost[]>('/fleet/hosts'), ref).id;
}

function done(r: FleetCommandResult, asJson: boolean) {
  if (asJson) json(r);
  else out(`${r.kind}${r.profile ? ` ${r.profile}` : ''}: ${r.state}`);
}

/**
 * `hexactra fleet …`: the browser hosts and profiles, through the console API
 * (`/api/fleet`, `fleet:read` / `fleet:write`). Hosts are named by name, id
 * or id prefix.
 */
export const fleetCommand: CliCommandRegistration = (program: Command) => {
  const fleet = program.command('fleet').description('Browser hosts and profiles (the Fleet page)');

  fleet
    .command('hosts')
    .description('List hosts with their profiles (* = browser running)')
    .option('--json', 'print JSON')
    .action(async (o: { json?: boolean }) => {
      const hosts = await consoleApi().get<FleetHost[]>('/fleet/hosts');
      if (o.json) return json(hosts);
      if (!hosts.length) return out('No host is enrolled. Add one with `hexactra fleet enroll`.');
      for (const h of hosts) out(`${h.id.slice(0, 8)}  ${hostLine(h)}`);
    });

  fleet
    .command('enroll')
    .description('Create a single-use enrollment token and print the agent command')
    .option('--name <name>', 'name for the new host')
    .option('--agent-url <url>', 'the fabric URL as the new host reaches it')
    .option('--ttl-minutes <n>', 'token lifetime', (v) => Number.parseInt(v, 10))
    .option('--json', 'print JSON')
    .action(async (o: { name?: string; agentUrl?: string; ttlMinutes?: number; json?: boolean }) => {
      const e = await consoleApi().post<FleetEnrollment>('/fleet/enrollments', {
        ...(o.name ? { name: o.name } : {}),
        ...(o.agentUrl ? { agentUrl: o.agentUrl } : {}),
        ...(o.ttlMinutes ? { ttlMinutes: o.ttlMinutes } : {}),
      });
      if (o.json) return json(e);
      out('Run this on the new host (the token works once):');
      out(`  ${e.command}`);
    });

  fleet
    .command('revoke <host>')
    .description('Revoke a host: its credential stops working and its sessions end')
    .option('--yes', 'confirm')
    .action(async (ref: string, o: { yes?: boolean }) => {
      if (!o.yes) throw new Error('Revoking a host ends its sessions; pass --yes.');
      await consoleApi().delete(`/fleet/hosts/${await hostId(ref)}`);
      out('revoked');
    });

  // disable/enable (#385); drain/undrain are the older names of the same switch.
  const toggles = [
    ['disable', true, 'Disable a host: it takes no new runs (runs in progress finish)'],
    ['enable', false, 'Enable a disabled host again'],
    ['drain', true, 'Same as disable'],
    ['undrain', false, 'Same as enable'],
  ] as const;
  for (const [name, enabled, description] of toggles) {
    fleet
      .command(`${name} <host>`)
      .description(description)
      .option('--json', 'print JSON')
      .action(async (ref: string, o: { json?: boolean }) => {
        done(await consoleApi().post<FleetCommandResult>(`/fleet/hosts/${await hostId(ref)}/drain`, { enabled }), Boolean(o.json));
      });
  }

  fleet
    .command('commands <host>')
    .description('Recent host commands')
    .option('--json', 'print JSON')
    .action(async (ref: string, o: { json?: boolean }) => {
      const list = await consoleApi().get<FleetCommandResult[]>(`/fleet/hosts/${await hostId(ref)}/commands`);
      if (o.json) return json(list);
      for (const c of list) out(`${c.createdAt}  ${c.kind}  ${c.profile ?? '-'}  ${c.state}${c.error ? `  ${c.error}` : ''}`);
    });

  fleet
    .command('desktop <host>')
    .description("Print the console link to a host's remote desktop (it opens in the web or Android app; needs fleet:desktop)")
    .option('--json', 'print JSON')
    .action(async (ref: string, o: { json?: boolean }) => {
      const h = findHost(await consoleApi().get<FleetHost[]>('/fleet/hosts'), ref);
      if (!h.desktop) throw new Error(`${h.name} does not share a desktop. Unattended nodes do; attended nodes need X11.`);
      const url = desktopUrl(consoleWebUrl(), h.id);
      if (o.json) return json({ hostId: h.id, name: h.name, online: h.online, url });
      out(url);
      if (!h.online) out(`(${h.name} is offline right now)`);
    });

  fleet
    .command('takeover <host>')
    .description('Take control of a host\'s desktop: its agent pauses for 5 minutes (until you release it); use the desktop from the console')
    .option('--json', 'print JSON')
    .action(async (ref: string, o: { json?: boolean }) => {
      const h = findHost(await consoleApi().get<FleetHost[]>('/fleet/hosts'), ref);
      const l = await consoleApi().post<{ leaseId: string; expiresAt: string }>(`/fleet/hosts/${h.id}/takeover`, {});
      if (o.json) return json(l);
      out(`You control ${h.name} until ${l.expiresAt}; its agent is paused. Release it with \`hexactra fleet release ${h.name}\`.`);
    });

  fleet
    .command('release <host>')
    .description('Give a host\'s desktop back to its agent')
    .action(async (ref: string) => {
      const h = findHost(await consoleApi().get<FleetHost[]>('/fleet/hosts'), ref);
      const l = await consoleApi().get<{ leaseId: string } | null>(`/fleet/hosts/${h.id}/takeover`);
      if (!l) return out(`Nobody controls ${h.name}; its agent runs.`);
      await consoleApi().delete(`/fleet/hosts/${h.id}/takeover/${l.leaseId}`);
      out(`Released ${h.name}; its agent continues.`);
    });

  const profile = fleet.command('profile').description('Profiles on a host');
  const profileAction = (verb: 'create' | 'delete' | 'restart' | 'close') => async (ref: string, name: string, o: { json?: boolean; yes?: boolean }) => {
    const id = await hostId(ref);
    const api = consoleApi();
    let r: FleetCommandResult;
    if (verb === 'create') r = await api.post(`/fleet/hosts/${id}/profiles`, { name });
    else if (verb === 'delete') {
      if (!o.yes) throw new Error(`Deleting profile "${name}" removes its cookies and sign-ins; pass --yes.`);
      r = await api.delete(`/fleet/hosts/${id}/profiles/${encodeURIComponent(name)}`);
    } else r = await api.post(`/fleet/hosts/${id}/profiles/${encodeURIComponent(name)}/${verb}`, {});
    done(r, Boolean(o.json));
  };
  profile.command('create <host> <name>').description('Create an empty (signed-out) profile').option('--json').action(profileAction('create'));
  profile.command('delete <host> <name>').description('Delete a profile and its sign-ins').option('--yes', 'confirm').option('--json').action(profileAction('delete'));
  profile.command('restart <host> <name>').description("Restart the profile's browser").option('--json').action(profileAction('restart'));
  profile
    .command('show <host> <name>')
    .description("Open the profile's browser on the host's desktop, at the Google sign-in (or --url), to sign in through the remote desktop")
    .option('--url <url>', 'the page to open instead of the Google sign-in')
    .option('--json')
    .action(async (ref: string, name: string, o: { url?: string; json?: boolean }) => {
      const h = findHost(await consoleApi().get<FleetHost[]>('/fleet/hosts'), ref);
      const r = await consoleApi().post<FleetCommandResult>(`/fleet/hosts/${h.id}/profiles/${encodeURIComponent(name)}/show`, o.url ? { url: o.url } : {});
      done(r, !!o.json);
      if (!o.json && r.state === 'succeeded') out(`Now sign in on the desktop: ${desktopUrl(consoleWebUrl(), h.id)}`);
    });
  profile.command('close <host> <name>').description("Close the profile's browser").option('--json').action(profileAction('close'));
};
