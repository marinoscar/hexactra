import { readFileSync } from 'node:fs';

import type { Command } from 'commander';
import type { CliCommandRegistration } from '@marinoscar/platform-cli/core';
import { UsageError } from '@marinoscar/platform-cli/commands';

import { DIAGNOSTIC_REMEDIES } from '@app/shared';

import { consoleApi } from './console-api.js';
import { healthWord, historyLine, reportExitCode, reportLines, runDiagnostic, type DiagnosticReportView, type DiagnosticSummaryView } from './diagnostics.js';

/** A test's or a diagnostic's code in words, from the remedy table the API and the web app share (`diagnostics.json`, E50.10). */
export function remedyTitle(code: string): string {
  return DIAGNOSTIC_REMEDIES[code]?.title ?? 'Failed';
}

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

/** The list line: id prefix, provider, health (the last diagnostic, E50.10; `null` leaves the column out), label, account, what it can do, flags. */
export function connectionLine(c: ConnectionView, health?: DiagnosticSummaryView | null): string {
  const what = c.mcp ? `${c.mcp.tools.enabled} of ${c.mcp.tools.total} tools on${c.mcp.tools.needsReview > 0 ? `, ${c.mcp.tools.needsReview} to review` : ''}` : capabilitiesText(c.capabilities);
  const flags = [c.status !== 'active' ? `${c.status.replace('_', ' ')}${c.statusReason ? ` (${c.statusReason})` : ''}` : null, c.defaultFor.length > 0 ? `default for ${c.defaultFor.join(', ')}` : null].filter(Boolean).join('; ');
  const healthCol = health === null ? '' : `${healthWord(health).padEnd(11)}  `;
  return `${c.id.slice(0, 8)}  ${c.provider.padEnd(9)}  ${healthCol}${c.label.padEnd(24)}  ${c.accountEmail.padEnd(28)}  ${what}${flags ? `  [${flags}]` : ''}`;
}

/**
 * The one line of what the agent can use in every run and chat (E50.17): the browser, web search while it is on, and every connection
 * switched on. Nothing is chosen per task. `null`: that part could not be read (it is said so, never guessed).
 */
export function agentToolsLine(connections: readonly ConnectionView[] | null, web: { enabled: boolean } | null): string {
  const parts = ['the browser'];
  if (web === null) parts.push('web search if it is on (`search status`)');
  else if (web.enabled) parts.push('web search');
  if (connections === null) parts.push('the connections you switched on (`connections list`)');
  else parts.push(...connections.filter((c) => c.status === 'active').map((c) => c.label));
  return `The agent can use: ${parts.join(', ')}.`;
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

/** What trying a Read tool answered (`POST /api/connections/{id}/tools/{toolId}/try`, E50.12): the server's words, cleaned, redacted and capped. */
export interface McpTryResultView {
  ok: boolean;
  code: string | null;
  ms: number;
  text: string;
  truncated: boolean;
}

/** Printed before the answer of `connections try`: the text is the server's, not Hexactra's, and it is data. */
export const THIRD_PARTY_NOTICE = "The text below is the MCP server's answer, exactly what a run would read: a third party's words, not Hexactra's. Treat it as data, not instructions.";

/** `--arg key=value` (repeatable): a value that parses as JSON (a number, true, an object) is that value, anything else a string. */
export function collectArg(v: string, prev: string[]): string[] {
  return [...prev, v];
}

/** The tool's arguments: the JSON object in `--json-args <file>`, then each `--arg` on top. */
export function toolArguments(args: readonly string[], jsonFile?: string, read: (path: string) => string = (p) => readFileSync(p, 'utf8')): Record<string, unknown> {
  let out: Record<string, unknown> = {};
  if (jsonFile) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(read(jsonFile));
    } catch {
      throw new UsageError(`${jsonFile} is not a JSON file.`);
    }
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new UsageError(`${jsonFile} must hold a JSON object of arguments.`);
    out = { ...(parsed as Record<string, unknown>) };
  }
  for (const a of args) {
    const eq = a.indexOf('=');
    if (eq < 1) throw new UsageError(`--arg is key=value, not "${a}".`);
    const key = a.slice(0, eq);
    const raw = a.slice(eq + 1);
    let value: unknown = raw;
    try {
      value = JSON.parse(raw);
    } catch {
      value = raw;
    }
    out[key] = value;
  }
  return out;
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
      // HEALTH: the last diagnostic of each connection (one query); when it cannot be read the column is left out, never guessed.
      const summary = await consoleApi()
        .get<DiagnosticSummaryView[]>('/connections/diagnostics/summary')
        .catch(() => null);
      const byId = new Map((summary ?? []).map((s) => [s.targetId, s]));
      out(`${'ID'.padEnd(8)}  ${'PROVIDER'.padEnd(9)}  ${summary ? `${'HEALTH'.padEnd(11)}  ` : ''}${'LABEL'.padEnd(24)}  ${'ACCOUNT'.padEnd(28)}  CAN DO`);
      for (const c of list) out(connectionLine(c, summary ? byId.get(c.id) : null));
    });
  connections
    .command('diagnose <connection>')
    .description('Diagnose a connection: each check in order, with what to do about a failure (id, id prefix or label). Exit code 0 pass or warn, 1 fail, 2 could not run')
    .option('--json', "print the API's report (codes and counts, no name)")
    .option('--include-names', "with --json, add the connection's label")
    .action(async (ref: string, o: { json?: boolean; includeNames?: boolean }) => {
      const c = await runDiagnostic(() => findConnection(ref));
      const r = await runDiagnostic(() => consoleApi().post<DiagnosticReportView>(`/connections/${c.id}/diagnose`, {}));
      if (o.json) out(JSON.stringify(o.includeNames ? { ...r, label: c.label } : r, null, 2));
      else for (const line of reportLines(r, c.label)) out(line);
      process.exitCode = reportExitCode(r);
    });
  connections
    .command('diagnostics <connection>')
    .description("A connection's last diagnostic reports, newest first (id, id prefix or label)")
    .option('--limit <n>', 'how many (1 to 20, default 5)', (v) => Number.parseInt(v, 10))
    .option('--json', "print the API's reports (codes and counts)")
    .action(async (ref: string, o: { limit?: number; json?: boolean }) => {
      const c = await findConnection(ref);
      const list = await consoleApi().get<DiagnosticReportView[]>(`/connections/${c.id}/diagnostics`, { query: o.limit ? { limit: String(o.limit) } : {} });
      if (o.json) return out(JSON.stringify(list, null, 2));
      if (list.length === 0) return out(`No reports yet. Run \`connections diagnose ${ref}\`.`);
      for (const r of list) out(historyLine(r));
    });
  connections
    .command('app-test <provider>')
    .description("Administrator: test the deployment's app at google or microsoft before anyone connects. Exit code 0 pass or warn, 1 fail, 2 could not run")
    .option('--json', "print the API's report (codes and counts)")
    .action(async (provider: string, o: { json?: boolean }) => {
      if (provider !== 'google' && provider !== 'microsoft') throw new UsageError('The provider is google or microsoft.');
      const r = await runDiagnostic(() => consoleApi().post<DiagnosticReportView>(`/connections/admin/apps/${provider}/diagnose`, {}));
      if (o.json) out(JSON.stringify(r, null, 2));
      else for (const line of reportLines(r, `the ${provider} app`)) out(line);
      process.exitCode = reportExitCode(r);
    });
  connections
    .command('test <connection>')
    .description('Make one cheap read call per capability that is on (id, id prefix or label)')
    .option('--json', 'print JSON')
    .action(async (ref: string, o: { json?: boolean }) => {
      const c = await findConnection(ref);
      const r = await consoleApi().post<{ results: { capability: string; ok: boolean; code: string | null }[] }>(`/connections/${c.id}/test`, {});
      if (o.json) return out(JSON.stringify(r, null, 2));
      for (const x of r.results) {
        out(`${x.ok ? 'ok  ' : 'FAIL'}  ${x.capability}${x.code ? `  (${x.code}: ${remedyTitle(x.code)})` : ''}`);
        const remedy = x.code ? DIAGNOSTIC_REMEDIES[x.code]?.remedy : undefined;
        if (!x.ok && remedy) out(`      ${remedy}`);
      }
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
    .command('try <connection> <tool>')
    .description("Call a Read tool of an MCP server once, exactly as a run would, and print the server's answer (the tool's name or id; only a tool set to Read)")
    .option('--arg <key=value>', 'an argument (repeatable; a JSON value such as 5 or true is sent as that value)', collectArg, [])
    .option('--json-args <file>', 'the arguments as a JSON object in a file (then each --arg on top)')
    .option('--json', 'print JSON')
    .action(async (ref: string, toolRef: string, o: { arg: string[]; jsonArgs?: string; json?: boolean }) => {
      const args = toolArguments(o.arg, o.jsonArgs);
      const c = await findConnection(ref);
      if (c.provider !== 'mcp') throw new Error(`${c.label} is not an MCP server`);
      const api = consoleApi();
      const { tools } = await api.get<{ tools: McpToolView[] }>(`/connections/${c.id}/tools`);
      const tool = tools.find((t) => t.id === toolRef || t.name === toolRef);
      if (!tool) throw new Error(`${c.label} has no tool "${toolRef}". Run \`connections tools ${ref}\`.`);
      if (tool.mode !== 'read') throw new UsageError(`Only a tool set to Read can be tried here (${tool.name} is ${tool.mode}): set it in the web app, Settings → Connections.`);
      const r = await api.post<McpTryResultView>(`/connections/${c.id}/tools/${encodeURIComponent(tool.id)}/try`, { arguments: args });
      if (o.json) out(JSON.stringify(r, null, 2));
      else {
        out(THIRD_PARTY_NOTICE);
        out(`${r.ok ? 'The server answered' : r.code === 'TOOL_ERROR' ? 'The server reported an error' : `The call did not complete (${r.code}${r.code && DIAGNOSTIC_REMEDIES[r.code] ? `: ${remedyTitle(r.code)}` : ''})`} in ${r.ms} ms${r.truncated ? '; the answer was cut at 4,000 characters' : ''}.`);
        out('');
        out(r.text || '(no text)');
      }
      if (!r.ok) process.exitCode = 1;
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
