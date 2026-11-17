import { readFileSync, writeFileSync } from 'node:fs';

import type { Command } from 'commander';
import type { CliCommandRegistration } from '@marinoscar/platform-cli/core';

import { consoleApi } from './console-api.js';
import { budgetText, findPolicy, policyLine, resolvePolicyId, tierRange, type PolicyView } from './policies.js';

const out = (s: string): void => {
  process.stdout.write(`${s}\n`);
};
const json = (v: unknown): void => out(JSON.stringify(v, null, 2));

interface ImportResult {
  created: { name: string; id: string; renamedFrom: string | null }[];
  replaced: { name: string; id: string; version: number }[];
  skipped: { name: string }[];
  warnings: { name: string; code: string; message: string }[];
}

/** `hexactra policies …` over /api/agent-policies: the budgets and model tiers a run follows. */
export const policiesCommand: CliCommandRegistration = (program: Command) => {
  const policies = program.command('policies').description('Agent policies: the budgets and model tiers a run follows');
  policies
    .command('list')
    .description('The built-in policies and your own')
    .option('--json', 'print JSON')
    .action(async (o: { json?: boolean }) => {
      const list = await consoleApi().get<PolicyView[]>('/agent-policies');
      if (o.json) return json(list);
      for (const p of list) out(policyLine(p));
    });
  policies
    .command('show <policy>')
    .description('One policy in full (id, name, id prefix or builtin key such as balanced)')
    .option('--json', 'print the policy as JSON')
    .action(async (ref: string, o: { json?: boolean }) => {
      const api = consoleApi();
      const found = findPolicy(await api.get<PolicyView[]>('/agent-policies'), ref);
      const p = await api.get<PolicyView>(`/agent-policies/${encodeURIComponent(found.id)}`);
      if (o.json) return json(p);
      out(`${p.name}${p.builtin ? ' (built-in)' : ''}${p.isDefault ? ' (default)' : ''}`);
      out(`id: ${p.id}  version: ${p.version}`);
      if (p.description) out(p.description);
      out(`tiers: ${tierRange(p)}`);
      out(`budget: ${budgetText(p.spec.budget)}${p.hasNoHardStop ? '  (no hard stop)' : ''}`);
      out(`used by: ${p.usage.tasks} tasks, ${p.usage.schedules} schedules`);
      out('spec:');
      out(JSON.stringify(p.spec, null, 2));
    });
  policies
    .command('export')
    .description('Write policies as a portable JSON file (stdout, or -o file)')
    .option('--ids <ids>', 'comma-separated policy ids, names or builtin keys', 'all')
    .option('--no-pins', 'strip model pins so the file works on any deployment')
    .option('-o, --output <file>', 'write to this file instead of stdout')
    .action(async (o: { ids: string; pins: boolean; output?: string }) => {
      const api = consoleApi();
      let ids = 'all';
      if (o.ids !== 'all') {
        const list = await api.get<PolicyView[]>('/agent-policies');
        ids = o.ids
          .split(',')
          .map((r) => r.trim())
          .filter(Boolean)
          .map((r) => findPolicy(list, r).id)
          .join(',');
      }
      const file = await api.get<unknown>('/agent-policies/export', { query: { ids, includePins: String(o.pins) } });
      const text = `${JSON.stringify(file, null, 2)}\n`;
      if (o.output) {
        writeFileSync(o.output, text);
        out(`wrote ${o.output}`);
      } else process.stdout.write(text);
    });
  policies
    .command('import <file>')
    .description('Import policies from a file made by `policies export` ("-" reads stdin)')
    .option('--on-conflict <mode>', 'when a policy of that name exists: rename (default), skip or replace', 'rename')
    .option('--json', 'print JSON')
    .action(async (path: string, o: { onConflict: string; json?: boolean }) => {
      if (!['rename', 'skip', 'replace'].includes(o.onConflict)) throw new Error('--on-conflict is rename, skip or replace');
      let file: unknown;
      try {
        file = JSON.parse(readFileSync(path === '-' ? 0 : path, 'utf8'));
      } catch (e) {
        throw new Error(`Cannot read ${path} as JSON: ${e instanceof Error ? e.message : String(e)}`);
      }
      const r = await consoleApi().post<ImportResult>('/agent-policies/import', { file, onConflict: o.onConflict });
      if (o.json) return json(r);
      for (const c of r.created) out(`created  ${c.name}${c.renamedFrom ? ` (was "${c.renamedFrom}")` : ''}  ${c.id}`);
      for (const c of r.replaced) out(`replaced ${c.name}  v${c.version}`);
      for (const c of r.skipped) out(`skipped  ${c.name} (name taken)`);
      for (const w of r.warnings) out(`warning  ${w.name}: ${w.message}`);
    });
  policies
    .command('default [policy]')
    .description('Show the default policy, or choose it (a policy, or --reset for builtin:balanced)')
    .option('--reset', 'go back to the built-in balanced policy')
    .option('--json', 'print JSON')
    .action(async (ref: string | undefined, o: { reset?: boolean; json?: boolean }) => {
      const api = consoleApi();
      if (ref && o.reset) throw new Error('Pass a policy or --reset, not both.');
      const r =
        ref || o.reset
          ? await api.put<{ policyId: string; explicit: boolean }>('/agent-policies/default', { policyId: ref ? await resolvePolicyId(ref) : null })
          : await api.get<{ policyId: string; explicit: boolean }>('/agent-policies/default');
      if (o.json) return json(r);
      out(`${r.policyId}${r.explicit ? '' : ' (not chosen: the system default)'}`);
    });
};
