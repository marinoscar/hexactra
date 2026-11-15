import type { Command } from 'commander';
import type { CliCommandRegistration } from '@marinoscar/platform-cli/core';

import { consoleApi } from './console-api.js';

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
}
interface Step {
  seq: number;
  kind: string;
  action: string | null;
  ok: boolean;
  summary: string;
}
interface Run {
  id: string;
  status: string;
  goal: string;
  stepCount: number;
  result: string | null;
  error: string | null;
  createdAt: string;
  steps?: Step[];
}

const label = (s: string) => (s === 'waiting_human' ? 'needs you' : s);
const TERMINAL = new Set(['succeeded', 'failed', 'cancelled']);

/** Print new steps of a run until it ends (or `--watch` is off). */
async function show(id: string, watch: boolean, asJson: boolean): Promise<void> {
  let printed = 0;
  let lastStatus = '';
  for (;;) {
    const r = await consoleApi().get<Run>(`/runs/${id}`);
    if (asJson && !watch) return json(r);
    if (printed === 0) out(`${r.goal}`);
    for (const s of (r.steps ?? []).slice(printed)) out(`  ${s.seq}. ${s.action ?? s.kind}${s.ok ? '' : ' (failed)'}: ${s.summary}`);
    printed = r.steps?.length ?? 0;
    if (r.status !== lastStatus) {
      out(`[${label(r.status)}]`);
      lastStatus = r.status;
    }
    if (!watch || TERMINAL.has(r.status)) {
      if (r.result) out(`result: ${r.result}`);
      if (r.error) out(`error: ${r.error}`);
      if (r.status === 'failed') process.exitCode = 1;
      return;
    }
    await new Promise((res) => setTimeout(res, 2_000));
  }
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
    .option('--json', 'print JSON')
    .action(async (name: string, goal: string, o: { profile: string; allow?: string; maxSteps?: number; confirm: boolean; json?: boolean }) => {
      const t = await consoleApi().post<Task>('/tasks', {
        name,
        goal,
        profile: o.profile,
        allowedDomains: o.allow ? o.allow.split(',').map((d) => d.trim()).filter(Boolean) : [],
        confirmRiskyActions: o.confirm,
        ...(o.maxSteps ? { maxSteps: o.maxSteps } : {}),
      });
      if (o.json) return json(t);
      out(`created ${t.id}`);
    });
  tasks
    .command('run <task>')
    .description('Run a task (by id or id prefix); --watch follows it to the end')
    .option('--watch', 'follow the run')
    .option('--json', 'print JSON')
    .action(async (ref: string, o: { watch?: boolean; json?: boolean }) => {
      const list = await consoleApi().get<Task[]>('/tasks');
      const matches = list.filter((t) => t.id === ref || t.id.startsWith(ref) || t.name === ref);
      if (matches.length !== 1) throw new Error(matches.length ? `"${ref}" matches several tasks; use the id` : `No task matches "${ref}"`);
      const r = await consoleApi().post<Run>(`/tasks/${matches[0]!.id}/runs`, {});
      if (o.json && !o.watch) return json(r);
      out(`run ${r.id}`);
      if (o.watch) await show(r.id, true, false);
    });
  tasks
    .command('delete <id>')
    .action(async (id: string) => {
      await consoleApi().delete(`/tasks/${id}`);
      out('deleted');
    });

  const runs = program.command('runs').description('Runs of browser goals');
  runs
    .command('list')
    .option('--status <status>', 'filter by status')
    .option('--json', 'print JSON')
    .action(async (o: { status?: string; json?: boolean }) => {
      const list = await consoleApi().get<Run[]>('/runs', { query: { status: o.status } });
      if (o.json) return json(list);
      for (const r of list) out(`${r.id.slice(0, 8)}  ${label(r.status).padEnd(10)}  ${r.stepCount} steps  ${r.goal.slice(0, 60)}`);
    });
  runs
    .command('start <goal>')
    .description('Run an ad-hoc goal')
    .option('--profile <profile>', 'browser profile', 'default')
    .option('--watch', 'follow the run')
    .action(async (goal: string, o: { profile: string; watch?: boolean }) => {
      const r = await consoleApi().post<Run>('/runs', { goal, profile: o.profile });
      out(`run ${r.id}`);
      if (o.watch) await show(r.id, true, false);
    });
  runs
    .command('show <id>')
    .option('--watch', 'follow until it ends')
    .option('--json', 'print JSON')
    .action(async (id: string, o: { watch?: boolean; json?: boolean }) => show(id, Boolean(o.watch), Boolean(o.json)));
  runs
    .command('watch <id>')
    .description('Follow a run until it ends')
    .action(async (id: string) => show(id, true, false));
  runs
    .command('cancel <id>')
    .action(async (id: string) => {
      const r = await consoleApi().post<Run>(`/runs/${id}/cancel`, {});
      out(`${label(r.status)}${r.status === 'running' ? ' (stopping after the current step)' : ''}`);
    });
};
