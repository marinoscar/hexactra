import { act, fireEvent, render, screen, within } from '@testing-library/react';
import { vi } from 'vitest';

import { QuestionAnswerForm, SECRET_AUTO_HIDE_MS } from '../components/QuestionAnswerForm';
import type { AskedQuestion } from '../components/questions';

const base: AskedQuestion = { kind: 'other', input: 'none', options: null, constraints: null, confirmLabel: null, denyLabel: null, risk: null, viewerUrl: null };

function setup(q: Partial<AskedQuestion>, extra: { onOpenBrowser?: () => void; busy?: boolean; disabled?: boolean } = {}) {
  const onSubmit = vi.fn();
  render(<QuestionAnswerForm question={{ ...base, ...q }} onSubmit={onSubmit} {...extra} />);
  return onSubmit;
}

describe('QuestionAnswerForm', () => {
  it('choice: a radio group with labels and descriptions; sends the option id', () => {
    const onSubmit = setup({ input: 'choice', options: [{ id: 'w', label: 'Window', description: 'By the window' }, { id: 'a', label: 'Aisle' }] });
    expect(screen.getByText('By the window')).toBeInTheDocument();
    const send = screen.getByRole('button', { name: 'Send' });
    expect(send).toBeDisabled();
    fireEvent.click(screen.getByRole('radio', { name: /Window/ }));
    fireEvent.click(send);
    expect(onSubmit).toHaveBeenCalledWith({ outcome: 'completed', value: 'w' });
  });

  it('multi_choice: enforces min and max selections', () => {
    const onSubmit = setup({ input: 'multi_choice', options: ['A', 'B', 'C'].map((x) => ({ id: x.toLowerCase(), label: x })), constraints: { minSelections: 2, maxSelections: 2 } });
    expect(screen.getByText('Choose 2')).toBeInTheDocument();
    const send = screen.getByRole('button', { name: 'Send' });
    fireEvent.click(screen.getByRole('checkbox', { name: 'C' }));
    expect(send).toBeDisabled();
    fireEvent.click(screen.getByRole('checkbox', { name: 'A' }));
    // The maximum is reached: the remaining box is disabled.
    expect(screen.getByRole('checkbox', { name: 'B' })).toBeDisabled();
    fireEvent.click(send);
    expect(onSubmit).toHaveBeenCalledWith({ outcome: 'completed', values: ['a', 'c'] });
  });

  it('text: maxLength and pattern are checked before sending', () => {
    const onSubmit = setup({ input: 'text', constraints: { maxLength: 6, pattern: '[A-Z]{3}[0-9]{3}' } });
    const field = screen.getByLabelText('Your answer');
    expect(field).toHaveAttribute('maxlength', '6');
    fireEvent.change(field, { target: { value: 'abc123' } });
    expect(screen.getByText('This does not have the expected format')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Send' })).toBeDisabled();
    fireEvent.change(field, { target: { value: 'ABC123' } });
    fireEvent.click(screen.getByRole('button', { name: 'Send' }));
    expect(onSubmit).toHaveBeenCalledWith({ outcome: 'completed', value: 'ABC123' });
  });

  it('text: multiline renders a textarea', () => {
    setup({ input: 'text', constraints: { multiline: true } });
    expect(screen.getByLabelText('Your answer').tagName).toBe('TEXTAREA');
  });

  it('number: min, max, step and unit', () => {
    const onSubmit = setup({ input: 'number', constraints: { min: 0, max: 50, step: 0.5, unit: 'kg' } });
    const field = screen.getByLabelText('Number');
    expect(field).toHaveAttribute('type', 'number');
    expect(field).toHaveAttribute('min', '0');
    expect(field).toHaveAttribute('max', '50');
    expect(field).toHaveAttribute('step', '0.5');
    expect(screen.getByText('kg')).toBeInTheDocument();
    fireEvent.change(field, { target: { value: '60' } });
    expect(screen.getByText('At most 50')).toBeInTheDocument();
    fireEvent.change(field, { target: { value: '4.2' } });
    expect(screen.getByText('In steps of 0.5')).toBeInTheDocument();
    fireEvent.change(field, { target: { value: '4.5' } });
    fireEvent.click(screen.getByRole('button', { name: 'Send' }));
    expect(onSubmit).toHaveBeenCalledWith({ outcome: 'completed', value: '4.5' });
  });

  it('confirm (low risk): the labels answer at once', () => {
    const onSubmit = setup({ input: 'confirm', confirmLabel: 'Ship it', denyLabel: 'Hold', risk: 'low' });
    fireEvent.click(screen.getByRole('button', { name: 'Hold' }));
    expect(onSubmit).toHaveBeenLastCalledWith({ outcome: 'completed', value: 'deny' });
    fireEvent.click(screen.getByRole('button', { name: 'Ship it' }));
    expect(onSubmit).toHaveBeenLastCalledWith({ outcome: 'completed', value: 'approve' });
  });

  it('confirm (high risk): approving takes a second step', () => {
    const onSubmit = setup({ input: 'confirm', confirmLabel: 'Pay', risk: 'high' });
    fireEvent.click(screen.getByRole('button', { name: 'Pay' }));
    expect(onSubmit).not.toHaveBeenCalled();
    expect(screen.getByRole('alert')).toHaveTextContent(/high-risk/);
    fireEvent.click(screen.getByRole('button', { name: 'Back' }));
    fireEvent.click(screen.getByRole('button', { name: 'Pay' }));
    fireEvent.click(screen.getByRole('button', { name: 'Yes, Pay' }));
    expect(onSubmit).toHaveBeenCalledWith({ outcome: 'completed', value: 'approve' });
  });

  it('secret: a password field, cleared as it is sent', () => {
    const onSubmit = setup({ input: 'secret', kind: 'login' });
    const field = screen.getByLabelText('Password');
    expect(field).toHaveAttribute('type', 'password');
    expect(field).toHaveAttribute('autocomplete', 'new-password');
    fireEvent.change(field, { target: { value: 'pass-424242' } });
    fireEvent.click(screen.getByRole('button', { name: 'Send' }));
    expect(onSubmit).toHaveBeenCalledWith({ outcome: 'completed', value: 'pass-424242' });
    expect(field).toHaveValue('');
  });

  it('takeover: Open the browser is the primary action until it was opened once, then Done is', () => {
    const open = vi.fn();
    const onSubmit = setup({ input: 'takeover', viewerUrl: 'https://viewer.example.test/s' }, { onOpenBrowser: open });
    const names = () => within(screen.getByTestId('question-actions')).getAllByRole('button').map((b) => b.textContent);
    expect(names()).toEqual(['Open the browser', 'Done', 'Decline']);
    expect(screen.getByRole('button', { name: 'Open the browser' })).toHaveClass('MuiButton-contained');
    expect(screen.getByRole('button', { name: 'Done' })).toHaveClass('MuiButton-outlined');
    fireEvent.click(screen.getByRole('button', { name: 'Open the browser' }));
    expect(open).toHaveBeenCalled();
    expect(names()).toEqual(['Done', 'Open the browser', 'Decline']);
    expect(screen.getByRole('button', { name: 'Done' })).toHaveClass('MuiButton-contained');
    fireEvent.click(screen.getByRole('button', { name: 'Done' }));
    expect(onSubmit).toHaveBeenCalledWith({ outcome: 'completed' });
  });

  it('takeover without a viewer: Done is the primary action', () => {
    setup({ input: 'takeover' });
    expect(screen.getByRole('button', { name: 'Done' })).toHaveClass('MuiButton-contained');
    expect(screen.queryByRole('button', { name: 'Open the browser' })).not.toBeInTheDocument();
  });

  it('none: Done; every type can be declined', () => {
    const onSubmit = setup({ input: 'none' });
    fireEvent.click(screen.getByRole('button', { name: 'Done' }));
    expect(onSubmit).toHaveBeenLastCalledWith({ outcome: 'completed' });
    fireEvent.click(screen.getByRole('button', { name: 'Decline' }));
    expect(onSubmit).toHaveBeenLastCalledWith({ outcome: 'cancelled' });
  });

  describe('secret field', () => {
    afterEach(() => {
      vi.useRealTimers();
      vi.restoreAllMocks();
      Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => 'visible' });
    });

    it.each([
      ['code', 'Code'],
      ['login', 'Password'],
      ['other', 'Secret'],
      ['passkey', 'Secret'],
    ])('kind %s: the label is "%s", shrunk from the first render; the long sentence is helper text', (kind, label) => {
      setup({ input: 'secret', kind });
      const field = screen.getByLabelText(label);
      const labelEl = document.querySelector(`label[for="${field.id}"]`)!;
      expect(labelEl).toHaveTextContent(label);
      expect(labelEl).toHaveAttribute('data-shrink', 'true');
      expect(labelEl.textContent!.length).toBeLessThanOrEqual(8);
      const help = screen.getByText("Sent straight to the agent's browser. Never stored or shown again.");
      expect(help.tagName).toBe('P');
      expect(field).toHaveAttribute('aria-describedby', help.id);
    });

    it('starts hidden; the toggle shows and hides it without changing the value', () => {
      setup({ input: 'secret', kind: 'login' });
      const field = screen.getByLabelText('Password');
      expect(field).toHaveAttribute('type', 'password');
      fireEvent.change(field, { target: { value: 'correct horse' } });
      const show = screen.getByRole('button', { name: 'Show value' });
      expect(show).toHaveAttribute('aria-pressed', 'false');
      fireEvent.click(show);
      expect(field).toHaveAttribute('type', 'text');
      expect(field).toHaveValue('correct horse');
      const hide = screen.getByRole('button', { name: 'Hide value' });
      expect(hide).toHaveAttribute('aria-pressed', 'true');
      expect(screen.queryByRole('button', { name: 'Show value' })).not.toBeInTheDocument();
      fireEvent.click(hide);
      expect(field).toHaveAttribute('type', 'password');
      expect(field).toHaveValue('correct horse');
      expect(screen.getByRole('button', { name: 'Show value' })).toHaveAttribute('aria-pressed', 'false');
    });

    it('pressing the toggle does not take the focus from the field', () => {
      setup({ input: 'secret', kind: 'login' });
      const event = new MouseEvent('mousedown', { bubbles: true, cancelable: true });
      screen.getByRole('button', { name: 'Show value' }).dispatchEvent(event);
      expect(event.defaultPrevented).toBe(true);
    });

    it('after submit: empty, a password field again, and onSubmit got the value exactly once; nothing is logged', () => {
      const spies = (['log', 'info', 'warn', 'error', 'debug'] as const).map((m) => vi.spyOn(console, m).mockImplementation(() => undefined));
      const onSubmit = setup({ input: 'secret', kind: 'login' });
      const field = screen.getByLabelText('Password');
      fireEvent.change(field, { target: { value: 'hunter2-not-real' } });
      fireEvent.click(screen.getByRole('button', { name: 'Show value' }));
      expect(field).toHaveAttribute('type', 'text');
      fireEvent.click(screen.getByRole('button', { name: 'Send' }));
      expect(onSubmit).toHaveBeenCalledTimes(1);
      expect(onSubmit).toHaveBeenCalledWith({ outcome: 'completed', value: 'hunter2-not-real' });
      expect(field).toHaveValue('');
      expect(field).toHaveAttribute('type', 'password');
      // Not in the DOM, not in any console call.
      expect(document.body.innerHTML).not.toContain('hunter2-not-real');
      for (const spy of spies) for (const call of spy.mock.calls) expect(JSON.stringify(call)).not.toContain('hunter2-not-real');
    });

    it('a code: autocomplete one-time-code, shown from the start, a number pad for a digits-only pattern', () => {
      setup({ input: 'secret', kind: 'code', constraints: { pattern: '\\d{6}' } });
      const field = screen.getByLabelText('Code');
      expect(field).toHaveAttribute('autocomplete', 'one-time-code');
      expect(field).toHaveAttribute('type', 'text');
      expect(field).toHaveAttribute('inputmode', 'numeric');
      expect(screen.getByRole('button', { name: 'Hide value' })).toHaveAttribute('aria-pressed', 'true');
    });

    it('a code without a digits-only pattern keeps the text keyboard', () => {
      setup({ input: 'secret', kind: 'code', constraints: { pattern: '[A-Z0-9]{8}' } });
      expect(screen.getByLabelText('Code')).toHaveAttribute('inputmode', 'text');
    });

    it('other kinds: autocomplete new-password, and nothing a password manager or a keyboard would act on', () => {
      setup({ input: 'secret', kind: 'other' });
      const field = screen.getByLabelText('Secret');
      expect(field).toHaveAttribute('autocomplete', 'new-password');
      expect(field).toHaveAttribute('spellcheck', 'false');
      expect(field).toHaveAttribute('autocapitalize', 'none');
      expect(field).toHaveAttribute('autocorrect', 'off');
      expect(field).toHaveAttribute('data-1p-ignore');
      expect(field).toHaveAttribute('data-lpignore', 'true');
      expect(field).not.toHaveAttribute('name');
    });

    it('hides again when the tab becomes hidden', () => {
      setup({ input: 'secret', kind: 'login' });
      const field = screen.getByLabelText('Password');
      fireEvent.click(screen.getByRole('button', { name: 'Show value' }));
      expect(field).toHaveAttribute('type', 'text');
      Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => 'hidden' });
      fireEvent(document, new Event('visibilitychange'));
      expect(field).toHaveAttribute('type', 'password');
    });

    it('hides again after 30 s without a keystroke; a keystroke restarts the wait', () => {
      vi.useFakeTimers();
      setup({ input: 'secret', kind: 'login' });
      const field = screen.getByLabelText('Password');
      fireEvent.click(screen.getByRole('button', { name: 'Show value' }));
      act(() => void vi.advanceTimersByTime(SECRET_AUTO_HIDE_MS - 1_000));
      expect(field).toHaveAttribute('type', 'text');
      fireEvent.change(field, { target: { value: 'a' } });
      act(() => void vi.advanceTimersByTime(SECRET_AUTO_HIDE_MS - 1_000));
      expect(field).toHaveAttribute('type', 'text');
      act(() => void vi.advanceTimersByTime(1_000));
      expect(field).toHaveAttribute('type', 'password');
      expect(field).toHaveValue('a');
    });

    it('removes its listener and timer on unmount', () => {
      vi.useFakeTimers();
      const remove = vi.spyOn(document, 'removeEventListener');
      const { unmount } = render(<QuestionAnswerForm question={{ ...base, input: 'secret', kind: 'code' }} onSubmit={vi.fn()} />);
      unmount();
      expect(remove).toHaveBeenCalledWith('visibilitychange', expect.any(Function));
      expect(vi.getTimerCount()).toBe(0);
    });

    it('the toggle is disabled with the form', () => {
      setup({ input: 'secret', kind: 'login' }, { disabled: true });
      expect(screen.getByRole('button', { name: 'Show value' })).toBeDisabled();
    });
  });

  it('text: the label is shrunk from the first render; the counter is helper text, with no placeholder line without one', () => {
    setup({ input: 'text', constraints: { maxLength: 500 } });
    const field = screen.getByLabelText('Your answer');
    expect(document.querySelector(`label[for="${field.id}"]`)).toHaveAttribute('data-shrink', 'true');
    fireEvent.change(field, { target: { value: 'hello' } });
    expect(screen.getByText('5 / 500')).toBeInTheDocument();
  });

  it('text and number without constraints render no helper line', () => {
    setup({ input: 'text' });
    expect(document.querySelector('.MuiFormHelperText-root')).toBeNull();
    setup({ input: 'number' });
    expect(document.querySelector('.MuiFormHelperText-root')).toBeNull();
    expect(document.querySelector(`label[for="${screen.getByLabelText('Number').id}"]`)).toHaveAttribute('data-shrink', 'true');
    expect(screen.getByLabelText('Number')).toHaveAttribute('inputmode', 'decimal');
  });

  it('multi_choice: the helper states the rule', () => {
    setup({ input: 'multi_choice', options: ['A', 'B', 'C', 'D'].map((x) => ({ id: x.toLowerCase(), label: x })), constraints: { minSelections: 2, maxSelections: 3 } });
    expect(screen.getByText('0 of 3 selected (at least 2)')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('checkbox', { name: 'A' }));
    fireEvent.click(screen.getByRole('checkbox', { name: 'B' }));
    expect(screen.getByText('2 of 3 selected')).toBeInTheDocument();
  });

  it('choice: clicking anywhere on an option row picks it', () => {
    const onSubmit = setup({ input: 'choice', options: [{ id: 'w', label: 'Window', description: 'By the window' }, { id: 'a', label: 'Aisle' }] });
    // The description is inside the row's <label>, so the whole row is the click target.
    expect(screen.getByText('By the window').closest('label')).not.toBeNull();
    fireEvent.click(screen.getByText('By the window'));
    fireEvent.click(screen.getByRole('button', { name: 'Send' }));
    expect(onSubmit).toHaveBeenCalledWith({ outcome: 'completed', value: 'w' });
  });

  it('more than 8 options scroll inside a box; the action row stays outside it', () => {
    setup({ input: 'choice', options: Array.from({ length: 9 }, (_, i) => ({ id: `o${i}`, label: `Option ${i}` })) });
    const box = screen.getByTestId('options-scroll');
    expect(within(box).getAllByRole('radio')).toHaveLength(9);
    expect(box).not.toContainElement(screen.getByRole('button', { name: 'Send' }));
    expect(box).not.toContainElement(screen.getByRole('button', { name: 'Decline' }));
  });

  it('8 options or fewer are a plain list', () => {
    setup({ input: 'choice', options: Array.from({ length: 8 }, (_, i) => ({ id: `o${i}`, label: `Option ${i}` })) });
    expect(screen.queryByTestId('options-scroll')).not.toBeInTheDocument();
  });

  it.each([
    ['secret', { input: 'secret', viewerUrl: 'https://viewer.example.test/s' }, ['Send', 'Open the browser', 'Decline']],
    ['confirm', { input: 'confirm', confirmLabel: 'Pay', denyLabel: 'Do not pay', viewerUrl: 'https://viewer.example.test/s' }, ['Pay', 'Do not pay', 'Open the browser', 'Decline']],
    ['text', { input: 'text' }, ['Send', 'Decline']],
  ] as const)('%s: the actions are primary, Open the browser, then Decline last', (_name, q, expected) => {
    setup(q as Partial<AskedQuestion>, { onOpenBrowser: vi.fn() });
    const actions = within(screen.getByTestId('question-actions')).getAllByRole('button');
    expect(actions.map((b) => b.textContent)).toEqual(expected);
    const decline = actions[actions.length - 1]!;
    expect(decline).toHaveClass('MuiButton-text');
    expect(decline).toHaveClass('MuiButton-colorError');
  });

  it('while the answer is being sent every control is disabled and the primary shows progress', () => {
    setup({ input: 'secret', kind: 'login', viewerUrl: 'https://viewer.example.test/s' }, { onOpenBrowser: vi.fn(), busy: true });
    expect(screen.getByLabelText('Password')).toBeDisabled();
    for (const b of screen.getAllByRole('button')) expect(b).toBeDisabled();
    expect(within(screen.getByRole('button', { name: /Send/ })).getByRole('progressbar')).toBeInTheDocument();
  });

  it('a stall question (the runner asks a person to unstick a run): a takeover with the long prompt above the actions', () => {
    // What goal-runner.service.ts emits on `stall.onStall: 'ask_human'`: questionSpecSchema.parse({ kind: 'other', input: 'takeover', prompt: stallHandoffPrompt(...) }).
    const open = vi.fn();
    const onSubmit = setup({ kind: 'other', input: 'takeover', viewerUrl: 'https://viewer.example.test/s' }, { onOpenBrowser: open });
    expect(within(screen.getByTestId('question-actions')).getAllByRole('button').map((b) => b.textContent)).toEqual(['Open the browser', 'Done', 'Decline']);
    fireEvent.click(screen.getByRole('button', { name: 'Done' }));
    expect(onSubmit).toHaveBeenCalledWith({ outcome: 'completed' });
  });
});
