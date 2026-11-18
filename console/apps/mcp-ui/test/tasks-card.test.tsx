// The tasks card (#467) against a mocked MCP Apps host: rows from the
// summaries tasks_list carries, Run and Pause shown only with their scopes,
// the actions call the right tools, Show more pages, schedules_list opens it
// too, and text only.
import { act, fireEvent, render, screen, within } from '@testing-library/react';
import { describe, expect, it } from 'vitest';

import { TasksCard } from '../src/TasksCard';
import type { TasksCardTool } from '../src/tasks-model';
import type { ToolResultLike } from '../src/shared/text';
import { mockWidgetHost } from './fixtures';

const APP = 'https://console.example.test';
const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const RUN = '99999999-9999-4999-8999-999999999999';

function task(n: number, extra: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: id(n),
    name: `Task ${n}`,
    goal: 'Check the fares',
    profile: 'default',
    allowedDomains: [],
    policyId: null,
    createdAt: '2026-11-01T10:00:00.000Z',
    updatedAt: '2026-11-01T10:00:00.000Z',
    scheduleState: 'active',
    paused: false,
    scheduleText: 'Monday to Friday at 09:00',
    nextRunAt: '2026-11-19T09:00:00.000Z',
    lastRun: { id: RUN, status: 'succeeded', finishedAt: '2026-11-18T09:03:00.000Z' },
    liveRunId: null,
    ...extra,
  };
}

const page = (items: Record<string, unknown>[], extra: Record<string, unknown> = {}): ToolResultLike => ({
  content: [{ type: 'text', text: `${items.length} tasks.` }],
  structuredContent: { items, next_cursor: null, total: items.length, app_url: APP, granted_scopes: ['runs:read', 'runs:write', 'tasks:write'], ...extra },
});

type Handler = (name: TasksCardTool, args: Record<string, unknown>) => Promise<ToolResultLike>;
const hang: Handler = () => new Promise(() => undefined);

function mount(tools: Handler = hang) {
  const m = mockWidgetHost<TasksCardTool>({ tools });
  render(<TasksCard host={m.host} />);
  return m;
}

const flush = () => act(async () => undefined);
const row = (name: string) => screen.getByText(name).closest('li')!;

describe('rows', () => {
  it('shows each task with its schedule in words, next run and last run, as text', () => {
    const evil = '<img src=x onerror=alert(1)>';
    const m = mount();
    m.push(page([task(1), task(2, { name: evil, scheduleState: 'paused', paused: true, scheduleText: 'Paused', lastRun: null })]));
    expect(screen.getByText('Your tasks')).toBeInTheDocument();
    const r1 = within(row('Task 1'));
    expect(r1.getByText(/Monday to Friday at 09:00 · Next: /)).toBeInTheDocument();
    expect(r1.getByText('Last run: Finished')).toBeInTheDocument();
    const r2 = within(row(evil));
    expect(r2.getByText('Never run')).toBeInTheDocument();
    expect(r2.getAllByText('Paused').length).toBeGreaterThan(0);
    expect(document.querySelector('img')).toBeNull();
  });

  it('Run and Pause/Resume only with their scopes', () => {
    const m = mount();
    m.push(page([task(1), task(2, { scheduleState: 'paused', paused: true })], { granted_scopes: ['runs:read'] }));
    expect(screen.queryByRole('button', { name: /^Run / })).toBeNull();
    expect(screen.queryByRole('button', { name: /^Pause / })).toBeNull();
    expect(screen.queryByRole('button', { name: /^Resume / })).toBeNull();
    expect(screen.getAllByRole('button', { name: /^Open .* in Hexactra$/ })).toHaveLength(2);
  });

  it('a task without a schedule has no Pause or Resume', () => {
    const m = mount();
    m.push(page([task(1, { scheduleState: 'none', scheduleText: null, nextRunAt: null })]));
    expect(screen.getByText('No schedule')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Pause Task 1' })).toBeNull();
    expect(screen.getByRole('button', { name: 'Run Task 1' })).toBeInTheDocument();
  });
});

describe('actions', () => {
  it('Run calls task_run; the row then shows Running with Watch, which asks the assistant', async () => {
    const m = mount(async (name) => (name === 'task_run' ? { content: [], structuredContent: { id: RUN, status: 'queued', progress: { run_id: RUN, status: 'queued' } } } : new Promise(() => undefined)));
    m.push(page([task(1)]));
    fireEvent.click(screen.getByRole('button', { name: 'Run Task 1' }));
    await flush();
    expect(m.host.callTool).toHaveBeenCalledWith('task_run', { task_id: id(1) });
    expect(within(row('Task 1')).getByText('Running')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Watch' }));
    await flush();
    expect(m.host.sendMessage).toHaveBeenCalledWith(`Show me how my Hexactra run ${RUN} is going.`);
  });

  it('Pause asks first, then calls task_pause and shows the task paused; Resume calls task_resume', async () => {
    const summary = (enabled: boolean) => ({ schedules: [{ enabled, description: 'Monday to Friday at 09:00' }], scheduleState: enabled ? 'active' : 'paused', nextRunAt: null, lastRun: null, liveRunId: null });
    const m = mount(async (name, args) => {
      if (name === 'task_pause') return { content: [], structuredContent: { id: args.task_id, name: 'Task 1', goal: 'g', summary: summary(false), skipped: [] } };
      if (name === 'task_resume') return { content: [], structuredContent: { id: args.task_id, name: 'Task 1', goal: 'g', summary: summary(true), skipped: [] } };
      return new Promise(() => undefined);
    });
    m.push(page([task(1)]));
    fireEvent.click(screen.getByRole('button', { name: 'Pause Task 1' }));
    expect(m.host.callTool).not.toHaveBeenCalled();
    fireEvent.click(within(screen.getByRole('group', { name: 'Confirm pausing Task 1' })).getByRole('button', { name: 'Pause' }));
    await flush();
    expect(m.host.callTool).toHaveBeenCalledWith('task_pause', { task_id: id(1) });
    expect(screen.getByText('Paused: it no longer starts by itself.')).toBeInTheDocument();
    // The last run the list knew is kept.
    expect(within(row('Task 1')).getByText('Last run: Finished')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Resume Task 1' }));
    await flush();
    expect(m.host.callTool).toHaveBeenLastCalledWith('task_resume', { task_id: id(1) });
    expect(screen.getByRole('button', { name: 'Pause Task 1' })).toBeInTheDocument();
  });

  it('a refused action shows its sentence on the row; a host refusal says "Not sent"', async () => {
    let host = false;
    const m = mount(async () => {
      if (host) throw new Error('declined');
      return { isError: true, content: [{ type: 'text', text: 'This task has no schedule [NO_SCHEDULES]' }] };
    });
    m.push(page([task(1)]));
    fireEvent.click(screen.getByRole('button', { name: 'Run Task 1' }));
    await flush();
    expect(within(row('Task 1')).getByRole('status')).toHaveTextContent('This task has no schedule');
    host = true;
    fireEvent.click(screen.getByRole('button', { name: 'Run Task 1' }));
    await flush();
    expect(within(row('Task 1')).getByRole('status')).toHaveTextContent(/^Not started/);
  });

  it('Open links to the task in the console', async () => {
    const m = mount();
    m.push(page([task(1)]));
    fireEvent.click(screen.getByRole('button', { name: 'Open Task 1 in Hexactra' }));
    await flush();
    expect(m.host.openLink).toHaveBeenCalledWith(`${APP}/tasks/${id(1)}`);
  });
});

describe('paging', () => {
  it('shows 20 rows, then the rest it has, then the next page through tasks_list with the cursor', async () => {
    const m = mount(async (name, args) => (name === 'tasks_list' && args.cursor === 'c2' ? page([task(26)], { next_cursor: null, total: 26 }) : new Promise(() => undefined)));
    m.push(page(Array.from({ length: 25 }, (_, i) => task(i + 1)), { next_cursor: 'c2', total: 26 }));
    expect(screen.getAllByRole('listitem')).toHaveLength(20);
    fireEvent.click(screen.getByRole('button', { name: 'Show more' }));
    expect(screen.getAllByRole('listitem')).toHaveLength(25);
    expect(m.host.callTool).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: 'Show more' }));
    await flush();
    expect(m.host.callTool).toHaveBeenCalledWith('tasks_list', { cursor: 'c2' });
    expect(screen.getAllByRole('listitem')).toHaveLength(26);
    expect(screen.queryByRole('button', { name: 'Show more' })).toBeNull();
  });
});

describe('opened by the schedules list', () => {
  it('loads the tasks itself and shows the scheduled ones', async () => {
    const m = mount(async (name) => (name === 'tasks_list' ? page([task(1), task(2, { scheduleState: 'none', scheduleText: null })]) : new Promise(() => undefined)));
    m.push({ content: [], structuredContent: { items: [{ id: id(9), taskId: id(1), cron: '0 9 * * 1-5', description: 'Monday to Friday at 09:00' }] } });
    await flush();
    expect(m.host.callTool).toHaveBeenCalledWith('tasks_list', { limit: 100 });
    expect(screen.getByText('Scheduled tasks')).toBeInTheDocument();
    expect(screen.getByText('Task 1')).toBeInTheDocument();
    expect(screen.queryByText('Task 2')).toBeNull();
  });
});
