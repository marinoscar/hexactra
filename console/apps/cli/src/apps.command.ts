import type { Command } from 'commander';
import type { CliCommandRegistration } from '@marinoscar/platform-cli/core';

import { activityLine, appLine, limitLines, limitsPatch, resolveApp, type ActivityRow, type AppLimitsView, type AppView } from './apps.js';
import { consoleApi } from './console-api.js';
import { resolvePolicyId } from './policies.js';

const out = (s: string): void => {
  process.stdout.write(`${s}\n`);
};
const json = (v: unknown): void => out(JSON.stringify(v, null, 2));

/**
 * `hexactra apps …` over /api/connected-apps (#464): the AI apps (ChatGPT,
 * Claude, ...) connected to your account with OAuth, their limits, pause and
 * disconnect. Disconnect is the platform's grant revocation, the same one the
 * web's Connected apps and AI apps pages use.
 */
export const appsCommand: CliCommandRegistration = (program: Command) => {
  const apps = program.command('apps').description('AI apps connected to your account (ChatGPT, Claude, ...): limits, pause, disconnect');
  apps
    .command('list')
    .description('Your connected AI apps with their 30-day usage')
    .option('--json', 'print JSON')
    .action(async (o: { json?: boolean }) => {
      const list = await consoleApi().get<AppView[]>('/connected-apps');
      if (o.json) return json(list);
      if (list.length === 0) return out('No AI apps are connected. Connect one from Settings → AI apps → Connect an AI app in the console.');
      for (const a of list) out(appLine(a));
    });
  apps
    .command('show <app>')
    .description('One app: what it may do, its limits and usage (id, id prefix, host or name)')
    .option('--json', 'print JSON')
    .action(async (ref: string, o: { json?: boolean }) => {
      const a = await resolveApp(ref);
      if (o.json) return json(a);
      out(`${a.displayName}${a.selfName && a.selfName !== a.displayName ? ` ("${a.selfName}")` : ''}${a.verified ? '' : ' (unverified)'}`);
      out(`id: ${a.clientId}${a.host ? `  host: ${a.host}` : ''}`);
      out(`connected: ${a.connectedAt ?? '-'}  last used: ${a.lastUsedAt ?? '-'}`);
      out(`may: ${a.scopes.map((s) => `${s.label}${s.risk === 'low' ? '' : ` (${s.risk})`}`).join(', ') || '-'}`);
      out(`usage: ${a.usage.runs30d} runs in 30 days, $${a.usage.costUsd30d.toFixed(2)}; ${a.usage.liveRuns} live, ${a.usage.runsToday} today`);
      for (const line of limitLines(a.limits)) out(line);
    });
  const setPaused = (paused: boolean) => async (ref: string) => {
    const a = await resolveApp(ref);
    await consoleApi().patch<AppLimitsView>(`/connected-apps/${a.clientId}/settings`, { paused });
    out(paused ? `${a.displayName} is paused: it cannot start runs or browser sessions. Live runs keep going.` : `${a.displayName} may start runs again.`);
  };
  apps.command('pause <app>').description('Refuse new runs and sessions from an app without disconnecting it').action(setPaused(true));
  apps.command('resume <app>').description('Let a paused app start runs again').action(setPaused(false));
  apps
    .command('disconnect <app>')
    .description('Revoke the app: it is signed out on its next call (its runs stay, with its name)')
    .action(async (ref: string) => {
      const a = await resolveApp(ref);
      if (!a.grantId) return out(`${a.displayName} is not connected.`);
      await consoleApi().delete(`/oauth/grants/${a.grantId}`);
      out(`${a.displayName} was disconnected.`);
    });
  apps
    .command('limits <app>')
    .description("Show or change an app's limits; only the options you pass change")
    .option('--policy <policy>', 'the agent policy its runs use when it names none (id, name or builtin key); "default" for yours')
    .option('--allow-policies <policies>', 'comma-separated policies it may choose ("" for any)')
    .option('--max-runs <n>', 'runs it may have working at once')
    .option('--daily-runs <n>', 'runs it may start per day')
    .option('--daily-cost <usd>', 'USD its runs may spend per day ("none" for no limit)')
    .option('--sites <domains>', 'comma-separated sites its runs may visit ("" for no extra limit)')
    .option('--confirm', 'always ask before purchases and irreversible steps')
    .option('--no-confirm', "ask only when the task says so")
    .option('--confirm-sensitive', 'ask me before its sensitive browser actions (secrets, password and payment forms, sensitive hosts, the desktop, network JavaScript)')
    .option('--no-confirm-sensitive', 'do not ask before its sensitive browser actions')
    .option('--json', 'print JSON')
    .action(async (ref: string, o: { policy?: string; allowPolicies?: string; maxRuns?: string; dailyRuns?: string; dailyCost?: string; sites?: string; confirm?: boolean; confirmSensitive?: boolean; json?: boolean }, cmd: Command) => {
      const a = await resolveApp(ref);
      // `--confirm` / `--no-confirm` count only when given (commander defaults the pair to true).
      const confirmGiven = cmd.getOptionValueSource('confirm') === 'cli';
      const sensitiveGiven = cmd.getOptionValueSource('confirmSensitive') === 'cli';
      const patch = limitsPatch({ ...o, confirm: confirmGiven ? o.confirm : undefined, confirmSensitive: sensitiveGiven ? o.confirmSensitive : undefined });
      if (typeof patch.policyId === 'string') patch.policyId = await resolvePolicyId(patch.policyId);
      if (Array.isArray(patch.allowedPolicyIds)) patch.allowedPolicyIds = await Promise.all((patch.allowedPolicyIds as string[]).map((p) => resolvePolicyId(p)));
      const limits = Object.keys(patch).length ? await consoleApi().patch<AppLimitsView>(`/connected-apps/${a.clientId}/settings`, patch) : a.limits;
      if (o.json) return json(limits);
      out(`${a.displayName}${Object.keys(patch).length ? ' (saved)' : ''}`);
      for (const line of limitLines(limits)) out(line);
    });
  apps
    .command('check')
    .description('Can an AI app connect? The console URL to paste and what an administrator must fix first')
    .option('--json', 'print JSON')
    .action(async (o: { json?: boolean }) => {
      const p = await consoleApi().get<{ mcpUrl: string; ready: boolean; checks: { title: string; status: string; detail: string; fix: { text: string } | null }[]; clients: { id: string; allowed: boolean | null; detail: string }[] }>('/connected-apps/preflight');
      if (o.json) return json(p);
      out(`MCP URL: ${p.mcpUrl}`);
      for (const c of p.checks) out(`${c.status === 'pass' ? 'ok  ' : c.status.padEnd(4)}  ${c.title}${c.status === 'pass' ? '' : `: ${c.detail}${c.fix ? ` ${c.fix.text}` : ''}`}`);
      for (const c of p.clients) out(`${c.id.padEnd(12)}  ${c.allowed === null ? '-' : c.allowed ? 'can connect' : 'blocked'}  ${c.detail}`);
    });
  apps
    .command('activity [app]')
    .description('What your AI apps did: one line per tool call or refusal, newest first (the audit trail; no typed text, scripts or results)')
    .option('--tool <name>', 'only this tool')
    .option('--outcome <outcome>', 'ok, error, still_working, confirmation_required or refused')
    .option('--limit <n>', 'rows (default 50, at most 200)')
    .option('--json', 'print JSON')
    .action(async (ref: string | undefined, o: { tool?: string; outcome?: string; limit?: string; json?: boolean }) => {
      const q = new URLSearchParams();
      if (ref) q.set('clientId', (await resolveApp(ref)).clientId);
      if (o.tool) q.set('tool', o.tool);
      if (o.outcome) q.set('outcome', o.outcome);
      if (o.limit) q.set('limit', o.limit);
      const page = await consoleApi().get<{ items: ActivityRow[]; nextCursor: string | null }>(`/connected-apps/activity${q.size ? `?${q}` : ''}`);
      if (o.json) return json(page);
      if (page.items.length === 0) return out('No AI app activity.');
      for (const r of page.items) out(activityLine(r));
    });
};
