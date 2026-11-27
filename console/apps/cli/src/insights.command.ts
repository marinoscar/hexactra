// `hexactra runs stats` (E53.4, #1072), `runs diagnostics`, `tasks consistency`, `tasks improve`, `tasks improvements` and `tasks improvement` (E52.10, #1025).
// Read and request only: no command applies a proposal or changes a task. Applying is the task form's Save, in the console.
import type { Command } from 'commander';

import { consoleApi } from './console-api.js';
import { consistencyLines, findingsLines, improvementLines, type Consistency, type Finding, type Improvement } from './insights.js';
import { STATS_GROUP_BY, statsLines, statsQuery, type RunStats, type StatsFlags } from './run-stats.js';
import { DATASET_FORMATS, DATASET_STATUSES, datasetBody, exportDataset, type DatasetFlags, type ExportView } from './run-dataset.js';

const out = (s: string): void => {
  process.stdout.write(`${s}\n`);
};
const json = (v: unknown): void => out(JSON.stringify(v, null, 2));

/** How long `runs dataset export` waits for the file. */
export const DATASET_WAIT_MS = 10 * 60_000;
/** The plain fetch of a dataset's signed link (never the console client: the link goes to object storage). */
let fetchFile: (url: string) => Promise<Response> = (url) => fetch(url);
export function setDatasetFetchForTests(next: ((url: string) => Promise<Response>) | null): void {
  fetchFile = next ?? ((url) => fetch(url));
}

/** How long `tasks improve --wait` polls, and how often. */
export const WAIT_FOR_MS = 4 * 60_000;
export const POLL_MS = 3_000;

let sleep: (ms: number) => Promise<void> = (ms) => new Promise((r) => setTimeout(r, ms));
/** Tests poll without waiting. */
export function setSleepForTests(next: ((ms: number) => Promise<void>) | null): void {
  sleep = next ?? ((ms) => new Promise((r) => setTimeout(r, ms)));
}

/** A task by id, id prefix or exact name. */
async function taskId(ref: string): Promise<string> {
  const list = await consoleApi().get<{ id: string; name: string }[]>('/tasks');
  const hit = list.find((t) => t.id === ref) ?? list.find((t) => t.name === ref) ?? (ref.length >= 4 ? list.filter((t) => t.id.startsWith(ref)) : []).at(0);
  if (!hit) throw new Error(`No task "${ref}". See: hexactra tasks list`);
  return hit.id;
}

function group(program: Command, name: string, description: string): Command {
  return program.commands.find((c) => c.name() === name) ?? program.command(name).description(description);
}

export function insightsCommands(program: Command): void {
  const runs = group(program, 'runs', 'Runs of browser goals');
  runs
    .command('diagnostics <run>')
    .description('What happened in a run: findings computed from its steps (loops, selector misses, repeated clicks, ...)')
    .option('--json', 'print JSON')
    .action(async (id: string, o: { json?: boolean }) => {
      const d = await consoleApi().get<{ findings: Finding[]; truncated: boolean }>(`/runs/${id}/diagnostics`);
      if (o.json) return json(d);
      for (const line of findingsLines(d.findings)) out(line);
      if (d.truncated) out('(The run is long: the findings cover its first 2,000 steps.)');
    });

  runs
    .command('stats')
    .description('How your runs behaved: success rate and p50/p90 of steps, working time, tokens and cost, optionally grouped')
    .option('--by <group>', `group by: ${STATS_GROUP_BY.join(', ')}`, 'none')
    .option('--from <time>', 'runs created at or after: 7d, 24h, 2w, 2026-06-01 or an ISO date-time')
    .option('--to <time>', 'runs created before (same forms)')
    .option('--task <task>', 'one task: its name, id or id prefix; `none` for runs without a task')
    .option('--status <status>', 'run statuses, comma-separated (succeeded, failed, cancelled, ...)')
    .option('--stop-reason <reason>', 'stop reasons, comma-separated; `budget` for every budget stop')
    .option('--policy <id>', 'an agent policy id, or builtin:<key>')
    .option('--trigger <trigger>', 'what started the runs, comma-separated (manual, schedule, api, mcp, chat, ...)')
    .option('--origin <origin>', 'where the runs were started from, comma-separated (web, cli, api, mcp, ...)')
    .option('--q <text>', 'goal contains this text')
    .option('--tz <zone>', 'IANA time zone for --by day|week (default your time zone setting)')
    .option('--json', 'print the API answer as JSON (stable: scripts and coding agents read it)')
    .action(async (o: StatsFlags & { task?: string; json?: boolean }) => {
      const task = o.task === undefined ? undefined : o.task === 'none' ? 'none' : await taskId(o.task);
      const s = await consoleApi().get<RunStats>('/runs/stats', { query: statsQuery(o, task) });
      if (o.json) return json(s);
      for (const line of statsLines(s)) out(line);
    });

  const dataset = runs.command('dataset').description('Your runs as one masked file for analysis: runs, findings and (with --steps) steps');
  dataset
    .command('export')
    .description('Make the run dataset, wait for it and save it (JSON, a zip of CSV files, or XLSX)')
    .option('--from <day>', 'runs created on or after: 7d, 2w, or 2026-06-01 (days in your time zone)')
    .option('--to <day>', 'runs created on or before (same forms)')
    .option('--status <status>', `which runs: ${DATASET_STATUSES.join(', ')}`, 'finished')
    .option('--task <task>', 'one task: its name, id or id prefix; `none` for runs without a task')
    .option('--stop-reason <reason>', 'stop reasons, comma-separated; `budget` for every budget stop')
    .option('--trigger <trigger>', 'what started the runs, comma-separated')
    .option('--steps', 'add every step (tool, outcome, masked summary, arguments and reasoning)')
    .option('--format <format>', `the file: ${DATASET_FORMATS.join(', ')}`, 'json')
    .option('-o, --output <file>', "write to this file (default: the console's file name, in the current directory)")
    .action(async (o: DatasetFlags & { task?: string; output?: string }) => {
      const task = o.task === undefined ? undefined : o.task === 'none' ? 'none' : await taskId(o.task);
      const file = await exportDataset(consoleApi(), datasetBody(o, task), { waitMs: DATASET_WAIT_MS, pollMs: POLL_MS, sleep, fetchFile, ...(o.output ? { output: o.output } : {}) });
      const counts = Object.entries(file.rowCounts).map(([k, n]) => `${n} ${k}`).join(', ');
      out(`wrote ${file.path} (${file.bytes} bytes${counts ? `; ${counts}` : ''})`);
    });
  dataset
    .command('status <export>')
    .description('Where a dataset export is (pending, running, ready, expired, failed)')
    .option('--json', 'print JSON')
    .action(async (id: string, o: { json?: boolean }) => {
      const { download: _link, ...v } = await consoleApi().get<ExportView>(`/exports/${id}`);
      // Never print the signed link: it is a credential for the file until it expires.
      if (o.json) return json(v);
      out(`${v.id}  ${v.status}${v.sizeBytes ? `  ${v.sizeBytes} bytes` : ''}${v.error ? `  ${v.error}` : ''}`);
    });

  const tasks = group(program, 'tasks', 'Saved browser goals');
  tasks
    .command('consistency <task>')
    .description("How consistent a task's runs are: the spread of steps, cost and time")
    .option('--last <n>', 'how many of the newest finished runs (3 to 50)', (v) => Number(v))
    .option('--json', 'print JSON')
    .action(async (ref: string, o: { last?: number; json?: boolean }) => {
      const id = await taskId(ref);
      const c = await consoleApi().get<Consistency>(`/tasks/${id}/consistency`, { query: o.last ? { last: String(o.last) } : {} });
      if (o.json) return json(c);
      for (const line of consistencyLines(c)) out(line);
    });
  tasks
    .command('improve <task>')
    .description('Ask for a proposal of a better goal, made from the task\'s recent runs (it never changes the task)')
    .option('--run <id...>', 'the runs to read (1 to 10); default the 5 newest finished runs')
    .option('--wait', 'wait until the proposal is ready, then print it')
    .option('--json', 'print JSON')
    .action(async (ref: string, o: { run?: string[]; wait?: boolean; json?: boolean }) => {
      const id = await taskId(ref);
      const started = await consoleApi().post<{ id: string; status: string }>(`/tasks/${id}/improvements`, o.run?.length ? { runIds: o.run } : {});
      if (!o.wait) {
        if (o.json) return json(started);
        return out(`Proposal ${started.id} queued. Read it with: hexactra tasks improvement ${started.id}`);
      }
      const until = Date.now() + WAIT_FOR_MS;
      let p = await consoleApi().get<Improvement>(`/task-improvements/${started.id}`);
      while ((p.status === 'queued' || p.status === 'running') && Date.now() < until) {
        await sleep(POLL_MS);
        p = await consoleApi().get<Improvement>(`/task-improvements/${started.id}`);
      }
      if (o.json) json(p);
      else for (const line of improvementLines(p)) out(line);
      if (p.status === 'failed') process.exitCode = 1;
    });
  tasks
    .command('improvements <task>')
    .description("A task's proposals, newest first")
    .option('--json', 'print JSON')
    .action(async (ref: string, o: { json?: boolean }) => {
      const id = await taskId(ref);
      const r = await consoleApi().get<{ items: Improvement[] }>(`/tasks/${id}/improvements`);
      if (o.json) return json(r.items);
      if (r.items.length === 0) return out('No proposals yet. Ask for one with: hexactra tasks improve <task>');
      for (const p of r.items) out(`${p.id}  ${p.status.padEnd(10)} ${p.runIds.length} run(s)  ${p.createdAt}`);
    });
  tasks
    .command('improvement <id>')
    .description('One proposal: its summary, changes with their evidence, and the proposed goal')
    .option('--json', 'print JSON')
    .action(async (id: string, o: { json?: boolean }) => {
      const p = await consoleApi().get<Improvement>(`/task-improvements/${id}`);
      if (o.json) return json(p);
      for (const line of improvementLines(p)) out(line);
      if (p.status === 'failed') process.exitCode = 1;
    });
}
