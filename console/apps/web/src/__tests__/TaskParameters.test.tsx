// Task parameters in the task form (#556): the goal's `{{Name}}` placeholders
// become rows (type, required, options, how each gets its value, help,
// limits), follow the goal as it is edited (with undo), are inserted with a
// button, previewed under the goal, sent with the task, and the server's
// per-parameter problems land on the right row.
import { configure, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { PlatformHostProvider } from '@marinoscar/platform-web/core';
import { createTestApiError, createTestPlatformHost } from '@marinoscar/platform-web/testing';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { TaskCreatePage } from '../pages/TaskCreatePage';
import { TaskEditPage } from '../pages/TaskEditPage';
import { goalPieces, nameProblem } from '../taskParams/GoalField';
import { cleanParameters, issuesByKey, missingParameters, previewGoal, savedValueText, syncParameters, type TaskParameter } from '../taskParams/model';
import type { TaskWithSchedules } from '../taskForm/values';
import { toMemoryOptions } from '../taskParams/useMemoryOptions';
import { ConfirmProvider, ToastHost, dismissToast } from '../ui';
import { POLICY_READS } from './policyFixtures';

vi.setConfig({ testTimeout: 30_000 });
configure({ asyncUtilTimeout: 5_000 });

const TASK_ID = '11111111-1111-4111-8111-111111111111';
const NEW_ID = '44444444-4444-4444-8444-444444444444';
const MEMORY_ID = '88888888-8888-4888-8888-888888888888';
const PERMS = ['tasks:read', 'tasks:write', 'runs:write', 'memories:read'];
const ZELLE = 'Send {{Amount}} today to {{Recipient phone}} using Zelle on my Bank of America account using the checking account ending in {{Account last 4}}';

const MEMORIES = [
  { id: MEMORY_ID, kind: 'person', label: 'My wife', aliases: [], attributes: { name: 'Person A', phone: '555-010-6020' }, note: null, status: 'active', source: 'owner' },
  { id: '99999999-9999-4999-8999-999999999999', kind: 'account', label: 'Checking account', aliases: [], attributes: { bank: 'Bank X', ending: '0659' }, note: null, status: 'active', source: 'owner' },
];

const TASK: TaskWithSchedules = {
  id: TASK_ID,
  name: 'Zelle',
  goal: ZELLE,
  profile: 'default',
  hostId: null,
  hostFallback: true,
  allowedDomains: [],
  confirmRiskyActions: true,
  policyId: null,
  parameters: [
    { key: 'amount', label: 'Amount', type: 'money', required: true },
    { key: 'recipient_phone', label: 'Recipient phone', type: 'phone', required: true, default: { memory: { id: MEMORY_ID, attribute: 'phone' } } },
    { key: 'account_last_4', label: 'Account last 4', type: 'text', required: true, default: { value: '0659' } },
  ],
  summary: { schedules: [] },
};

function mount(path: string, responses: Record<string, unknown> = {}, permissions: string[] = PERMS) {
  const host = createTestPlatformHost({
    permissions,
    responses: {
      ...POLICY_READS,
      // The Memories page's own client (#551): active ones only.
      'GET /memories?status=active': MEMORIES,
      'POST /tasks': { ...TASK, id: NEW_ID },
      [`GET /tasks/${TASK_ID}?include=summary`]: TASK,
      [`PATCH /tasks/${TASK_ID}`]: TASK,
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
            <Route path="/runs/:id" element={<div>run page</div>} />
          </Routes>
        </MemoryRouter>
        <ToastHost />
      </ConfirmProvider>
    </PlatformHostProvider>,
  );
  const sent = (method: string, at: string) => host.requests.filter((r) => r.method === method && r.path === at);
  return { host, sent };
}

const goal = () => screen.getByRole('textbox', { name: /^Goal/ });
const setGoal = (value: string) => fireEvent.change(goal(), { target: { value } });
const row = (label: string) => screen.getByRole('group', { name: `Parameter ${label}` });
const choose = async (combobox: HTMLElement, option: string | RegExp) => {
  fireEvent.mouseDown(combobox);
  fireEvent.click(await screen.findByRole('option', { name: option }));
};

afterEach(() => dismissToast());

describe('the shared model', () => {
  it('keeps definitions in step with the goal and lists removed ones', () => {
    const amount: TaskParameter = { key: 'amount', label: 'How much', type: 'money', required: true };
    const r = syncParameters('Pay {{Amount}} to {{Phone Number}} and {{amount}} again', [amount]);
    expect(r.parameters.map((p) => p.key)).toEqual(['amount', 'phone_number']);
    expect(r.parameters[0]).toBe(amount);
    expect(r.parameters[1]).toEqual({ key: 'phone_number', label: 'Phone Number', type: 'text', required: true });
    expect(syncParameters('Pay someone', [amount]).removed).toEqual([amount]);
  });

  it('asks for required values without a saved one, and always for a sensitive one', () => {
    expect(missingParameters(TASK.parameters).map((p) => p.key)).toEqual(['amount']);
    expect(missingParameters([{ key: 'code', label: 'Code', type: 'text', required: false, sensitive: true }]).map((p) => p.key)).toEqual(['code']);
    expect(missingParameters([{ key: 'note', label: 'Note', type: 'text', required: false }])).toEqual([]);
  });

  it('previews the goal with saved values masked and blanks named', () => {
    const text = previewGoal('Call {{Phone}} about {{Amount}}', [
      { key: 'phone', label: 'Phone', type: 'phone', required: true, default: { value: '555-010-6020' } },
      { key: 'amount', label: 'Amount', type: 'money', required: true },
    ]);
    expect(text).toContain('[Amount]');
    expect(text).toContain('6020');
    expect(text).not.toContain('555-010-6020');
  });

  it('describes a saved value: masked, or the memory it comes from', () => {
    expect(savedValueText(TASK.parameters![1]!, (id) => (id === MEMORY_ID ? 'My wife' : undefined))).toBe('From a memory: My wife → phone');
    expect(savedValueText(TASK.parameters![2]!)).toBe('0659');
  });

  it('cleans definitions into the server order, without empty parts', () => {
    expect(
      cleanParameters([{ key: 'a', label: ' A ', type: 'text', required: true, help: ' ', default: { value: '' }, constraints: {} }, { key: 's', label: 'S', type: 'text', required: true, sensitive: true, default: { value: 'x' } }]),
    ).toEqual([{ key: 'a', label: 'A', type: 'text', required: true }, { key: 's', label: 'S', type: 'text', required: true, sensitive: true }]);
  });

  it('cuts the goal into tokens and underlines a malformed placeholder', () => {
    expect(goalPieces('Pay {{Amount}} now')).toEqual([
      { text: 'Pay ', kind: 'plain' },
      { text: '{{Amount}}', kind: 'token' },
      { text: ' now', kind: 'plain' },
    ]);
    expect(goalPieces('Pay {{ }} now').some((p) => p.kind === 'error' && p.text === '{{ }}')).toBe(true);
    expect(goalPieces('Pay {{Amount').map((p) => p.text).join('')).toBe('Pay {{Amount');
    expect(nameProblem('')).toMatch(/name/);
    expect(nameProblem('Phone Number')).toBeNull();
    expect(nameProblem('a{b')).toMatch(/letters/);
  });

  it('reads per-key issues from an API error', () => {
    expect(issuesByKey(createTestApiError(400, 'amount: Enter a number', 'INVALID_INPUT', { issues: [{ key: 'amount', message: 'Enter a number' }] }))).toEqual({ amount: 'Enter a number' });
    expect(issuesByKey(createTestApiError(400, 'x', 'SCHEDULE_INPUTS_MISSING', { issues: [{ key: 'amount', path: 'schedules[0].inputs.amount', message: 'Needed' }] }))).toEqual({ amount: 'Needed' });
    expect(issuesByKey(new Error('no'))).toBeNull();
  });
});

describe('the Parameters section of the task form', () => {
  it('adds a row when {{Amount}} is typed, previews the goal, and sends the definitions', async () => {
    const { sent } = mount('/tasks/new');
    await screen.findByRole('form', { name: 'New task' });
    fireEvent.change(screen.getByLabelText(/^Name/), { target: { value: 'Pay' } });
    expect(screen.queryByRole('heading', { name: 'Parameters' })).not.toBeInTheDocument();
    setGoal('Send {{Amount}} to the landlord');
    expect(await screen.findByRole('heading', { name: 'Parameters' })).toBeInTheDocument();
    expect(row('Amount')).toBeInTheDocument();
    // The goal is still one plain, labelled text area, its tokens drawn behind it.
    expect(goal()).toHaveValue('Send {{Amount}} to the landlord');
    expect(screen.getByTestId('goal-overlay').querySelectorAll('[data-token]')).toHaveLength(1);
    expect(screen.getByLabelText('Goal preview')).toHaveTextContent('Send [Amount] to the landlord');

    await choose(within(row('Amount')).getByRole('combobox', { name: 'Type' }), 'Amount of money');
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(sent('POST', '/tasks')).toHaveLength(1));
    expect((sent('POST', '/tasks')[0]!.body as { parameters: unknown }).parameters).toEqual([{ key: 'amount', label: 'Amount', type: 'money', required: true }]);
  });

  it('sends no parameters for a goal without placeholders', async () => {
    const { sent } = mount('/tasks/new');
    await screen.findByRole('form', { name: 'New task' });
    fireEvent.change(screen.getByLabelText(/^Name/), { target: { value: 'Plain' } });
    setGoal('Check my miles');
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(sent('POST', '/tasks')).toHaveLength(1));
    expect(sent('POST', '/tasks')[0]!.body).not.toHaveProperty('parameters');
  });

  it('removing or renaming a placeholder removes its row, and Undo brings it back', async () => {
    mount('/tasks/new');
    await screen.findByRole('form', { name: 'New task' });
    setGoal('Send {{Amount}} to {{Phone}}');
    fireEvent.change(within(row('Amount')).getByRole('textbox', { name: 'Help text' }), { target: { value: 'In dollars' } });
    setGoal('Send money to {{Phone}}');
    expect(screen.queryByRole('group', { name: 'Parameter Amount' })).not.toBeInTheDocument();
    expect(screen.getByRole('status')).toHaveTextContent('Parameter “Amount” removed.');
    fireEvent.click(screen.getByRole('button', { name: 'Undo' }));
    expect(goal()).toHaveValue('Send {{Amount}} to {{Phone}}');
    // The definition came back with the goal.
    expect(within(row('Amount')).getByRole('textbox', { name: 'Help text' })).toHaveValue('In dollars');
    // A rename is a new parameter: the old one is offered back.
    setGoal('Send {{Total}} to {{Phone}}');
    expect(row('Total')).toBeInTheDocument();
    expect(screen.getByRole('status')).toHaveTextContent('Parameter “Amount” removed.');
  });

  it('Insert parameter puts {{Name}} at the caret', async () => {
    mount('/tasks/new');
    await screen.findByRole('form', { name: 'New task' });
    setGoal('Pay  today');
    const area = goal() as HTMLTextAreaElement;
    area.setSelectionRange(4, 4);
    fireEvent.select(area);
    fireEvent.click(screen.getByRole('button', { name: 'Insert parameter' }));
    const dialog = await screen.findByRole('dialog', { name: 'Insert a parameter' });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Insert' }));
    expect(within(dialog).getByText('Give the parameter a name')).toBeInTheDocument();
    fireEvent.change(within(dialog).getByRole('textbox', { name: 'Name' }), { target: { value: 'Amount' } });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Insert' }));
    await waitFor(() => expect(goal()).toHaveValue('Pay {{Amount}} today'));
    expect(row('Amount')).toBeInTheDocument();
  });

  it('underlines a malformed placeholder with the parser message and blocks Save', async () => {
    mount('/tasks/new');
    await screen.findByRole('form', { name: 'New task' });
    fireEvent.change(screen.getByLabelText(/^Name/), { target: { value: 'Broken' } });
    setGoal('Send {{Amount to the landlord');
    expect(await screen.findByText(/is not closed with/)).toBeInTheDocument();
    expect(screen.getByTestId('goal-overlay').querySelector('[data-malformed]')).not.toBeNull();
    expect(screen.getByRole('button', { name: 'Save' })).toBeDisabled();
  });

  it('a fixed value, a choice with options, and the sensitive switch', async () => {
    const { sent } = mount('/tasks/new');
    await screen.findByRole('form', { name: 'New task' });
    fireEvent.change(screen.getByLabelText(/^Name/), { target: { value: 'Mixed' } });
    setGoal('Send {{Amount}} from {{Account}} with code {{Code}}');
    // A fixed value.
    fireEvent.click(within(row('Amount')).getByRole('radio', { name: 'Always use this value' }));
    fireEvent.change(within(row('Amount')).getByRole('textbox', { name: /Amount: saved value/ }), { target: { value: '25' } });
    // A choice.
    await choose(within(row('Account')).getByRole('combobox', { name: 'Type' }), 'Choice');
    const options = within(row('Account')).getByRole('combobox', { name: 'Options' });
    for (const o of ['Checking', 'Savings']) {
      fireEvent.change(options, { target: { value: o } });
      fireEvent.keyDown(options, { key: 'Enter' });
    }
    // Sensitive: the value controls give way to the notice.
    fireEvent.click(within(row('Code')).getByRole('switch', { name: 'Sensitive' }));
    expect(within(row('Code')).getByText(/Asked every time, never stored/)).toBeInTheDocument();
    expect(within(row('Code')).queryByRole('radio', { name: 'Ask every time' })).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(sent('POST', '/tasks')).toHaveLength(1));
    expect((sent('POST', '/tasks')[0]!.body as { parameters: unknown }).parameters).toEqual([
      { key: 'amount', label: 'Amount', type: 'text', required: true, default: { value: '25' } },
      { key: 'account', label: 'Account', type: 'choice', required: true, options: ['Checking', 'Savings'] },
      { key: 'code', label: 'Code', type: 'text', required: true, sensitive: true },
    ]);
  });

  it('a default from a memory: the memory, then the value', async () => {
    const { sent } = mount('/tasks/new');
    await screen.findByRole('form', { name: 'New task' });
    fireEvent.change(screen.getByLabelText(/^Name/), { target: { value: 'Call' } });
    setGoal('Call {{Phone}}');
    const radio = await within(row('Phone')).findByRole('radio', { name: 'From a memory' });
    fireEvent.click(radio);
    await choose(within(row('Phone')).getByRole('combobox', { name: 'Memory' }), 'My wife');
    await choose(within(row('Phone')).getByRole('combobox', { name: 'Which value' }), 'phone');
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(sent('POST', '/tasks')).toHaveLength(1));
    expect((sent('POST', '/tasks')[0]!.body as { parameters: unknown }).parameters).toEqual([{ key: 'phone', label: 'Phone', type: 'text', required: true, default: { memory: { id: MEMORY_ID, attribute: 'phone' } } }]);
  });

  it('hides "From a memory" without memories:read', async () => {
    const { host } = mount('/tasks/new', {}, ['tasks:read', 'tasks:write']);
    await screen.findByRole('form', { name: 'New task' });
    setGoal('Call {{Phone}}');
    expect(within(row('Phone')).queryByRole('radio', { name: 'From a memory' })).not.toBeInTheDocument();
    expect(host.requests.some((r) => r.path.startsWith('/memories'))).toBe(false);
  });

  it('hides "From a memory" when the memories cannot be read', async () => {
    const { host } = mount('/tasks/new', { 'GET /memories?status=active': () => Promise.reject(createTestApiError(500, 'down')) });
    await screen.findByRole('form', { name: 'New task' });
    await waitFor(() => expect(host.requests.some((r) => r.path.startsWith('/memories'))).toBe(true));
    setGoal('Call {{Phone}}');
    expect(within(row('Phone')).queryByRole('radio', { name: 'From a memory' })).not.toBeInTheDocument();
  });

  it('offers the active memories by label with their value names, never their values', () => {
    expect(
      toMemoryOptions([
        { id: 'b', label: 'My wife', status: 'active', attributes: { name: 'Person A', phone: '555-010-6020' } },
        { id: 'a', label: 'Checking account', status: 'active', attributes: { ending: '0659' } },
        { id: 'c', label: 'Old address', status: 'archived', attributes: { city: 'X' } },
      ]),
    ).toEqual([
      { id: 'a', label: 'Checking account', attributes: ['ending'] },
      { id: 'b', label: 'My wife', attributes: ['name', 'phone'] },
    ]);
  });

  it('shows the server\'s problem on the parameter it names', async () => {
    mount('/tasks/new', {
      'POST /tasks': () => Promise.reject(createTestApiError(400, 'account: A choice needs 2 to 50 options', 'INVALID_PARAMETERS', { issues: [{ key: 'account', message: 'A choice needs 2 to 50 options' }] })),
    });
    await screen.findByRole('form', { name: 'New task' });
    fireEvent.change(screen.getByLabelText(/^Name/), { target: { value: 'Pick' } });
    setGoal('Use {{Amount}} from {{Account}}');
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));
    expect(await within(row('Account')).findByRole('alert')).toHaveTextContent('A choice needs 2 to 50 options');
    expect(within(row('Amount')).queryByRole('alert')).not.toBeInTheDocument();
  });

  it('loads a saved task\'s parameters unchanged, so the form is not dirty', async () => {
    const { sent } = mount(`/tasks/${TASK_ID}/edit`);
    await screen.findByRole('form', { name: 'Edit task' });
    expect(row('Amount')).toBeInTheDocument();
    expect(within(row('Recipient phone')).getByRole('radio', { name: 'From a memory' })).toBeChecked();
    expect(within(row('Account last 4')).getByRole('radio', { name: 'Always use this value' })).toBeChecked();
    expect(screen.getByRole('button', { name: 'Save' })).toBeDisabled();
    fireEvent.click(within(row('Amount')).getByRole('switch', { name: 'Required' }));
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(sent('PATCH', `/tasks/${TASK_ID}`)).toHaveLength(1));
    const body = sent('PATCH', `/tasks/${TASK_ID}`)[0]!.body as { parameters: TaskParameter[]; goal?: string };
    expect(body.goal).toBeUndefined();
    expect(body.parameters[0]).toEqual({ key: 'amount', label: 'Amount', type: 'money', required: false });
  });
});
