import type { Command } from 'commander';
import type { CliCommandRegistration } from '@marinoscar/platform-cli/core';

import { resolveApp, startedBy } from './apps.js';
import { consoleApi, consoleCredentials, consoleWebUrl } from './console-api.js';
import { findHost, type FleetHost } from './fleet.js';
import { costText, resolvePolicyId, runPolicyLines, type RunPolicyFields } from './policies.js';
import { triggerLine, type MailTriggerView } from './mail-triggers.js';
import { countOlderThan, deleteOlderThan, exportRun, exportRunPdf, parseDays, runsWord, sizeText, type ReportTarget } from './runs.js';
import { collectInput, missingParameters, parseInputFlags, promptMissing, type CliTaskParameter } from './task-inputs.js';
import { outputLines, outputsCsv, outputsTable, type CliOutputsPage, type CliRunOutput } from './task-outputs.js';
import { deliveryLines, findDelivery, runDeliveryLines, type CliDelivery, type CliRunDelivery } from './deliveries.js';

let targetFactory: (() => ReportTarget) | null = null;

/** Tests swap where `runs export --pdf` fetches from (a fake fetch, no real login). */
export function setReportTargetFactory(next: (() => ReportTarget) | null): void {
  targetFactory = next;
}

/** The API root and token of the PDF download: it bypasses the JSON-only API client. */
function reportTarget(): ReportTarget {
  return targetFactory ? targetFactory() : consoleCredentials();
}

/** `--host <name|id>`: "any" lets the fabric choose (#384). */
async function hostRef(ref: string): Promise<string | null> {
  if (ref === 'any') return null;
  return findHost(await consoleApi().get<FleetHost[]>('/fleet/hosts'), ref).id;
}

const out = (s: string): void => {
  process.stdout.write(`${s}\n`);
};
const json = (v: unknown): void => out(JSON.stringify(v, null, 2));

interface Task {
  id: string;
  name: string;
  goal: string;
  profile: string;
  allowedDomains: string[];
  /** The goal's `{{parameters}}` (#552). */
  parameters?: CliTaskParameter[] | null;
  policyId?: string | null;
}
interface Step {
  seq: number;
  kind: string;
  action: string | null;
  ok: boolean;
  summary: string;
}
interface Run extends RunPolicyFields {
  /** Where it was started from, and the AI app that started it (#464). */
  origin?: string;
  client?: { name: string | null; verified: boolean } | null;
  id: string;
  status: string;
  goal: string;
  stepCount: number;
  result: string | null;
  error: string | null;
  createdAt: string;
  steps?: Step[];
  /** What the run returned (E39.5): masked; null for a run without outputs. */
  outputs?: CliRunOutput[] | null;
  outputsComplete?: boolean | null;
}

const label = (s: string) => (s === 'waiting_human' ? 'needs you' : s);

/**
 * Ask before something that cannot be undone. `--yes` answers for a script; without it the question
 * needs a terminal, so a pipe or a CI job fails instead of deleting unasked.
 */
export async function confirmed(question: string, yes: boolean | undefined): Promise<boolean> {
  if (yes) return true;
  if (!process.stdin.isTTY) throw new Error(`${question} This cannot be undone: pass --yes.`);
  const { createInterface } = await import('node:readline/promises');
  const rl = createInterface({ input: process.stdin, output: process.stderr });
  try {
    return /^y(es)?$/i.test((await rl.question(`${question} This cannot be undone. [y/N] `)).trim());
  } finally {
    rl.close();
  }
}
const TERMINAL = new Set(['succeeded', 'failed', 'cancelled']);

/** The console's address for a link, or a placeholder when it cannot be read. */
function webUrl(): string {
  try {
    return consoleWebUrl();
  } catch {
    return 'the console';
  }
}

/** Print new steps of a run until it ends (or `--watch` is off). */
async function show(id: string, watch: boolean, asJson: boolean): Promise<void> {
  let printed = 0;
  let lastStatus = '';
  for (;;) {
    const r = await consoleApi().get<Run>(`/runs/${id}`);
    if (asJson && !watch) return json(r);
    if (printed === 0) {
      out(`${r.goal}`);
      for (const l of runPolicyLines(r)) out(`  ${l}`);
    }
    for (const s of (r.steps ?? []).slice(printed)) out(`  ${s.seq}. ${s.action ?? s.kind}${s.ok ? '' : ' (failed)'}: ${s.summary}`);
    printed = r.steps?.length ?? 0;
    if (r.status !== lastStatus) {
      out(`[${label(r.status)}]`);
      lastStatus = r.status;
    }
    if (!watch || TERMINAL.has(r.status)) {
      for (const l of runPolicyLines(r)) if (l.startsWith('cost') || l.startsWith('stopped') || l.startsWith('budget')) out(l);
      if (r.result) out(`result: ${r.result}`);
      for (const l of outputLines(r.outputs, r.outputsComplete)) out(l);
      if (r.error) out(`error: ${r.error}`);
      if (r.status === 'failed') process.exitCode = 1;
      return;
    }
    await new Promise((res) => setTimeout(res, 2_000));
  }
}

/** The task a ref names: an id, its first characters, or its name. */
async function findTask(ref: string): Promise<Task> {
  const list = await consoleApi().get<Task[]>('/tasks');
  const matches = list.filter((t) => t.id === ref || t.id.startsWith(ref) || t.name === ref);
  if (matches.length !== 1) throw new Error(matches.length ? `"${ref}" matches several tasks; use the id` : `No task matches "${ref}"`);
  return matches[0]!;
}

/** `hexactra tasks …` and `hexactra runs …` over /api/tasks and /api/runs. */
export const runsCommand: CliCommandRegistration = (program: Command) => {
  const tasks = program.command('tasks').description('Saved browser goals');
  tasks
    .command('list')
    .option('--json', 'print JSON')
    .action(async (o: { json?: boolean }) => {
      const list = await consoleApi().get<Task[]>('/tasks');
      if (o.json) return json(list);
      for (const t of list) out(`${t.id.slice(0, 8)}  ${t.name}  [${t.profile}]  ${t.allowedDomains.join(',') || 'any site'}`);
    });
  tasks
    .command('create <name> <goal>')
    .option('--profile <profile>', 'browser profile', 'default')
    .option('--allow <domains>', 'comma-separated allowed sites')
    .option('--max-steps <n>', 'step budget', (v) => Number.parseInt(v, 10))
    .option('--no-confirm', 'do not ask before purchases and irreversible steps')
    .option('--policy <policy>', 'agent policy (id, name or builtin key such as balanced); default: yours')
    .option('--host <host>', 'machine that runs it (name, id or id prefix); default: any available')
    .option('--no-host-fallback', 'fail instead of using another machine when it is unavailable')
    .option('--json', 'print JSON')
    .action(async (name: string, goal: string, o: { profile: string; allow?: string; maxSteps?: number; confirm: boolean; policy?: string; host?: string; hostFallback: boolean; json?: boolean }) => {
      const t = await consoleApi().post<Task>('/tasks', {
        ...(o.policy ? { policyId: await resolvePolicyId(o.policy) } : {}),
        name,
        goal,
        profile: o.profile,
        ...(o.host ? { hostId: await hostRef(o.host) } : {}),
        hostFallback: o.hostFallback,
        allowedDomains: o.allow ? o.allow.split(',').map((d) => d.trim()).filter(Boolean) : [],
        confirmRiskyActions: o.confirm,
        ...(o.maxSteps ? { maxSteps: o.maxSteps } : {}),
      });
      if (o.json) return json(t);
      out(`created ${t.id}`);
    });
  tasks
    .command('update <id>')
    .description('Change a task; only the options you pass change')
    .option('--name <name>')
    .option('--goal <goal>')
    .option('--profile <profile>', 'browser profile')
    .option('--allow <domains>', 'comma-separated allowed sites ("" for any site)')
    .option('--max-steps <n>', 'step budget', (v) => Number.parseInt(v, 10))
    .option('--confirm', 'ask before purchases and irreversible steps')
    .option('--no-confirm', 'do not ask before purchases and irreversible steps')
    .option('--policy <policy>', 'agent policy (id, name or builtin key; "default" follows your default policy)')
    .option('--host <host>', 'machine that runs it (name, id or id prefix; "any" for any available)')
    .option('--host-fallback', 'use another available machine when it is unavailable')
    .option('--no-host-fallback', 'fail instead of using another machine when it is unavailable')
    .option('--json', 'print JSON')
    .action(async (id: string, o: { name?: string; goal?: string; profile?: string; allow?: string; maxSteps?: number; confirm?: boolean; policy?: string; host?: string; hostFallback?: boolean; json?: boolean }) => {
      const body = {
        ...(o.policy !== undefined ? { policyId: o.policy === 'default' ? null : await resolvePolicyId(o.policy) } : {}),
        ...(o.name !== undefined ? { name: o.name } : {}),
        ...(o.goal !== undefined ? { goal: o.goal } : {}),
        ...(o.profile !== undefined ? { profile: o.profile } : {}),
        ...(o.allow !== undefined ? { allowedDomains: o.allow.split(',').map((d) => d.trim()).filter(Boolean) } : {}),
        ...(o.maxSteps ? { maxSteps: o.maxSteps } : {}),
        ...(o.confirm !== undefined ? { confirmRiskyActions: o.confirm } : {}),
        ...(o.host !== undefined ? { hostId: await hostRef(o.host) } : {}),
        ...(o.hostFallback !== undefined ? { hostFallback: o.hostFallback } : {}),
      };
      if (!Object.keys(body).length) throw new Error('Nothing to change: pass --goal, --name, --profile, --allow, --max-steps, --policy, --host, --[no-]host-fallback or --[no-]confirm.');
      const t = await consoleApi().patch<Task>(`/tasks/${id}`, body);
      if (o.json) return json(t);
      out(`updated ${t.id}`);
    });
  tasks
    .command('run <task>')
    .description('Run a task (by id or id prefix); --watch follows it to the end')
    .option('--policy <policy>', 'run under this agent policy for this run only')
    .option('--input <name=value>', "a value for one of the task's {{parameters}}, by key or name (repeatable)", collectInput, [])
    .option('--watch', 'follow the run')
    .option('--json', 'print JSON')
    .action(async (ref: string, o: { policy?: string; input?: string[]; watch?: boolean; json?: boolean }) => {
      const list = await consoleApi().get<Task[]>('/tasks');
      const matches = list.filter((t) => t.id === ref || t.id.startsWith(ref) || t.name === ref);
      if (matches.length !== 1) throw new Error(matches.length ? `"${ref}" matches several tasks; use the id` : `No task matches "${ref}"`);
      const task = matches[0]!;
      const params = task.parameters ?? [];
      const inputs = parseInputFlags(o.input);
      // At a terminal, the values still missing are asked for here (#552); a sensitive one never is.
      if (process.stdin.isTTY && process.stderr.isTTY) Object.assign(inputs, await promptMissing(missingParameters(params, inputs)));
      const body = { ...(o.policy ? { policyId: await resolvePolicyId(o.policy) } : {}), ...(Object.keys(inputs).length ? { inputs } : {}) };
      const r = await consoleApi().post<Run>(`/tasks/${task.id}/runs`, body);
      if (o.json && !o.watch) return json(r);
      out(`run ${r.id}`);
      const sensitive = params.filter((p) => p.sensitive);
      if (r.status === 'waiting_human') out(`waiting for values: answer it with \`hexactra inbox\` or at ${webUrl()}/inbox`);
      if (sensitive.length) out(`${sensitive.map((p) => p.label).join(', ')}: asked for in the console when the run starts (${webUrl()}/inbox), never here`);
      if (o.watch) await show(r.id, true, false);
    });
  const triggers = tasks.command('triggers').description('Email triggers: start a task when a matching email arrives (make one in the web app: the task page, "Runs automatically")');
  triggers
    .command('list <task>')
    .description("A task's email triggers (id, id prefix or name): the rules, the account and the status")
    .option('--json', 'print JSON')
    .action(async (ref: string, o: { json?: boolean }) => {
      const list = await consoleApi().get<Task[]>('/tasks');
      const matches = list.filter((t) => t.id === ref || t.id.startsWith(ref) || t.name === ref);
      if (matches.length !== 1) throw new Error(matches.length ? `"${ref}" matches several tasks; use the id` : `No task matches "${ref}"`);
      const rows = await consoleApi().get<MailTriggerView[]>(`/tasks/${matches[0]!.id}/mail-triggers`);
      if (o.json) return json(rows);
      if (rows.length === 0) return out('No email triggers on this task.');
      for (const t of rows) out(triggerLine(t));
    });
  tasks
    .command('outputs <task>')
    .description("What a task's finished runs returned (the values its outputs name), newest first: a table, or --csv for a spreadsheet; a sensitive output reads [hidden]")
    .option('--limit <n>', 'how many runs (1 to 500)', (v) => Number.parseInt(v, 10), 20)
    .option('--csv', 'print CSV: one row per run, one column per output')
    .option('--json', 'print JSON')
    .action(async (ref: string, o: { limit: number; csv?: boolean; json?: boolean }) => {
      if (!Number.isInteger(o.limit) || o.limit < 1 || o.limit > 500) throw new Error('--limit is a number from 1 to 500.');
      const task = await findTask(ref);
      // The API pages by 100 at most: follow the cursor until enough runs are read.
      let page: CliOutputsPage | null = null;
      let cursor: string | null = null;
      do {
        const next: CliOutputsPage = await consoleApi().get<CliOutputsPage>(`/tasks/${task.id}/outputs`, { query: { limit: Math.min(100, o.limit - (page?.items.length ?? 0)), ...(cursor ? { cursor } : {}) } });
        page = page ? { columns: page.columns, items: [...page.items, ...next.items], nextCursor: next.nextCursor } : next;
        cursor = next.nextCursor;
      } while (cursor && page.items.length < o.limit);
      if (o.json) return json(page);
      if (o.csv) {
        process.stdout.write(outputsCsv(page));
        return;
      }
      if (!page.columns.length) return out('This task has no outputs. Add them to the task in the console (Outputs).');
      if (!page.items.length) return out('No finished run of this task has returned outputs yet.');
      for (const l of outputsTable(page)) out(l);
    });
  const deliveries = tasks.command('deliveries').description('What a task sends when a run ends: an email with the PDF report, a signed webhook, a spreadsheet row, files in a folder (set up in the web app or the API)');
  deliveries
    .command('list <task>')
    .description("A task's deliveries, in the order they are sent, with where each goes and whether it is on")
    .option('--json', 'print JSON')
    .action(async (ref: string, o: { json?: boolean }) => {
      const task = await findTask(ref);
      const list = await consoleApi().get<CliDelivery[]>(`/tasks/${task.id}/deliveries`);
      if (o.json) return json(list);
      for (const l of deliveryLines(list)) out(l);
    });
  deliveries
    .command('test <task> <delivery>')
    .description('Send a clearly marked TEST with sample values to the delivery\'s destination (an email marked TEST, a row marked TEST, a small file); no run is read or sent')
    .option('--json', 'print JSON')
    .action(async (ref: string, deliveryRef: string, o: { json?: boolean }) => {
      const task = await findTask(ref);
      const d = findDelivery(await consoleApi().get<CliDelivery[]>(`/tasks/${task.id}/deliveries`), deliveryRef);
      const r = await consoleApi().post<{ ok: boolean; code: string | null; message: string; detail: Record<string, unknown> }>(`/tasks/${task.id}/deliveries/${d.id}/test`, {});
      if (o.json) return json(r);
      out(r.message);
      if (typeof r.detail.location === 'string') out(`row: ${r.detail.location}`);
      if (!r.ok) process.exitCode = 1;
    });
  tasks
    .command('delete <id>')
    .action(async (id: string) => {
      await consoleApi().delete(`/tasks/${id}`);
      out('deleted');
    });
  for (const [name, done] of [['pause', 'paused'], ['resume', 'resumed']] as const) {
    tasks
      .command(`${name} <id>`)
      .description(name === 'pause' ? 'Pause every schedule of a task (it still runs when started by hand, the API or MCP)' : 'Resume every schedule of a task')
      .option('--json', 'print JSON')
      .action(async (id: string, o: { json?: boolean }) => {
        const t = await consoleApi().post<Task & { summary?: { schedules: unknown[]; nextRunAt: string | null } }>(`/tasks/${id}/schedules/${name}`, {});
        if (o.json) return json(t);
        const n = t.summary?.schedules.length ?? 0;
        out(`${done} ${n} schedule${n === 1 ? '' : 's'}${name === 'resume' && t.summary?.nextRunAt ? `: next ${t.summary.nextRunAt}` : ''}`);
      });
  }

  const runs = program.command('runs').description('Runs of browser goals');
  runs
    .command('list')
    .option('--status <status>', 'filter by status')
    .option('--app <app>', 'only the runs an AI app started (id, id prefix, host or name; see apps list)')
    .option('--origin <origin>', 'only runs started from: web, android, cli, api, mcp, schedule or system (comma-separated)')
    .option('--json', 'print JSON')
    .action(async (o: { status?: string; app?: string; origin?: string; json?: boolean }) => {
      const clientId = o.app ? (await resolveApp(o.app)).clientId : undefined;
      const list = await consoleApi().get<Run[]>('/runs', { query: { status: o.status, ...(clientId ? { clientId } : {}), ...(o.origin ? { origin: o.origin } : {}) } });
      if (o.json) return json(list);
      for (const r of list) out(`${r.id.slice(0, 8)}  ${label(r.status).padEnd(10)}  ${r.stepCount} steps  ${(r.policy?.name ?? '-').padEnd(12)}  ${(costText(r) ?? '-').padEnd(8)}  ${r.goal.slice(0, 60)}  [${startedBy(r)}]`);
    });
  runs
    .command('start <goal>')
    .description('Run an ad-hoc goal')
    .option('--profile <profile>', 'browser profile', 'default')
    .option('--host <host>', 'machine to run on (name, id or id prefix); default: any available')
    .option('--no-host-fallback', 'fail instead of using another machine when it is unavailable')
    .option('--policy <policy>', 'agent policy: id, name or builtin key such as balanced (default: yours)')
    .option('--watch', 'follow the run')
    .action(async (goal: string, o: { profile: string; host?: string; hostFallback: boolean; policy?: string; watch?: boolean }) => {
      const r = await consoleApi().post<Run>('/runs', { goal, profile: o.profile, ...(o.policy ? { policyId: await resolvePolicyId(o.policy) } : {}), ...(o.host ? { hostId: await hostRef(o.host) } : {}), hostFallback: o.hostFallback });
      out(`run ${r.id}`);
      if (o.watch) await show(r.id, true, false);
    });
  runs
    .command('show <id>')
    .option('--watch', 'follow until it ends')
    .option('--json', 'print JSON')
    .action(async (id: string, o: { watch?: boolean; json?: boolean }) => show(id, Boolean(o.watch), Boolean(o.json)));
  runs
    .command('deliveries <id>')
    .description('What was sent for a run (an email, a webhook, a spreadsheet row, files), with the status and the reason of each; --retry <id> tries one that failed again')
    .option('--retry <deliveryLogId>', 'retry one entry of the log that failed')
    .option('--json', 'print JSON')
    .action(async (id: string, o: { retry?: string; json?: boolean }) => {
      if (o.retry) await consoleApi().post(`/runs/${id}/deliveries/${o.retry}/retry`, {});
      const rows = await consoleApi().get<CliRunDelivery[]>(`/runs/${id}/deliveries`);
      if (o.json) return json(rows);
      for (const l of runDeliveryLines(rows)) out(l);
    });
  runs
    .command('watch <id>')
    .description('Follow a run until it ends')
    .action(async (id: string) => show(id, true, false));
  runs
    .command('delete [id]')
    .description('Delete a finished run, or every finished run older than a number of days (--older-than). There is no undelete.')
    .option('--older-than <days>', 'delete the finished runs created more than this many days ago', parseDays)
    .option('--yes', 'do not ask')
    .action(async (id: string | undefined, o: { olderThan?: number; yes?: boolean }) => {
      const api = consoleApi();
      if ((id === undefined) === (o.olderThan === undefined)) throw new Error('Pass a run id, or --older-than <days> (not both).');
      if (id !== undefined) {
        const r = await api.get<Run>(`/runs/${id}`);
        if (!TERMINAL.has(r.status)) throw new Error(`Run ${r.id} is ${label(r.status)}: cancel it first (hexactra runs cancel ${r.id}).`);
        if (!(await confirmed(`Delete run ${r.id.slice(0, 8)} (${r.goal.slice(0, 60)})?`, o.yes))) return out('nothing deleted');
        await api.delete(`/runs/${r.id}`);
        return out('deleted');
      }
      const { filter, matched, costUsd } = await countOlderThan(api, o.olderThan!);
      if (matched === 0) return out(`No finished run is older than ${o.olderThan} days.`);
      const cost = costUsd === null ? '' : ` ($${costUsd.toFixed(2)} of recorded cost)`;
      if (!(await confirmed(`Delete ${runsWord(matched)} older than ${o.olderThan} days${cost}?`, o.yes))) return out('nothing deleted');
      out(await deleteOlderThan(api, filter, matched));
    });
  runs
    .command('export <id>')
    .description("Write a run's masked JSON trace file (steps, questions and answers, screenshots, chat), or with --pdf its PDF report, for your records, to share or for a bug report")
    .option('--pdf', 'write the PDF report instead of the JSON file')
    .option('--paper <size>', "the PDF report's paper: a4 or letter", 'a4')
    .option('--no-screenshots', 'leave the trace screenshots out (a much smaller file)')
    .option('-o, --output <file>', 'write to this file (default: hexactra-run-<id>-<date>.json, or .pdf, in the current directory)')
    .action(async (id: string, o: { pdf?: boolean; paper: string; screenshots: boolean; output?: string }) => {
      if (o.pdf) {
        const paper = o.paper.toLowerCase();
        if (paper !== 'a4' && paper !== 'letter') throw new Error(`--paper is a4 or letter, not "${o.paper}".`);
        const file = await exportRunPdf(reportTarget(), id, { screenshots: o.screenshots, paper, ...(o.output ? { output: o.output } : {}) });
        return out(`wrote ${file.path} (${sizeText(file.bytes)})`);
      }
      const file = await exportRun(consoleApi(), id, { screenshots: o.screenshots, ...(o.output ? { output: o.output } : {}) });
      out(`wrote ${file.path} (${sizeText(file.bytes)})`);
    });
  runs
    .command('cancel <id>')
    .action(async (id: string) => {
      const r = await consoleApi().post<Run>(`/runs/${id}/cancel`, {});
      out(`${label(r.status)}${r.status === 'running' ? ' (stopping)' : ''}`);
    });

  runs
    .command('pause <id>')
    .description('freeze a run: it finishes its current step, then nothing happens until `runs resume` (its browser stays as it is; no budget time runs)')
    .action(async (id: string) => {
      const r = await consoleApi().post<Run>(`/runs/${id}/pause`, {});
      out(r.status === 'paused' ? 'paused' : `pausing (${label(r.status)}: it pauses after its current step or once its question is answered)`);
    });
  runs
    .command('resume <id>')
    .description('continue a paused run; the agent looks at the page again before it acts')
    .action(async (id: string) => {
      const r = await consoleApi().post<Run>(`/runs/${id}/resume`, {});
      out(label(r.status));
    });

  const schedules = program.command('schedules').description('Run tasks on a schedule (cron + time zone)');
  schedules
    .command('list')
    .option('--task <id>', 'only this task')
    .option('--json', 'print JSON')
    .action(async (o: { task?: string; json?: boolean }) => {
      const list = await consoleApi().get<Array<{ id: string; taskId: string; cron: string; timezone: string; enabled: boolean; nextRunAt: string | null; consecutiveFailures: number }>>('/schedules', { query: { taskId: o.task } });
      if (o.json) return json(list);
      for (const s of list) out(`${s.id.slice(0, 8)}  task ${s.taskId.slice(0, 8)}  ${s.cron} (${s.timezone})  ${s.enabled ? `next ${s.nextRunAt}` : 'paused'}${s.consecutiveFailures ? `  ${s.consecutiveFailures} failed in a row` : ''}`);
    });
  schedules
    .command('create <taskId> <cron>')
    .description('e.g. hexactra schedules create <task> "0 9 * * 1-5" --tz Europe/Madrid')
    .option('--tz <zone>', 'IANA time zone', Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC')
    .option('--queue', 'start even while an earlier run is live (default: skip)')
    .option('--policy <policy>', "agent policy for the scheduled runs (default: the task's)")
    .action(async (taskId: string, cron: string, o: { tz: string; queue?: boolean; policy?: string }) => {
      const s = await consoleApi().post<{ id: string; nextRunAt: string }>('/schedules', { taskId, cron, timezone: o.tz, ...(o.policy ? { policyId: await resolvePolicyId(o.policy) } : {}), concurrency: o.queue ? 'queue' : 'skip' });
      out(`schedule ${s.id}: next ${s.nextRunAt}`);
    });
  for (const [name, enabled] of [['pause', false], ['resume', true]] as const) {
    schedules.command(`${name} <id>`).action(async (id: string) => {
      await consoleApi().patch(`/schedules/${id}`, { enabled });
      out(enabled ? 'resumed' : 'paused');
    });
  }
  schedules.command('delete <id>').action(async (id: string) => {
    await consoleApi().delete(`/schedules/${id}`);
    out('deleted');
  });
};
