import type { Command } from 'commander';
import type { CliCommandRegistration } from '@marinoscar/platform-cli/core';

import { consoleApi } from './console-api.js';

/** `GET /api/kgraph/status`. */
export interface KgraphStatusView {
  deployment: boolean;
  user: boolean;
  available: boolean;
  /** "Use in chats and one-off runs" (`kgraph.everyday` of your settings); effective only while `available`. */
  everyday: boolean;
}
/** One row of `GET /api/kgraph/procedures`. */
export interface ProcedureItemView {
  id: string;
  taskId: string;
  taskName: string;
  name: string;
  versionId: string | null;
  versionNumber: number | null;
  state: string | null;
  health: string;
  steps: number;
  updatedAt: string;
  /** `everydayRuns`: chats and one-off runs in which this procedure ran (E46.29). */
  ledger: { runs: number; procedureRuns: number; cleanReplayRate: number | null; everydayRuns?: number };
}
export interface StepView {
  id: string;
  kind: string;
  label: string;
  tool: string | null;
  target: string | null;
  usesAi: boolean;
  commitClass: boolean;
  health: string;
  args: { name: string; source: string; detail: string | null }[];
}
export interface VersionItemView {
  id: string;
  number: number;
  state: string;
  changeClass: string;
  createdAt: string;
  health: string;
  counts: { successes: number; failures: number; repairs: number };
  steps: number;
}
export interface ProcedureDetailView extends ProcedureItemView {
  enabled: boolean;
  versions: number;
  activeVersion: (Omit<VersionItemView, 'steps'> & { steps: StepView[]; parameters: { name: string; sensitive: boolean }[]; outputs: { name: string }[]; sites: string[]; savedLogins: { kind: string; label: string }[] }) | null;
}

/** One row of `GET /api/kgraph/sites`. */
export interface SiteSummaryView {
  site: string;
  active: number;
  proposed: number;
  archived: number;
}
/** One fact of `GET /api/kgraph/sites/{site}/facts`. */
export interface SiteFactView {
  id: string;
  site: string;
  kind: string;
  text: string;
  source: string;
  status: string;
  evidence: { runId: string | null; steps: number; screens: number };
  lastUsedAt: string | null;
  createdAt: string;
}
export const SITE_FACT_KINDS = ['navigation', 'sign_in', 'quirk', 'timing', 'other'] as const;
/** Where a proposal is answered: never in the CLI (a sensitive change is the owner's, signed in, in the console). */
export const FACTS_APPROVE_NOTE = 'Proposed facts are approved, edited or declined in the console: Knowledge Graph, Reviews. The CLI cannot approve one.';

const out = (s: string): void => {
  process.stdout.write(`${s}\n`);
};
const onOff = (b: boolean) => (b ? 'on' : 'off');
const OFF_NOTE = 'The Knowledge Graph is off for you: this is what was learned, kept and unused.';

export function statusText(s: KgraphStatusView): string {
  const why = s.available ? 'available: your saved tasks may choose learn or reuse' : !s.deployment ? 'off: turned off by your administrator' : 'off: run `hexactra kgraph on` to turn it on for yourself';
  const everyday = `everyday    ${onOff(s.everyday === true)}${s.everyday === true && !s.available ? ' (takes effect once the Knowledge Graph is available)' : ''}`;
  return [`deployment  ${onOff(s.deployment)}`, `you         ${onOff(s.user)}`, everyday, `Knowledge Graph ${why}`].join('\n');
}

/** The list line: id, version and state, health, steps, name and task. */
export function procedureLine(p: ProcedureItemView): string {
  const v = p.versionNumber === null ? 'no version' : `v${p.versionNumber} ${p.state}`;
  const rate = p.ledger.cleanReplayRate === null ? '' : `  ${Math.round(p.ledger.cleanReplayRate * 100)}% clean replays`;
  return `${p.id}  ${v.padEnd(14)}  ${p.health.padEnd(8)}  ${String(p.steps).padStart(3)} steps  ${p.name}  (task: ${p.taskName})${rate}`;
}

/** One step line: number, kind, tool, label, target and flags; arguments by where they come from, never a value of a parameter or secret. */
export function stepLine(s: StepView, i: number): string {
  const flags = [s.usesAi ? 'uses AI' : null, s.commitClass ? 'commits' : null, s.health !== 'unknown' ? s.health : null].filter(Boolean).join(', ');
  const args = s.args.map((a) => `${a.name}=${a.source}${a.detail ? `:${a.detail}` : ''}`).join(' ');
  return `${String(i + 1).padStart(3)}. ${s.kind.padEnd(7)} ${(s.tool ?? '').padEnd(18)} ${s.label}${s.target ? ` -> ${s.target}` : ''}${flags ? `  [${flags}]` : ''}${args ? `\n       ${args}` : ''}`;
}

/** A procedure by full id, id prefix or exact name. */
export async function findProcedure(ref: string): Promise<ProcedureItemView> {
  const list = (await consoleApi().get<{ procedures: ProcedureItemView[] }>('/kgraph/procedures')).procedures;
  const exact = list.find((p) => p.id === ref);
  if (exact) return exact;
  const matches = list.filter((p) => p.id.startsWith(ref) || p.name.toLowerCase() === ref.toLowerCase() || p.taskName.toLowerCase() === ref.toLowerCase());
  if (matches.length === 1) return matches[0]!;
  if (matches.length > 1) throw new Error(`"${ref}" matches several procedures; use the id`);
  throw new Error(`No procedure matches "${ref}". Run \`kgraph list\`.`);
}

/** A site's fact line: id, status, kind, source, last use and the text (data, printed as is). */
export function siteFactLine(f: SiteFactView): string {
  const used = f.lastUsedAt ? `used ${f.lastUsedAt.slice(0, 10)}` : 'not used yet';
  return `${f.id}  ${f.status.padEnd(8)}  ${f.kind.padEnd(10)}  ${f.source.padEnd(14)}  ${used.padEnd(15)}  ${f.text.replace(/\s+/g, ' ')}`;
}

export function siteLine(s: SiteSummaryView): string {
  return `${s.site.padEnd(32)}  ${String(s.active).padStart(3)} active  ${String(s.proposed).padStart(3)} proposed  ${String(s.archived).padStart(3)} archived`;
}

async function setSwitch(patch: { enabled: boolean } | { everyday: boolean }): Promise<void> {
  await consoleApi().patch('/user-settings', { kgraph: patch });
  out(statusText(await consoleApi().get<KgraphStatusView>('/kgraph/status')));
}

/** `hexactra kgraph …` over /api/kgraph: what the agent learned from your saved tasks' runs. */
export const kgraphCommand: CliCommandRegistration = (program: Command) => {
  const kg = program.command('kgraph').description('Knowledge Graph: procedures the agent learned from your saved tasks and replays without the model');
  kg.command('status')
    .description('Whether the Knowledge Graph is on: your administrator, you, and both')
    .option('--json', 'print JSON')
    .action(async (o: { json?: boolean }) => {
      const s = await consoleApi().get<KgraphStatusView>('/kgraph/status');
      out(o.json ? JSON.stringify(s, null, 2) : statusText(s));
    });
  kg.command('list')
    .description('Your learned procedures with state, health and clean-replay rate')
    .option('--task <id>', 'only the procedure of this task')
    .option('--state <state>', 'candidate, verified, active, suspended, retired or rejected')
    .option('--search <text>', 'words in the procedure or task name')
    .option('--json', 'print JSON')
    .action(async (o: { task?: string; state?: string; search?: string; json?: boolean }) => {
      const query: Record<string, string> = {};
      if (o.task) query.taskId = o.task;
      if (o.state) query.state = o.state;
      if (o.search) query.q = o.search;
      const res = await consoleApi().get<{ enabled: boolean; procedures: ProcedureItemView[] }>('/kgraph/procedures', { query });
      if (o.json) return out(JSON.stringify(res, null, 2));
      if (!res.enabled) out(OFF_NOTE);
      if (res.procedures.length === 0) return out('No procedures.');
      for (const p of res.procedures) out(procedureLine(p));
    });
  kg.command('show <procedure>')
    .description('One procedure as its ordered steps (id, id prefix, or procedure or task name)')
    .option('--json', 'print JSON')
    .action(async (ref: string, o: { json?: boolean }) => {
      const found = await findProcedure(ref);
      const p = await consoleApi().get<ProcedureDetailView>(`/kgraph/procedures/${encodeURIComponent(found.id)}`);
      if (o.json) return out(JSON.stringify(p, null, 2));
      if (!p.enabled) out(OFF_NOTE);
      out(`${p.name} (task: ${p.taskName})`);
      out(`id: ${p.id}`);
      if (p.ledger.everydayRuns !== undefined) out(`used in chats and one-off runs: ${p.ledger.everydayRuns}`);
      const v = p.activeVersion;
      if (!v) return out('No version yet: the task learns from its next successful run.');
      out(`version ${v.number} of ${p.versions}: ${v.state}, ${v.health} (${v.counts.successes} clean, ${v.counts.failures} failed, ${v.counts.repairs} repaired)`);
      if (v.sites.length) out(`sites: ${v.sites.join(', ')}`);
      if (v.savedLogins.length) out(`saved logins: ${v.savedLogins.map((l) => `${l.kind} "${l.label}"`).join(', ')}`);
      if (v.parameters.length) out(`parameters: ${v.parameters.map((x) => (x.sensitive ? `${x.name} (sensitive)` : x.name)).join(', ')}`);
      if (v.outputs.length) out(`outputs: ${v.outputs.map((x) => x.name).join(', ')}`);
      v.steps.forEach((s, i) => out(stepLine(s, i)));
    });
  kg.command('versions <procedure>')
    .description("A procedure's versions, newest first")
    .option('--json', 'print JSON')
    .action(async (ref: string, o: { json?: boolean }) => {
      const found = await findProcedure(ref);
      const res = await consoleApi().get<{ enabled: boolean; versions: VersionItemView[] }>(`/kgraph/procedures/${encodeURIComponent(found.id)}/versions`);
      if (o.json) return out(JSON.stringify(res, null, 2));
      if (!res.enabled) out(OFF_NOTE);
      for (const v of res.versions) out(`v${String(v.number).padEnd(4)} ${v.state.padEnd(10)} ${v.changeClass.padEnd(10)} ${v.health.padEnd(8)} ${String(v.steps).padStart(3)} steps  ${v.counts.successes} clean / ${v.counts.failures} failed  ${v.createdAt.slice(0, 10)}  ${v.id}`);
    });
  kg.command('restore <procedure> <version>')
    .description('Bring back a retired or suspended version (its number or id); its next run asks before every step that sends or pays')
    .action(async (ref: string, version: string) => {
      const found = await findProcedure(ref);
      let versionId = version;
      if (/^\d+$/.test(version)) {
        const list = (await consoleApi().get<{ versions: VersionItemView[] }>(`/kgraph/procedures/${encodeURIComponent(found.id)}/versions`)).versions;
        const v = list.find((x) => x.number === Number(version));
        if (!v) throw new Error(`${found.name} has no version ${version}. Run \`kgraph versions ${found.id}\`.`);
        versionId = v.id;
      }
      const r = await consoleApi().post<{ restoredFrom: string; versionId: string }>(`/kgraph/procedures/${encodeURIComponent(found.id)}/restore`, { versionId });
      out(`restored ${found.name}: ${r.versionId} (from ${r.restoredFrom}); its next run verifies it`);
    });
  kg.command('forget <procedure>')
    .description('Retire every version of a procedure (kept for history); the task learns again from its next successful run')
    .action(async (ref: string) => {
      const found = await findProcedure(ref);
      const r = await consoleApi().post<{ retired: number }>(`/kgraph/procedures/${encodeURIComponent(found.id)}/forget`, {});
      out(`forgot ${found.name}: ${r.retired} version${r.retired === 1 ? '' : 's'} retired`);
    });
  kg.command('sites')
    .description('Your sites with facts: how many are active, proposed and archived')
    .option('--json', 'print JSON')
    .action(async (o: { json?: boolean }) => {
      const sites = await consoleApi().get<SiteSummaryView[]>('/kgraph/sites');
      if (o.json) return out(JSON.stringify(sites, null, 2));
      if (sites.length === 0) return out('No site facts yet. Add one with `hexactra kgraph facts add <site> --kind <kind> --text <text>`.');
      for (const s of sites) out(siteLine(s));
    });
  const facts = kg
    .command('facts')
    .description(`A site's facts (a registrable domain, such as example.com). ${FACTS_APPROVE_NOTE}`)
    .argument('<site>', 'the site, such as example.com')
    // Lets `kgraph facts approve <id>` reach the action below and be told where proposals are answered.
    .allowExcessArguments(true)
    .option('--status <status>', 'active, proposed or archived')
    .option('--json', 'print JSON')
    .addHelpText('after', `\n${FACTS_APPROVE_NOTE}`)
    .action(async (site: string, o: { status?: string; json?: boolean }) => {
      // `kgraph facts approve …` is not a command: say where a proposal is answered instead of reading a site called "approve".
      if (['approve', 'decline'].includes(site.toLowerCase())) throw new Error(FACTS_APPROVE_NOTE);
      const query: Record<string, string> = {};
      if (o.status) query.status = o.status;
      const list = await consoleApi().get<SiteFactView[]>(`/kgraph/sites/${encodeURIComponent(site.toLowerCase())}/facts`, { query });
      if (o.json) return out(JSON.stringify(list, null, 2));
      if (list.length === 0) return out(`No facts about ${site}.`);
      for (const f of list) out(siteFactLine(f));
      if (list.some((f) => f.status === 'proposed')) out(FACTS_APPROVE_NOTE);
    });
  facts
    .command('add <site>')
    .description('Add a fact about a site in your own words; it is active at once. No passwords, codes or instructions (refused)')
    .requiredOption('--kind <kind>', SITE_FACT_KINDS.join(', '))
    .requiredOption('--text <text>', 'the fact, at most 300 characters')
    .action(async (site: string, o: { kind: string; text: string }) => {
      if (!(SITE_FACT_KINDS as readonly string[]).includes(o.kind)) throw new Error(`--kind must be one of ${SITE_FACT_KINDS.join(', ')}`);
      const f = await consoleApi().post<SiteFactView>(`/kgraph/sites/${encodeURIComponent(site.toLowerCase())}/facts`, { kind: o.kind, text: o.text });
      out(`added ${f.id} about ${f.site} (${f.kind}), active`);
    });
  kg.command('off')
    .description('Turn the Knowledge Graph off for yourself (what was learned is kept, unused)')
    .action(async () => setSwitch({ enabled: false }));
  kg.command('on')
    .description('Turn the Knowledge Graph on for yourself (your administrator must allow it too)')
    .action(async () => setSwitch({ enabled: true }));
  kg.command('everyday <on|off>')
    .description('Offer your learned procedures to chats and one-off runs (on) or not (off); you still approve anything sensitive. Works while the Knowledge Graph is on for you')
    .action(async (value: string) => {
      const v = value.trim().toLowerCase();
      if (v !== 'on' && v !== 'off') throw new Error('Use `hexactra kgraph everyday on` or `hexactra kgraph everyday off`.');
      await setSwitch({ everyday: v === 'on' });
    });
};
