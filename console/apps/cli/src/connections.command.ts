import type { Command } from 'commander';
import type { CliCommandRegistration } from '@marinoscar/platform-cli/core';

import { consoleApi } from './console-api.js';

/** A connection as `GET /api/connections` returns it: capability names, never a token or a scope string. */
export interface ConnectionView {
  id: string;
  provider: 'google' | 'microsoft' | 'mcp';
  label: string;
  accountEmail: string;
  accountName: string | null;
  capabilities: string[];
  granted: string[];
  defaultFor: string[];
  status: 'active' | 'paused' | 'needs_reconnect' | 'revoked';
  statusReason: string | null;
  lastUsedAt: string | null;
  /** An MCP server (`provider: mcp`): where it points, how it signs in and what its tools stand at. */
  mcp?: { url: string; auth: string; serverName: string | null; tools: { total: number; enabled: number; needsReview: number } };
}

/** A tool of an MCP server as `GET /api/connections/{id}/tools` returns it. */
export interface McpToolView {
  id: string;
  name: string;
  title: string | null;
  description: string;
  suggested: 'read' | 'write';
  mode: 'off' | 'read' | 'write';
  review: 'new' | 'changed' | null;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const out = (s: string): void => {
  process.stdout.write(`${s}\n`);
};

/** `mail (read, send)`, `calendar (read)`: the capabilities grouped the way the page shows them. */
export function capabilitiesText(caps: readonly string[]): string {
  const groups: [string, string][] = [
    ['mail', 'mail'],
    ['calendar', 'calendar'],
    ['docs', 'documents'],
  ];
  const parts: string[] = [];
  for (const [prefix, name] of groups) {
    const read = caps.includes(`${prefix}_read`);
    const write = caps.includes(prefix === 'mail' ? 'mail_send' : `${prefix}_write`);
    const organize = prefix === 'mail' && caps.includes('mail_modify');
    if (read || write || organize) {
      const what = ['read', ...(write ? [prefix === 'mail' ? 'send' : 'write'] : []), ...(organize ? ['organize'] : [])];
      parts.push(`${name} (${what.join(', ')})`);
    }
  }
  return parts.length > 0 ? parts.join(', ') : 'nothing switched on';
}

/** The list line: id prefix, provider, label, account, what it can do, flags. */
export function connectionLine(c: ConnectionView): string {
  const what = c.mcp ? `${c.mcp.tools.enabled} of ${c.mcp.tools.total} tools on${c.mcp.tools.needsReview > 0 ? `, ${c.mcp.tools.needsReview} to review` : ''}` : capabilitiesText(c.capabilities);
  const flags = [c.status !== 'active' ? `${c.status.replace('_', ' ')}${c.statusReason ? ` (${c.statusReason})` : ''}` : null, c.defaultFor.length > 0 ? `default for ${c.defaultFor.join(', ')}` : null].filter(Boolean).join('; ');
  return `${c.id.slice(0, 8)}  ${c.provider.padEnd(9)}  ${c.label.padEnd(24)}  ${c.accountEmail.padEnd(28)}  ${what}${flags ? `  [${flags}]` : ''}`;
}

/** A connection by full id, id prefix or exact label (ignoring case). */
export async function findConnection(ref: string): Promise<ConnectionView> {
  const api = consoleApi();
  if (UUID.test(ref)) return api.get<ConnectionView>(`/connections/${ref}`);
  const all = await api.get<ConnectionView[]>('/connections');
  const matches = all.filter((c) => c.id.startsWith(ref) || c.label.toLowerCase() === ref.toLowerCase());
  if (matches.length === 1) return matches[0]!;
  if (matches.length > 1) throw new Error(`"${ref}" matches several connections; use the id`);
  throw new Error(`No connection matches "${ref}". Run \`connections list\`.`);
}

/** `hexactra connections …` over /api/connections: your connected Google and Microsoft accounts. Connecting is done in the web app (it needs a browser). */
export const connectionsCommand: CliCommandRegistration = (program: Command) => {
  const connections = program.command('connections').description('Connections: your Google and Microsoft accounts and MCP servers (connect them in the web app: Settings → Connections)');
  connections
    .command('list')
    .description('Your connected accounts: label, account, what each may do, status')
    .option('--json', 'print JSON')
    .action(async (o: { json?: boolean }) => {
      const list = await consoleApi().get<ConnectionView[]>('/connections');
      if (o.json) return out(JSON.stringify(list, null, 2));
      if (list.length === 0) return out('No connected accounts. Connect one in the web app: Settings → Connections.');
      for (const c of list) out(connectionLine(c));
    });
  connections
    .command('test <connection>')
    .description('Make one cheap read call per capability that is on (id, id prefix or label)')
    .option('--json', 'print JSON')
    .action(async (ref: string, o: { json?: boolean }) => {
      const c = await findConnection(ref);
      const r = await consoleApi().post<{ results: { capability: string; ok: boolean; code: string | null }[] }>(`/connections/${c.id}/test`, {});
      if (o.json) return out(JSON.stringify(r, null, 2));
      for (const x of r.results) out(`${x.ok ? 'ok  ' : 'FAIL'}  ${x.capability}${x.code ? `  (${x.code})` : ''}`);
      if (r.results.length === 0) out(c.provider === 'mcp' ? 'The server answered and listed its tools.' : 'Nothing is switched on for this connection.');
      if (r.results.some((x) => !x.ok)) process.exitCode = 1;
    });
  connections
    .command('tools <connection>')
    .description('The tools of an MCP server and what you decided for each (off, read, write); --refresh lists them again (changed or new tools are off until you review them in the web app)')
    .option('--refresh', 'ask the server for its tools again first')
    .option('--json', 'print JSON')
    .action(async (ref: string, o: { refresh?: boolean; json?: boolean }) => {
      const c = await findConnection(ref);
      if (c.provider !== 'mcp') throw new Error(`${c.label} is not an MCP server`);
      const api = consoleApi();
      const r = o.refresh ? await api.post<{ tools: McpToolView[]; needsReview: number }>(`/connections/${c.id}/tools/refresh`, {}) : await api.get<{ tools: McpToolView[]; needsReview: number }>(`/connections/${c.id}/tools`);
      if (o.json) return out(JSON.stringify(r, null, 2));
      if (r.tools.length === 0) return out('The server lists no tools.');
      for (const t of r.tools) out(`${t.mode.padEnd(5)}  ${t.name.padEnd(32)}  ${t.review ? `[${t.review}: review in the web app]  ` : ''}suggested ${t.suggested}${t.title ? `  ${t.title}` : ''}`);
      if (r.needsReview > 0) out(`${r.needsReview} tool${r.needsReview === 1 ? '' : 's'} to review: Settings → Connections.`);
    });
  connections
    .command('pause <connection>')
    .description('Pause a connection: nothing uses it until it is resumed (id, id prefix or label)')
    .action(async (ref: string) => {
      const c = await findConnection(ref);
      await consoleApi().post(`/connections/${c.id}/pause`, {});
      out(`paused ${c.label}`);
    });
  connections
    .command('resume <connection>')
    .description('Resume a paused connection (id, id prefix or label)')
    .action(async (ref: string) => {
      const c = await findConnection(ref);
      await consoleApi().post(`/connections/${c.id}/resume`, {});
      out(`resumed ${c.label}`);
    });
  connections
    .command('rm <connection>')
    .description('Disconnect an account: revoke it at the provider, delete its tokens, clear what references it (id, id prefix or label)')
    .action(async (ref: string) => {
      const c = await findConnection(ref);
      const r = await consoleApi().delete<{ revoked: boolean; clearedReferences: number }>(`/connections/${c.id}`);
      out(`disconnected ${c.label}${r && r.revoked === false ? ' (the provider could not be asked: remove the app in its account settings)' : ''}`);
    });
};
