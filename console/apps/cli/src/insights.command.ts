// `hexactra runs diagnostics`, `tasks consistency`, `tasks improve`, `tasks improvements` and `tasks improvement` (E52.10, #1025).
// Read and request only: no command applies a proposal or changes a task. Applying is the task form's Save, in the console.
import type { Command } from 'commander';

import { consoleApi } from './console-api.js';
import { consistencyLines, findingsLines, improvementLines, type Consistency, type Finding, type Improvement } from './insights.js';

const out = (s: string): void => {
  process.stdout.write(`${s}\n`);
};
const json = (v: unknown): void => out(JSON.stringify(v, null, 2));

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
