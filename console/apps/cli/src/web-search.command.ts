import type { Command } from 'commander';
import type { CliCommandRegistration } from '@marinoscar/platform-cli/core';
import { UsageError } from '@marinoscar/platform-cli/commands';

import { consoleApi } from './console-api.js';
import { reportExitCode, reportLines, runDiagnostic, type DiagnosticReportView } from './diagnostics.js';
import {
  ADMIN_FIELDS,
  DEFAULT_KEY_READERS,
  WEB_SEARCH_SERVICE,
  adminLines,
  adminPatch,
  keyLine,
  providerLine,
  resultLines,
  statusLines,
  type KeyReaders,
  type ServiceCredentialView,
  type WebSearchAdminView,
  type WebSearchProviderView,
  type WebSearchResultView,
  type WebSearchStatusView,
  type WebSearchUsageRowView,
} from './web-search.js';

let readers: KeyReaders = DEFAULT_KEY_READERS;

/** Tests swap where a key is read from (no terminal, no real standard input). */
export function setKeyReaders(next: KeyReaders | null): void {
  readers = next ?? DEFAULT_KEY_READERS;
}

const out = (s: string): void => {
  process.stdout.write(`${s}\n`);
};

const PROVIDER_ID = /^[a-z][a-z0-9_]{0,39}$/;

function providerId(id: string): string {
  if (!PROVIDER_ID.test(id)) throw new UsageError(`"${id}" is not a provider id (such as brave). \`search providers\` lists them.`);
  return id;
}

/** The key path of a tier: your own, your organization's (`--org`) or the deployment's (`--deployment`, an administrator). */
function keyPath(provider: string, o: { deployment?: boolean; org?: boolean }): string {
  if (o.deployment && o.org) throw new UsageError('Pass --deployment or --org, not both.');
  const prefix = o.deployment ? 'admin/' : o.org ? 'org/' : '';
  return `/service-credentials/${prefix}${WEB_SEARCH_SERVICE}/${providerId(provider)}`;
}

const tierName = (o: { deployment?: boolean; org?: boolean }) => (o.deployment ? "the deployment's key" : o.org ? "your organization's key" : 'your own key');

async function showStatus(json?: boolean): Promise<void> {
  const s = await consoleApi().get<WebSearchStatusView>('/web-search/status');
  if (json) return out(JSON.stringify(s, null, 2));
  for (const line of statusLines(s)) out(line);
}

/** `hexactra search …` over /api/web-search and /api/service-credentials (E50.15): find out whether web search works, and why not. */
export const webSearchCommand: CliCommandRegistration = (program: Command) => {
  const search = program.command('search').description('Web search: whether it works for you, a test, one search, your keys (the agent searches in every run while it is on)');
  search
    .command('status')
    .description("On or off and why, the provider and the tier of its key, today's count and limit")
    .option('--json', 'print JSON')
    .action((o: { json?: boolean }) => showStatus(o.json));
  search
    .command('on')
    .description('Switch web search on for your runs and chats (your own switch; the administrator has one for the deployment)')
    .action(async () => {
      await consoleApi().patch('/user-settings', { webSearch: { enabled: true } });
      await showStatus();
    });
  search
    .command('off')
    .description('Switch web search off for your runs and chats')
    .action(async () => {
      await consoleApi().patch('/user-settings', { webSearch: { enabled: false } });
      await showStatus();
    });
  search
    .command('providers')
    .description('The search providers installed here, and whether you can use each')
    .option('--json', 'print JSON')
    .action(async (o: { json?: boolean }) => {
      const list = await consoleApi().get<WebSearchProviderView[]>('/web-search/providers');
      if (o.json) return out(JSON.stringify(list, null, 2));
      if (list.length === 0) return out('No search provider is installed here.');
      for (const p of list) out(providerLine(p));
    });
  search
    .command('test')
    .description("Diagnose web search: each check in order (switches, key, network, one live search, today's limit, reading pages). Exit code 0 pass or warn, 1 fail, 2 could not run")
    .option('--provider <id>', 'this provider instead of the one that answers for you')
    .option('--deployment', "administrator: test the deployment's key (needs --provider)")
    .option('--json', "print the API's report (codes and counts)")
    .action(async (o: { provider?: string; deployment?: boolean; json?: boolean }) => {
      if (o.deployment && !o.provider) throw new UsageError('--deployment needs --provider <id>.');
      const api = consoleApi();
      const r = await runDiagnostic(() =>
        o.deployment
          ? api.post<DiagnosticReportView>(`/web-search/admin/providers/${providerId(o.provider!)}/diagnose`, {})
          : api.post<DiagnosticReportView>('/web-search/diagnose', {}, { query: o.provider ? { provider: providerId(o.provider) } : {} }),
      );
      if (o.json) out(JSON.stringify(r, null, 2));
      else for (const line of reportLines(r, `web search, ${r.target.id}`)) out(line);
      process.exitCode = reportExitCode(r);
    });
  search
    .command('query <text>')
    .description('Run one web search, counted against your day; prints numbered titles, addresses and excerpts')
    .option('--count <n>', 'how many results (1 to 20, default 5)', (v) => Number.parseInt(v, 10))
    .option('--site <host>', 'only results from this site')
    .option('--freshness <period>', 'day, week, month or year')
    .option('--json', 'print JSON')
    .action(async (text: string, o: { count?: number; site?: string; freshness?: string; json?: boolean }) => {
      if (o.freshness && !['day', 'week', 'month', 'year'].includes(o.freshness)) throw new UsageError('--freshness is day, week, month or year.');
      if (o.count !== undefined && (!Number.isInteger(o.count) || o.count < 1 || o.count > 20)) throw new UsageError('--count is 1 to 20.');
      const r = await consoleApi().post<WebSearchResultView>('/web-search/search', {
        query: text,
        ...(o.count ? { count: o.count } : {}),
        ...(o.site ? { site: o.site } : {}),
        ...(o.freshness ? { freshness: o.freshness } : {}),
      });
      if (o.json) return out(JSON.stringify(r, null, 2));
      for (const line of resultLines(r)) out(line);
    });
  search
    .command('keys')
    .description('Which search keys are stored (yours, your organization\'s, the deployment\'s) and which one you use. Never a key')
    .option('--json', 'print JSON')
    .action(async (o: { json?: boolean }) => {
      const list = (await consoleApi().get<ServiceCredentialView[]>('/service-credentials')).filter((c) => c.service === WEB_SEARCH_SERVICE);
      if (o.json) return out(JSON.stringify(list, null, 2));
      if (list.length === 0) return out('No search provider here takes a key.');
      for (const c of list) out(keyLine(c));
    });

  const key = search.command('key').description('Set or remove a search key (write-only: it is never shown again)');
  key
    .command('set <provider>')
    .description('Store a search key, typed at a hidden prompt or read from standard input (--stdin); never an argument')
    .option('--stdin', 'read the key from standard input')
    .option('--org', "your organization's key (an organization administrator)")
    .option('--deployment', "the deployment's key (an administrator)")
    // A key on the command line would be in the shell's history: an extra argument is refused below with that reason.
    .allowExcessArguments(true)
    .action(async (provider: string, o: { stdin?: boolean; org?: boolean; deployment?: boolean }, cmd: Command) => {
      if (cmd.args.length > 1) throw new UsageError('A key is never passed as an argument (it would stay in your shell history). Run `search key set <provider>` and type it at the prompt, or pipe it with --stdin.');
      const path = keyPath(provider, o);
      let value: string;
      if (o.stdin) value = await readers.stdin();
      else if (readers.isTTY()) value = await readers.hidden(`Key for ${provider} (${tierName(o)}, not shown): `);
      else throw new UsageError('No terminal to ask at: pipe the key with --stdin.');
      if (!value) throw new UsageError('No key was given; nothing was stored.');
      await consoleApi().put(path, { value });
      out(`stored ${tierName(o)} for ${provider}. \`search test --provider ${provider}\` checks it.`);
    });
  key
    .command('rm <provider>')
    .description('Remove a search key')
    .option('--org', "your organization's key (an organization administrator)")
    .option('--deployment', "the deployment's key (an administrator)")
    .action(async (provider: string, o: { org?: boolean; deployment?: boolean }) => {
      await consoleApi().delete(keyPath(provider, o));
      out(`removed ${tierName(o)} for ${provider}`);
    });

  const admin = search.command('admin').description("Administrator: the deployment's web search settings and usage");
  admin
    .command('show')
    .description('The switches, the order of providers and the limits')
    .option('--json', 'print JSON')
    .action(async (o: { json?: boolean }) => {
      const a = await consoleApi().get<WebSearchAdminView>('/web-search/admin');
      if (o.json) return out(JSON.stringify(a, null, 2));
      for (const line of adminLines(a)) out(line);
    });
  admin
    .command('set <field> <value>')
    .description(`Change one setting: ${ADMIN_FIELDS} (on/off, a comma list, a number or unlimited)`)
    .action(async (field: string, value: string) => {
      const a = await consoleApi().put<WebSearchAdminView>('/web-search/admin', adminPatch(field, value));
      for (const line of adminLines(a)) out(line);
    });
  admin
    .command('usage')
    .description('Searches, failures and the ESTIMATED cost by day and provider (no user, no query)')
    .option('--days <n>', 'how many days back (1 to 90, default 30)', (v) => Number.parseInt(v, 10))
    .option('--json', 'print JSON')
    .action(async (o: { days?: number; json?: boolean }) => {
      const rows = await consoleApi().get<WebSearchUsageRowView[]>('/web-search/admin/usage', { query: o.days ? { days: String(o.days) } : {} });
      if (o.json) return out(JSON.stringify(rows, null, 2));
      if (rows.length === 0) return out('No searches in that period.');
      for (const r of rows) out(`${r.day}  ${r.provider.padEnd(12)}  ${String(r.calls).padStart(6)} searches  ${String(r.failures).padStart(4)} failed  ~$${r.estimatedCostUsd.toFixed(2)}`);
    });
};
