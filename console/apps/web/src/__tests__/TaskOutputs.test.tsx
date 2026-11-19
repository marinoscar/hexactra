// Task outputs in the console (E39.5, #600): the Outputs section of the task form, the block on the run page and in the
// chat's result card, and the history table on the task page.
import { configure, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { PlatformHostProvider } from '@marinoscar/platform-web/core';
import { createTestApiError, createTestPlatformHost, type TestPlatformHost } from '@marinoscar/platform-web/testing';
import { afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('../live', () => ({ subscribeRun: () => () => undefined, fetchRunScreenshot: async () => null }));
vi.mock('../components/TaskStatsChart', () => ({ default: () => <div data-testid="chart" /> }));

import { ResultCard } from '../components/ChatBrowser';
import { RunDetailPage } from '../pages/RunDetailPage';
import { TaskCreatePage, valuesFromDraft } from '../pages/TaskCreatePage';
import { TaskDetailPage } from '../pages/TaskDetailPage';
import { TaskEditPage } from '../pages/TaskEditPage';
import { cleanOutputs, effectiveKeys, outputProblems, outputValueText, type RunOutput, type TaskOutput } from '../taskOutputs/model';
import { RunOutputs } from '../taskOutputs/RunOutputs';
import { createBody, mapApiError, patchBody, valuesFromTask, validateValues, type TaskWithSchedules } from '../taskForm/values';
import type { ChatMessage, ChatTaskDraft } from '../types/chat';
import type { Run } from '../types/runs';
import { ConfirmProvider, ToastHost, dismissToast } from '../ui';
import { mockViewport } from './matchMedia';
import { POLICY_READS } from './policyFixtures';
import { RUN_ID, TASK_ID, scheduledRow, taskRow } from './taskFixtures';

vi.setConfig({ testTimeout: 30_000 });
configure({ asyncUtilTimeout: 5_000 });

const NEW_ID = '44444444-4444-4444-8444-444444444444';
const PERMS = ['tasks:read', 'tasks:write', 'runs:read', 'runs:write', 'agent_policies:read'];
const MARK = 'SENSITIVE-OUT-1234';

const OUTPUTS: TaskOutput[] = [
  { key: 'confirmation_number', label: 'Confirmation number', type: 'text', required: true, help: 'On the receipt' },
  { key: 'amount_paid', label: 'Amount paid', type: 'money', required: true },
];
const runOutput = (o: Partial<RunOutput> & Pick<RunOutput, 'key' | 'label' | 'type' | 'value'>): RunOutput => ({ required: true, sensitive: false, ok: true, note: null, ...o });
const RUN_OUTPUTS: RunOutput[] = [
  runOutput({ key: 'confirmation_number', label: 'Confirmation number', type: 'text', value: 'C-8841' }),
  runOutput({ key: 'amount_paid', label: 'Amount paid', type: 'money', value: { amount: 1250, currency: 'USD' } }),
  runOutput({ key: 'paid_on', label: 'Paid on', type: 'date', value: null, ok: false, note: 'Not found' }),
  runOutput({ key: 'balance', label: 'Balance', type: 'money', value: null, ok: false, note: 'Not an amount of money' }),
  runOutput({ key: 'account', label: 'Account', type: 'text', value: '[hidden]', sensitive: true, required: false }),
];

let restore: (() => void) | null = null;
afterEach(() => {
  restore?.();
  restore = null;
  dismissToast();
});

describe('the model', () => {
  it('derives keys from labels and suffixes a taken one', () => {
    const rows: TaskOutput[] = [
      { key: '', label: 'Amount', type: 'money', required: true },
      { key: '', label: 'amount', type: 'text', required: true },
      { key: 'balance', label: 'Anything', type: 'text', required: true },
    ];
    expect(effectiveKeys(rows)).toEqual(['amount', 'amount_2', 'balance']);
  });

  it('saves rows with a label only, trimmed, with keys filled and empty help left out', () => {
    expect(cleanOutputs([{ key: '', label: '  Amount paid ', type: 'money', required: true, help: '  ' }, { key: '', label: '', type: 'text', required: true }, { key: '', label: 'Status', type: 'choice', required: false, options: ['Paid', 'Late'], sensitive: true }])).toEqual([
      { key: 'amount_paid', label: 'Amount paid', type: 'money', required: true },
      { key: 'status', label: 'Status', type: 'choice', required: false, options: ['Paid', 'Late'], sensitive: true },
    ]);
  });

  it('finds what the server would refuse', () => {
    expect(outputProblems([{ key: '', label: 'A', type: 'choice', required: true, options: ['x'] }])).toEqual({ 0: 'A choice needs 2 to 50 options' });
    expect(outputProblems([{ key: 'Bad Key', label: 'A', type: 'text', required: true }])[0]).toMatch(/lower-case/);
    expect(outputProblems([{ key: 'a', label: 'A', type: 'text', required: true }, { key: 'a', label: 'B', type: 'text', required: true }])[1]).toMatch(/same key|this key/);
    expect(outputProblems(Array.from({ length: 31 }, (_, i) => ({ key: '', label: `L${i}`, type: 'text' as const, required: true })))[-1]).toMatch(/At most 30/);
    expect(outputProblems([{ key: '', label: '', type: 'text', required: true }])).toEqual({});
  });

  it('reads a value for a person', () => {
    expect(outputValueText(RUN_OUTPUTS[1]!)).toBe('USD 1250');
    expect(outputValueText(RUN_OUTPUTS[2]!)).toBe('Not found');
    expect(outputValueText(RUN_OUTPUTS[4]!)).toBe('[hidden]');
    expect(outputValueText(runOutput({ key: 'k', label: 'K', type: 'text', value: null, ok: true, required: false }))).toBe('—');
  });

  it('puts the outputs in the create body only when there are some, and in a patch only when they changed', () => {
    const base = valuesFromTask({ ...taskRow(), outputs: OUTPUTS } as TaskWithSchedules);
    expect(createBody({ ...base, outputs: [] }, { sendPolicy: false })).not.toHaveProperty('outputs');
    expect(createBody(base, { sendPolicy: false }).outputs).toEqual(OUTPUTS);
    expect(patchBody(base, base, { sendPolicy: false })).toBeNull();
    const { schedules: _s, ...fields } = { ...base, outputs: [] as TaskOutput[] };
    const { schedules: _i, ...initial } = base;
    expect(patchBody(fields, initial, { sendPolicy: false })).toEqual({ outputs: [] });
    expect(validateValues({ ...base, outputs: [{ key: '', label: 'A', type: 'choice', required: true }] }, { checkProfile: false })['output:0']).toMatch(/2 to 50/);
  });

  it('maps the server’s output problems to the key they name', () => {
    const e = createTestApiError(400, 'amount: Two outputs have the same key', 'INVALID_OUTPUTS', { issues: [{ key: 'amount', message: 'Two outputs have the same key' }] });
    expect(mapApiError(e, 'x')).toEqual({ fields: { 'output-key:amount': 'Two outputs have the same key' }, banner: null });
  });

  it('carries a chat draft’s outputs into the form', () => {
    const draft = { name: 'Rent', goal: 'Pay the rent', profile: 'default', hostId: null, hostFallback: true, policyId: null, allowedDomains: [], confirmRiskyActions: false, outputs: [{ key: 'confirmation_number', label: 'Confirmation number', type: 'text', required: true }] } as ChatTaskDraft;
    expect(valuesFromDraft(draft).outputs).toEqual(draft.outputs);
    expect(valuesFromDraft({ ...draft, outputs: undefined }).outputs).toEqual([]);
  });
});

function mountForm(path: string, responses: Record<string, unknown> = {}) {
  const host = createTestPlatformHost({
    permissions: PERMS,
    responses: {
      ...POLICY_READS,
      'GET /fleet/hosts': [],
      'POST /schedules/preview': { valid: true, cron: '0 9 * * 1-5', timezone: 'UTC', description: 'Weekdays', next: ['2026-11-18T09:00:00.000Z'], intervalSeconds: null },
      'POST /tasks': { ...taskRow(), id: NEW_ID },
      ...responses,
    },
  });
  render(
    <PlatformHostProvider host={host}>
      <ConfirmProvider>
        <MemoryRouter initialEntries={[path]}>
          <Routes>
            <Route path="/tasks/new" element={<TaskCreatePage />} />
            <Route path="/tasks/:id/edit" element={<TaskEditPage />} />
            <Route path="/tasks/:id" element={<div>task page</div>} />
          </Routes>
        </MemoryRouter>
        <ToastHost />
      </ConfirmProvider>
    </PlatformHostProvider>,
  );
  return host;
}
const typeInto = (label: RegExp | string, value: string, nth = 0) => fireEvent.change(screen.getAllByLabelText(label)[nth]!, { target: { value } });

describe('the task form’s Outputs section', () => {
  it('adds, fills, reorders and removes rows, shows the derived key, and posts the outputs with their keys', async () => {
    const host = mountForm('/tasks/new');
    await screen.findByRole('form', { name: 'New task' });
    const section = screen.getByRole('region', { name: 'Outputs' });
    expect(within(section).getByText(/What you want back from every run/)).toBeInTheDocument();
    fireEvent.click(within(section).getByRole('button', { name: 'Add an output' }));
    typeInto(/^Label/, 'Confirmation number');
    typeInto(/What to look for/, 'On the receipt');
    fireEvent.click(within(section).getByRole('button', { name: 'Add an output' }));
    const second = screen.getAllByLabelText(/^Label/)[1]!;
    fireEvent.change(second, { target: { value: 'Amount paid' } });
    // The key follows the label.
    expect(within(section).getByText('confirmation_number')).toBeInTheDocument();
    expect(within(section).getByText('amount_paid')).toBeInTheDocument();
    // The second row takes a type and is optional + sensitive.
    fireEvent.mouseDown(screen.getAllByRole('combobox', { name: /^Type/ })[1]!);
    fireEvent.click(await screen.findByRole('option', { name: 'Amount of money' }));
    const groups = within(section).getAllByRole('group');
    fireEvent.click(within(groups[1]!).getByRole('switch', { name: 'Required' }));
    fireEvent.click(within(groups[1]!).getByRole('switch', { name: 'Sensitive' }));
    expect(within(groups[1]!).getByText('Sensitive', { selector: '.MuiChip-label' })).toBeInTheDocument();
    // Reorder: move the second up, then back.
    fireEvent.click(within(groups[1]!).getByRole('button', { name: 'Move Amount paid up' }));
    expect(screen.getAllByLabelText(/^Label/).map((e) => (e as HTMLInputElement).value)).toEqual(['Amount paid', 'Confirmation number']);
    fireEvent.click(within(screen.getAllByRole('group')[0]!).getByRole('button', { name: 'Move Amount paid down' }));
    // A row is removed.
    fireEvent.click(within(section).getByRole('button', { name: 'Add an output' }));
    expect(screen.getAllByLabelText(/^Label/)).toHaveLength(3);
    fireEvent.click(within(screen.getAllByRole('group')[2]!).getByRole('button', { name: 'Remove Output 3' }));
    expect(screen.getAllByLabelText(/^Label/)).toHaveLength(2);

    typeInto(/^Name/, 'Pay the rent');
    typeInto(/^Goal/, 'Pay the rent and read the receipt');
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(host.requests.some((r) => r.method === 'POST' && r.path === '/tasks')).toBe(true));
    const body = host.requests.find((r) => r.method === 'POST' && r.path === '/tasks')!.body as { outputs: TaskOutput[] };
    expect(body.outputs).toEqual([
      { key: 'confirmation_number', label: 'Confirmation number', type: 'text', required: true, help: 'On the receipt' },
      { key: 'amount_paid', label: 'Amount paid', type: 'money', required: false, sensitive: true },
    ]);
  });

  it('lets the key be edited under More, and blocks Save on a choice without options', async () => {
    mountForm('/tasks/new');
    await screen.findByRole('form', { name: 'New task' });
    fireEvent.click(screen.getByRole('button', { name: 'Add an output' }));
    typeInto(/^Name/, 'Pay');
    typeInto(/^Goal/, 'Pay it');
    typeInto(/^Label/, 'Reference');
    fireEvent.click(screen.getByRole('button', { name: 'More' }));
    fireEvent.change(screen.getByLabelText('Key'), { target: { value: 'Ref No!' } });
    // The key field keeps lower-case letters, digits and _.
    expect((screen.getByLabelText('Key') as HTMLInputElement).value).toBe('refno');
    fireEvent.mouseDown(screen.getByRole('combobox', { name: /^Type/ }));
    fireEvent.click(await screen.findByRole('option', { name: 'Choice' }));
    expect(await screen.findByText('A choice needs 2 to 50 options')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Save' })).toBeDisabled();
  });

  it('hints at outputs for a scheduled task that has none', async () => {
    mountForm('/tasks/new');
    await screen.findByRole('form', { name: 'New task' });
    expect(screen.queryByText('Add outputs to keep a record of each run.')).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: /Add a schedule/ }));
    expect(await screen.findByText('Add outputs to keep a record of each run.')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Add an output' }));
    expect(screen.queryByText('Add outputs to keep a record of each run.')).not.toBeInTheDocument();
  });

  it('edits a saved task: sends the outputs only when they changed, and shows a server problem on its row', async () => {
    const task = { ...scheduledRow(), outputs: OUTPUTS } as TaskWithSchedules;
    const host = mountForm(`/tasks/${TASK_ID}/edit`, {
      [`GET /tasks/${TASK_ID}?include=summary`]: task,
      [`PATCH /tasks/${TASK_ID}`]: () => Promise.reject(createTestApiError(400, 'amount_paid: Two outputs have the same key', 'INVALID_OUTPUTS', { issues: [{ key: 'amount_paid', message: 'Two outputs have the same key' }] })),
    });
    await screen.findByRole('form', { name: 'Edit task' });
    expect(screen.getAllByLabelText(/^Label/).map((e) => (e as HTMLInputElement).value)).toEqual(['Confirmation number', 'Amount paid']);
    expect(screen.getByRole('button', { name: 'Save' })).toBeDisabled();
    fireEvent.change(screen.getAllByLabelText(/^Label/)[1]!, { target: { value: 'Total paid' } });
    // Its key stays the saved one: the label changed, the key was typed before.
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(host.requests.some((r) => r.method === 'PATCH')).toBe(true));
    const patch = host.requests.find((r) => r.method === 'PATCH')!.body as Record<string, unknown>;
    expect(Object.keys(patch)).toEqual(['outputs']);
    expect((patch.outputs as TaskOutput[])[1]).toMatchObject({ key: 'amount_paid', label: 'Total paid' });
    // The server's refusal lands on the row of that key.
    const row = await screen.findByRole('group', { name: 'Output Total paid' });
    expect(await within(row).findByText('Two outputs have the same key')).toBeInTheDocument();
  });
});

describe('the Outputs block', () => {
  it('lists label and value, marks a missing one "Not found" with the reason, hides a sensitive one, and says how many were not found', () => {
    render(<RunOutputs outputs={RUN_OUTPUTS} complete={false} />);
    const block = screen.getByRole('region', { name: 'Outputs' });
    expect(within(block).getByText('Confirmation number').nextSibling).toHaveTextContent('C-8841');
    expect(within(block).getByText('Amount paid').nextSibling).toHaveTextContent('USD 1250');
    expect(within(block).getByText('Paid on').nextSibling).toHaveTextContent('Not found');
    expect(within(block).getByText('Balance').nextSibling).toHaveTextContent('Not found · Not an amount of money');
    expect(within(block).getByText('Account').nextSibling).toHaveTextContent('[hidden]');
    expect(within(block).getByText(/2 outputs were not found/)).toBeInTheDocument();
  });

  it('renders page text as text and shows nothing for a run without outputs', () => {
    const { container } = render(<RunOutputs outputs={[runOutput({ key: 'k', label: 'K', type: 'text', value: '<img src=x onerror=alert(1)>' })]} complete />);
    expect(container.querySelector('img')).toBeNull();
    expect(screen.getByText('<img src=x onerror=alert(1)>')).toBeInTheDocument();
    expect(screen.queryByText(/were not found/)).not.toBeInTheDocument();
    const none = render(<RunOutputs outputs={null} />);
    expect(none.container).toBeEmptyDOMElement();
    const empty = render(<RunOutputs outputs={[]} />);
    expect(empty.container).toBeEmptyDOMElement();
  });

  it('is on the chat’s result card', () => {
    const message: ChatMessage = { id: 'm1', seq: 3, role: 'assistant', kind: 'result', text: 'Paid the rent.', runId: RUN_ID, meta: { status: 'succeeded', stopReason: 'finished', costUsd: 0.1, costKnown: true, stepCount: 6, outputs: RUN_OUTPUTS, outputsComplete: false }, createdAt: '2026-11-15T12:45:00Z' };
    render(
      <PlatformHostProvider host={createTestPlatformHost({ permissions: ['runs:read'] })}>
        <MemoryRouter>
          <ResultCard message={message} />
        </MemoryRouter>
      </PlatformHostProvider>,
    );
    const card = screen.getByRole('article', { name: 'Result' });
    expect(within(card).getByRole('region', { name: 'Outputs' })).toHaveTextContent('Confirmation numberC-8841');
    expect(within(card).getByRole('region', { name: 'Outputs' })).not.toHaveTextContent(MARK);
  });
});

const finishedRun = (over: Partial<Run> = {}): Run => ({
  id: RUN_ID,
  taskId: null,
  status: 'succeeded',
  trigger: 'manual',
  goal: 'Pay the rent',
  profile: 'default',
  result: 'Paid the rent.',
  error: null,
  cancelRequested: false,
  stepCount: 4,
  createdAt: '2026-11-15T12:39:00Z',
  finishedAt: '2026-11-15T12:45:00Z',
  steps: [],
  confirmedActions: [],
  outputs: RUN_OUTPUTS,
  outputsComplete: false,
  ...over,
});

function mountRun(run: Run) {
  const host = createTestPlatformHost({ permissions: ['runs:read', 'runs:write', 'runs:delete'], responses: { [`GET /runs/${run.id}`]: run } });
  render(
    <PlatformHostProvider host={host}>
      <ConfirmProvider>
        <MemoryRouter initialEntries={[`/runs/${run.id}`]}>
          <Routes>
            <Route path="/runs/:id" element={<RunDetailPage />} />
          </Routes>
        </MemoryRouter>
      </ConfirmProvider>
    </PlatformHostProvider>,
  );
  return host;
}

describe('the run page', () => {
  it('shows the Outputs block of a finished run under its result, at a phone and at a desktop width', async () => {
    for (const width of [390, 1280]) {
      restore = mockViewport(width);
      const { unmount } = render(<div />);
      unmount();
      mountRun(finishedRun());
      const block = await screen.findByRole('region', { name: 'Outputs' });
      expect(within(block).getByText('Confirmation number').nextSibling).toHaveTextContent('C-8841');
      expect(screen.getByText('Paid the rent.')).toBeInTheDocument();
      document.body.innerHTML = '';
      restore?.();
      restore = null;
    }
  });

  it('shows no block for a run without outputs, or while it is live', async () => {
    mountRun(finishedRun({ outputs: null, outputsComplete: null }));
    await screen.findByText('Paid the rent.');
    expect(screen.queryByRole('region', { name: 'Outputs' })).not.toBeInTheDocument();
  });
});

const PAGE = {
  columns: [...OUTPUTS, { key: 'account', label: 'Account', type: 'text', required: false, sensitive: true }],
  items: [
    { runId: RUN_ID, status: 'succeeded', createdAt: '2026-11-16T09:00:00Z', finishedAt: '2026-11-16T09:03:00Z', outputsComplete: true, values: { confirmation_number: RUN_OUTPUTS[0], amount_paid: RUN_OUTPUTS[1], account: RUN_OUTPUTS[4] } },
    { runId: '99999999-9999-4999-8999-999999999999', status: 'failed', createdAt: '2026-11-15T09:00:00Z', finishedAt: '2026-11-15T09:03:00Z', outputsComplete: false, values: { confirmation_number: RUN_OUTPUTS[2] } },
  ],
  nextCursor: 'c1',
};

function mountTask(page: unknown, task = taskRow({ outputs: OUTPUTS, summary: { lastRun: { id: RUN_ID, status: 'succeeded', trigger: 'manual', createdAt: '2026-11-16T09:00:00Z', finishedAt: '2026-11-16T09:03:00Z' } } })): TestPlatformHost {
  const host = createTestPlatformHost({
    permissions: [...PERMS, 'runs:delete', 'fleet:read'],
    responses: {
      ...POLICY_READS,
      'GET /fleet/hosts': [],
      [`GET /tasks/${TASK_ID}`]: task,
      [`GET /tasks/${TASK_ID}/stats`]: { days: 30, timezone: 'UTC', totals: { runs: 2, succeeded: 1, failed: 1, cancelled: 0, successRate: 0.5, costUsd: 0.1, costKnown: true }, avgDurationSeconds: 100, p95DurationSeconds: 100, avgSteps: 4, avgCostPerSuccessUsd: 0.1, series: [], stopReasons: [] },
      'GET /runs': { items: [], nextCursor: null },
      'GET /runs/counts': { total: 0, live: 0, byStatus: { queued: 0, running: 0, waiting_human: 0, paused: 0, succeeded: 0, failed: 0, cancelled: 0 }, costUsd: null, costKnown: true },
      'GET /schedules': [],
      [`GET /tasks/${TASK_ID}/outputs`]: page,
    },
  });
  render(
    <PlatformHostProvider host={host}>
      <ConfirmProvider>
        <MemoryRouter initialEntries={[`/tasks/${TASK_ID}`]}>
          <Routes>
            <Route path="/tasks/:id" element={<TaskDetailPage />} />
            <Route path="/runs/:id" element={<div>run page</div>} />
          </Routes>
        </MemoryRouter>
      </ConfirmProvider>
    </PlatformHostProvider>,
  );
  return host;
}

describe('the task page’s outputs history', () => {
  it('lists the last runs’ outputs, a column per label, a sensitive one hidden, and pages with Show older runs', async () => {
    restore = mockViewport(1280);
    const host = mountTask((req: { path: string }) => (req.path.includes('cursor=c1') ? { ...PAGE, items: [{ ...PAGE.items[1]!, runId: '88888888-8888-4888-8888-888888888888' }], nextCursor: null } : PAGE));
    const table = await screen.findByRole('table', { name: 'Outputs of the last runs' });
    const heads = within(table).getAllByRole('columnheader').map((h) => h.textContent);
    expect(heads).toEqual(expect.arrayContaining(['Run', 'Confirmation number', 'Amount paid', 'Account']));
    const rows = within(table).getAllByRole('row');
    expect(rows).toHaveLength(3);
    expect(within(rows[1]!).getByText('C-8841')).toBeInTheDocument();
    expect(within(rows[1]!).getByText('USD 1250')).toBeInTheDocument();
    expect(within(rows[1]!).getByText('[hidden]')).toBeInTheDocument();
    expect(within(rows[2]!).getByText('Not found')).toBeInTheDocument();
    expect(within(rows[2]!).getByText('Failed', { exact: false })).toBeInTheDocument();
    expect(table).not.toHaveTextContent(MARK);
    expect(host.requests.find((r) => r.path.startsWith(`/tasks/${TASK_ID}/outputs`))!.path).toContain('limit=10');
    fireEvent.click(screen.getByRole('button', { name: 'Show older runs' }));
    await waitFor(() => expect(within(screen.getByRole('table', { name: 'Outputs of the last runs' })).getAllByRole('row')).toHaveLength(4));
    expect(screen.queryByRole('button', { name: 'Show older runs' })).not.toBeInTheDocument();
  });

  it('is a card per run on a phone', async () => {
    restore = mockViewport(390);
    mountTask({ ...PAGE, nextCursor: null });
    await screen.findByTestId('task-outputs');
    await waitFor(() => expect(screen.queryByRole('table', { name: 'Outputs of the last runs' })).not.toBeInTheDocument());
    const list = screen.getByTestId('task-outputs');
    expect(within(list).getAllByText('Confirmation number').length).toBeGreaterThanOrEqual(2);
    expect(within(list).getByText('C-8841')).toBeInTheDocument();
  });

  it('says so when no run has returned outputs, and offers Retry when the load fails; a task without outputs has no section', async () => {
    restore = mockViewport(1280);
    mountTask({ columns: OUTPUTS, items: [], nextCursor: null });
    expect(await screen.findByText('No finished run has returned outputs yet.')).toBeInTheDocument();
    document.body.innerHTML = '';
    mountTask(() => Promise.reject(createTestApiError(500, 'down')));
    expect(await screen.findByText('Could not load the outputs.')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Retry' })).toBeInTheDocument();
    document.body.innerHTML = '';
    mountTask({ columns: [], items: [], nextCursor: null }, taskRow());
    await screen.findByRole('heading', { level: 1, name: 'Check fare' });
    expect(screen.queryByRole('heading', { name: 'Outputs' })).not.toBeInTheDocument();
  });
});
