// Running a task with parameters (#556): the run dialog asks only for what is
// missing, lists the saved values with Change, offers the last values (never a
// sensitive one), checks each value with the shared rules, sends `inputs`
// once, and shows the server's problem on its field. A task with nothing
// missing starts at once. Also the `form` card and the run page's Inputs.
import { configure, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { useState } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { requestTitle, settledText } from '../components/ChatRequest';
import { QuestionAnswerForm } from '../components/QuestionAnswerForm';
import { answerText, type AskedQuestion, type FormField } from '../components/questions';
import { RunInputs } from '../taskParams/RunInputs';
import { useRunInputs, type ParamTask } from '../taskParams/RunInputsDialog';
import { loadSuggestions, type TaskParameter } from '../taskParams/model';
import { mockViewport } from './matchMedia';

vi.setConfig({ testTimeout: 30_000 });
configure({ asyncUtilTimeout: 5_000 });

const PARAMS: TaskParameter[] = [
  { key: 'amount', label: 'Amount', type: 'money', required: true, help: 'In dollars' },
  { key: 'when', label: 'When', type: 'date', required: true },
  { key: 'recipient_phone', label: 'Recipient phone', type: 'phone', required: true, default: { value: '555-010-6020' } },
  { key: 'gift_code', label: 'Gift code', type: 'text', required: true, sensitive: true },
];
const TASK: ParamTask = { id: 'task-1', name: 'Zelle', parameters: PARAMS };

/** A button that runs `task` through the hook, recording what `start` got. */
function Harness({ task, start }: { task: ParamTask; start: (inputs: Record<string, string> | undefined) => Promise<{ id: string }> }) {
  const { ask, dialog } = useRunInputs();
  const [result, setResult] = useState('none');
  return (
    <>
      <button onClick={() => void ask(task, start).then((r) => setResult(r ? `started ${r.id}` : 'cancelled'))}>Run now</button>
      <output aria-label="result">{result}</output>
      {dialog}
    </>
  );
}

let restore: (() => void) | null = null;
beforeEach(() => window.localStorage.clear());
afterEach(() => {
  restore?.();
  restore = null;
});

describe('the run dialog', () => {
  it('asks only for what is missing, lists saved values, and sends inputs once', async () => {
    const start = vi.fn(async (_inputs?: Record<string, string>) => ({ id: 'run-1' }));
    render(<Harness task={TASK} start={start} />);
    fireEvent.click(screen.getByRole('button', { name: 'Run now' }));
    const dialog = await screen.findByRole('dialog', { name: 'Run “Zelle”' });
    expect(within(dialog).getByRole('textbox', { name: /^Amount/ })).toHaveAttribute('inputmode', 'decimal');
    expect(within(dialog).getByLabelText(/^When/, { selector: 'input' })).toHaveAttribute('type', 'date');
    // Saved: listed, masked, not a field until Change.
    const saved = within(dialog).getByRole('region', { name: 'Using saved values' });
    expect(saved).toHaveTextContent('Recipient phone');
    expect(saved).not.toHaveTextContent('555-010-6020');
    expect(within(dialog).queryByRole('textbox', { name: /Recipient phone/ })).not.toBeInTheDocument();
    // Sensitive: never a field here.
    expect(within(dialog).queryByLabelText(/Gift code/)).not.toBeInTheDocument();
    expect(within(dialog).getByText(/Gift code is asked for when the run starts/)).toBeInTheDocument();

    // Checked with the shared rules before anything is sent.
    fireEvent.change(within(dialog).getByRole('textbox', { name: /^Amount/ }), { target: { value: 'ten' } });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Start' }));
    expect(await within(dialog).findByText('Enter an amount such as 25 or 25.50')).toBeInTheDocument();
    expect(start).not.toHaveBeenCalled();

    fireEvent.change(within(dialog).getByRole('textbox', { name: /^Amount/ }), { target: { value: '25' } });
    fireEvent.click(within(dialog).getByRole('button', { name: 'When: today' }));
    fireEvent.click(within(dialog).getByRole('button', { name: 'Start' }));
    await waitFor(() => expect(start).toHaveBeenCalledTimes(1));
    const inputs = start.mock.calls[0]![0] as Record<string, string>;
    expect(inputs.amount).toBe('25');
    expect(inputs.when).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    expect(inputs).not.toHaveProperty('recipient_phone');
    await waitFor(() => expect(screen.getByLabelText('result')).toHaveTextContent('started run-1'));
    // Kept as a suggestion for the next run.
    expect(loadSuggestions('task-1').amount).toEqual(['25']);
  });

  it('Change overrides a saved value for this run only', async () => {
    const start = vi.fn(async (_inputs?: Record<string, string>) => ({ id: 'run-2' }));
    render(<Harness task={TASK} start={start} />);
    fireEvent.click(screen.getByRole('button', { name: 'Run now' }));
    const dialog = await screen.findByRole('dialog');
    fireEvent.click(within(dialog).getByRole('button', { name: 'Change Recipient phone' }));
    fireEvent.change(within(dialog).getByRole('textbox', { name: /^Recipient phone/ }), { target: { value: '555-010-0000' } });
    fireEvent.change(within(dialog).getByRole('textbox', { name: /^Amount/ }), { target: { value: '5' } });
    fireEvent.change(within(dialog).getByLabelText(/^When/, { selector: 'input' }), { target: { value: '2026-11-20' } });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Start' }));
    await waitFor(() => expect(start).toHaveBeenCalledWith({ amount: '5', when: '2026-11-20', recipient_phone: '555-010-0000' }));
  });

  it('offers the last values used, never a sensitive one', async () => {
    window.localStorage.setItem('hexactra.taskInputs.task-1', JSON.stringify({ amount: ['40', '25'], gift_code: ['SECRET'] }));
    expect(loadSuggestions('task-1').gift_code).toEqual(['SECRET']);
    render(<Harness task={TASK} start={vi.fn(async (_inputs?: Record<string, string>) => ({ id: 'r' }))} />);
    fireEvent.click(screen.getByRole('button', { name: 'Run now' }));
    const dialog = await screen.findByRole('dialog');
    const amount = within(dialog).getByRole('combobox', { name: /^Amount/ });
    fireEvent.mouseDown(amount);
    fireEvent.change(amount, { target: { value: '' } });
    fireEvent.keyDown(amount, { key: 'ArrowDown' });
    expect(await screen.findByRole('option', { name: '40' })).toBeInTheDocument();
    expect(screen.queryByText('SECRET')).not.toBeInTheDocument();
  });

  it('shows the server\'s refusal on its field and stays open', async () => {
    const start = vi.fn(async (_inputs?: Record<string, string>): Promise<{ id: string }> => {
      throw Object.assign(new Error('Could not start a run of “Zelle”: amount: At most 1000'), { issues: { amount: 'At most 1000' } });
    });
    render(<Harness task={TASK} start={start} />);
    fireEvent.click(screen.getByRole('button', { name: 'Run now' }));
    const dialog = await screen.findByRole('dialog');
    fireEvent.change(within(dialog).getByRole('textbox', { name: /^Amount/ }), { target: { value: '5000' } });
    fireEvent.change(within(dialog).getByLabelText(/^When/, { selector: 'input' }), { target: { value: '2026-11-20' } });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Start' }));
    expect(await within(dialog).findByText('At most 1000')).toBeInTheDocument();
    expect(within(dialog).getByRole('alert')).toHaveTextContent('Could not start');
  });

  it('Cancel starts nothing', async () => {
    const start = vi.fn(async (_inputs?: Record<string, string>) => ({ id: 'r' }));
    render(<Harness task={TASK} start={start} />);
    fireEvent.click(screen.getByRole('button', { name: 'Run now' }));
    fireEvent.click(within(await screen.findByRole('dialog')).getByRole('button', { name: 'Cancel' }));
    await waitFor(() => expect(screen.getByLabelText('result')).toHaveTextContent('cancelled'));
    expect(start).not.toHaveBeenCalled();
  });

  it('a task with nothing missing starts at once, without a dialog', async () => {
    const start = vi.fn(async (_inputs?: Record<string, string>) => ({ id: 'run-3' }));
    render(<Harness task={{ id: 't', name: 'Plain', parameters: [PARAMS[2]!, PARAMS[3]!] }} start={start} />);
    fireEvent.click(screen.getByRole('button', { name: 'Run now' }));
    await waitFor(() => expect(start).toHaveBeenCalledWith(undefined));
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
  });

  it('is a bottom sheet on a phone', async () => {
    restore = mockViewport(390);
    render(<Harness task={TASK} start={vi.fn(async (_inputs?: Record<string, string>) => ({ id: 'r' }))} />);
    fireEvent.click(screen.getByRole('button', { name: 'Run now' }));
    const sheet = await screen.findByRole('dialog', { name: 'Run “Zelle”' });
    expect(sheet.closest('.MuiDrawer-root')).not.toBeNull();
    // The focus starts in the first field and stays in the sheet.
    await waitFor(() => expect(within(sheet).getByRole('textbox', { name: /^Amount/ })).toHaveFocus());
  });
});

const FIELDS: FormField[] = [
  { key: 'amount', label: 'Amount', type: 'money', required: true },
  { key: 'when', label: 'When', type: 'date', required: true },
  { key: 'account', label: 'Account', type: 'choice', required: true, options: ['Checking', 'Savings'] },
  { key: 'phone', label: 'Phone', type: 'phone', required: false },
  { key: 'email', label: 'Email', type: 'email', required: false },
  { key: 'count', label: 'Count', type: 'number', required: false, constraints: { max: 3 } },
  { key: 'note', label: 'Note', type: 'text', required: false },
];
const FORM: AskedQuestion = { kind: 'other', input: 'form', options: null, constraints: null, confirmLabel: null, denyLabel: null, risk: null, viewerUrl: null, fields: FIELDS };

describe('the form card', () => {
  it('renders every field type, checks them, and sends the values once', async () => {
    const onSubmit = vi.fn();
    render(<QuestionAnswerForm question={FORM} onSubmit={onSubmit} />);
    expect(screen.getByRole('textbox', { name: /^Amount/ })).toHaveAttribute('inputmode', 'decimal');
    expect(screen.getByLabelText(/^When/, { selector: 'input' })).toHaveAttribute('type', 'date');
    expect(screen.getByRole('combobox', { name: /^Account/ })).toBeInTheDocument();
    expect(screen.getByRole('textbox', { name: /^Phone/ })).toHaveAttribute('type', 'tel');
    expect(screen.getByRole('textbox', { name: /^Email/ })).toHaveAttribute('type', 'email');
    expect(screen.getByRole('textbox', { name: /^Count/ })).toBeInTheDocument();

    fireEvent.change(screen.getByRole('textbox', { name: /^Count/ }), { target: { value: '9' } });
    fireEvent.click(screen.getByRole('button', { name: 'Send' }));
    expect(await screen.findByText('At most 3')).toBeInTheDocument();
    expect(screen.getAllByText('Enter a value').length).toBeGreaterThanOrEqual(2);
    expect(onSubmit).not.toHaveBeenCalled();

    fireEvent.change(screen.getByRole('textbox', { name: /^Count/ }), { target: { value: '2' } });
    fireEvent.change(screen.getByRole('textbox', { name: /^Amount/ }), { target: { value: '$25' } });
    fireEvent.change(screen.getByLabelText(/^When/, { selector: 'input' }), { target: { value: '2026-11-20' } });
    fireEvent.mouseDown(screen.getByRole('combobox', { name: /^Account/ }));
    fireEvent.click(await screen.findByRole('option', { name: 'Savings' }));
    fireEvent.click(screen.getByRole('button', { name: 'Send' }));
    await waitFor(() => expect(onSubmit).toHaveBeenCalledTimes(1));
    expect(onSubmit).toHaveBeenCalledWith({ outcome: 'completed', fields: { amount: '$25', when: '2026-11-20', account: 'Savings', count: '2' } });
  });

  it('Decline sends a cancelled answer', () => {
    const onSubmit = vi.fn();
    render(<QuestionAnswerForm question={FORM} onSubmit={onSubmit} />);
    fireEvent.click(screen.getByRole('button', { name: 'Decline' }));
    expect(onSubmit).toHaveBeenCalledWith({ outcome: 'cancelled' });
  });

  it('a sensitive field is masked and never in the settled text', () => {
    render(<QuestionAnswerForm question={{ ...FORM, fields: [{ key: 'code', label: 'Gift code', type: 'text', required: true, sensitive: true }] }} onSubmit={vi.fn()} />);
    expect(screen.getByLabelText(/^Gift code/)).toHaveAttribute('type', 'password');
    expect(answerText({ ...FORM, status: 'answered', fields: [{ key: 'code', label: 'Gift code', type: 'text', required: true, sensitive: true }, FIELDS[0]!], response: { outcome: 'completed', valueWithheld: false, fields: { code: 'X', amount: '25' }, answeredAt: '' } })).toBe('Provided: Amount: 25');
  });

  it('settles as "Provided" with the masked values, in the Inbox and the chat', () => {
    expect(answerText({ ...FORM, status: 'answered', response: { outcome: 'completed', valueWithheld: false, fields: { amount: '25', phone: '•••-•••-6020' }, channel: 'web', answeredAt: '' } })).toBe('Provided (from web): Amount: 25 · Phone: •••-•••-6020');
    expect(requestTitle({ input: 'form', kind: 'other' })).toBe('A few details to start');
    expect(settledText({ input: 'form' }, { outcome: 'completed', fields: { amount: '25' } })).toBe('Provided');
  });
});

describe('the run page Inputs block', () => {
  it('lists each value, masked as the API sent it, with where it came from', () => {
    render(
      <RunInputs
        inputs={[
          { key: 'amount', label: 'Amount', value: '25', source: 'asked' },
          { key: 'phone', label: 'Recipient phone', value: '•••-•••-6020', source: 'memory' },
          { key: 'acct', label: 'Account last 4', value: '0659', source: 'default' },
          { key: 'when', label: 'When', value: 'today', source: 'schedule' },
        ]}
      />,
    );
    const block = screen.getByRole('region', { name: 'Inputs' });
    expect(block).toHaveTextContent('Amount25 · you entered');
    expect(block).toHaveTextContent('Recipient phone•••-•••-6020 · from a memory');
    expect(block).toHaveTextContent('0659 · saved value');
    expect(block).toHaveTextContent('today · schedule');
  });

  it('is absent for a run without parameters', () => {
    const { container } = render(<RunInputs inputs={null} />);
    expect(container).toBeEmptyDOMElement();
  });
});
