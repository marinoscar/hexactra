// The typed form of the widgets (#467) against the shared answer rules
// (packages/shared/question-rules.js, the module the console's form uses
// too): each input type renders and validates per its constraints; a
// high-risk confirm, a secret and a takeover render no answering control;
// prompts and labels are text, never HTML.
import { numberError, textError } from '@app/shared/question-rules';
import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

import type { CardQuestion } from '../src/shared/question';
import { QuestionForm, SECRET_TEXT, SIGNED_IN_TEXT, TAKEOVER_TEXT } from '../src/shared/QuestionForm';

const base: CardQuestion = { id: 'q1', input: 'none', prompt: 'p', options: [], constraints: null, risk: null, confirmLabel: null, denyLabel: null };

function setup(q: Partial<CardQuestion>, extra: { error?: string | null; disabled?: boolean } = {}) {
  const onSubmit = vi.fn();
  const onOpen = vi.fn();
  render(<QuestionForm question={{ ...base, ...q }} onSubmit={onSubmit} onOpen={onOpen} {...extra} />);
  return { onSubmit, onOpen };
}

/** No control that could take an answer: no field and no approve/send button. */
function expectNoAnsweringControl() {
  expect(document.querySelectorAll('input, textarea, select, [contenteditable]')).toHaveLength(0);
  for (const name of ['Send', 'Approve', 'Done', 'Decline']) expect(screen.queryByRole('button', { name })).toBeNull();
}

describe('QuestionForm (the shared answer rules)', () => {
  it('is the same module the console form uses', () => {
    expect(numberError('60', { max: 50 })).toBe('At most 50');
    expect(textError('a\nb', null)).toBe('One line only');
  });

  it('choice: radios with descriptions; Send only after a pick; sends the option id', () => {
    const { onSubmit } = setup({ input: 'choice', options: [{ id: 'w', label: 'Window', description: 'By the window' }, { id: 'a', label: 'Aisle' }] });
    expect(screen.getByText('By the window')).toBeInTheDocument();
    const send = screen.getByRole('button', { name: 'Send' });
    expect(send).toBeDisabled();
    fireEvent.click(screen.getByRole('radio', { name: /Window/ }));
    fireEvent.click(send);
    expect(onSubmit).toHaveBeenCalledWith({ outcome: 'completed', value: 'w' });
  });

  it('multi_choice: min and max selections', () => {
    const { onSubmit } = setup({ input: 'multi_choice', options: ['A', 'B', 'C'].map((x) => ({ id: x.toLowerCase(), label: x })), constraints: { minSelections: 2, maxSelections: 2 } });
    expect(screen.getByText('Choose 2')).toBeInTheDocument();
    const send = screen.getByRole('button', { name: 'Send' });
    fireEvent.click(screen.getByRole('checkbox', { name: 'C' }));
    expect(send).toBeDisabled();
    fireEvent.click(screen.getByRole('checkbox', { name: 'A' }));
    expect(screen.getByRole('checkbox', { name: 'B' })).toBeDisabled();
    expect(screen.getByText('2 of 2 selected')).toBeInTheDocument();
    fireEvent.click(send);
    expect(onSubmit).toHaveBeenCalledWith({ outcome: 'completed', values: ['a', 'c'] });
  });

  it('text: maxLength, pattern, one line; multiline is a textarea', () => {
    const { onSubmit } = setup({ input: 'text', constraints: { maxLength: 6, pattern: '[A-Z]{3}[0-9]{3}' } });
    const field = screen.getByLabelText('Your answer');
    expect(field).toHaveAttribute('maxlength', '6');
    fireEvent.input(field, { target: { value: 'abc123' } });
    expect(screen.getByRole('alert')).toHaveTextContent('This does not have the expected format');
    expect(field).toHaveAttribute('aria-invalid', 'true');
    expect(screen.getByRole('button', { name: 'Send' })).toBeDisabled();
    fireEvent.input(field, { target: { value: 'ABC123' } });
    expect(screen.getByText('6 / 6')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Send' }));
    expect(onSubmit).toHaveBeenCalledWith({ outcome: 'completed', value: 'ABC123' });
  });

  it('text: multiline renders a textarea', () => {
    setup({ input: 'text', constraints: { multiline: true } });
    expect(screen.getByLabelText('Your answer').tagName).toBe('TEXTAREA');
  });

  it('number: min, max, step and unit', () => {
    const { onSubmit } = setup({ input: 'number', constraints: { min: 0, max: 50, step: 0.5, unit: 'kg' } });
    const field = screen.getByLabelText('Number (kg)');
    expect(field).toHaveAttribute('type', 'number');
    expect(field).toHaveAttribute('min', '0');
    expect(field).toHaveAttribute('max', '50');
    expect(field).toHaveAttribute('step', '0.5');
    expect(screen.getByText('min 0 · max 50 · step 0.5')).toBeInTheDocument();
    fireEvent.input(field, { target: { value: '60' } });
    expect(screen.getByRole('alert')).toHaveTextContent('At most 50');
    fireEvent.input(field, { target: { value: '4.2' } });
    expect(screen.getByRole('alert')).toHaveTextContent('In steps of 0.5');
    fireEvent.input(field, { target: { value: '4.5' } });
    fireEvent.click(screen.getByRole('button', { name: 'Send' }));
    expect(onSubmit).toHaveBeenCalledWith({ outcome: 'completed', value: '4.5' });
  });

  it('confirm (low risk): its own labels answer at once', () => {
    const { onSubmit } = setup({ input: 'confirm', risk: 'low', confirmLabel: 'Ship it', denyLabel: 'Hold' });
    fireEvent.click(screen.getByRole('button', { name: 'Hold' }));
    expect(onSubmit).toHaveBeenLastCalledWith({ outcome: 'completed', value: 'deny' });
    fireEvent.click(screen.getByRole('button', { name: 'Ship it' }));
    expect(onSubmit).toHaveBeenLastCalledWith({ outcome: 'completed', value: 'approve' });
  });

  it('none: one acknowledgement button', () => {
    const { onSubmit } = setup({ input: 'none' });
    fireEvent.click(screen.getByRole('button', { name: 'Done' }));
    expect(onSubmit).toHaveBeenCalledWith({ outcome: 'completed' });
  });

  it('Decline sends cancelled', () => {
    const { onSubmit } = setup({ input: 'text' });
    fireEvent.click(screen.getByRole('button', { name: 'Decline' }));
    expect(onSubmit).toHaveBeenCalledWith({ outcome: 'cancelled' });
  });

  it.each([
    ['a high-risk confirm', { input: 'confirm', risk: 'high' as const }, SIGNED_IN_TEXT, 'Open inbox', 'inbox'],
    ['a confirm with no risk set (high by default)', { input: 'confirm' }, SIGNED_IN_TEXT, 'Open inbox', 'inbox'],
    ['a secret', { input: 'secret', kind: 'code' }, SECRET_TEXT, 'Open inbox', 'inbox'],
    ['a takeover', { input: 'takeover', viewerUrl: '/viewer/abc' }, TAKEOVER_TEXT, 'Open in Hexactra', 'viewer'],
  ])('%s: no answering control, only the way to Hexactra', (_n, q, text, button, where) => {
    const { onSubmit, onOpen } = setup(q);
    expect(screen.getByText(text)).toBeInTheDocument();
    expectNoAnsweringControl();
    fireEvent.click(screen.getByRole('button', { name: button }));
    expect(onOpen).toHaveBeenCalledWith(where);
    expect(onSubmit).not.toHaveBeenCalled();
  });

  it('shows the server sentence next to the controls, and disables everything while sending', () => {
    setup({ input: 'choice', options: [{ id: 'a', label: 'A' }] }, { error: 'This question expired', disabled: true });
    expect(screen.getByRole('alert')).toHaveTextContent('This question expired');
    expect(screen.getByRole('radio', { name: 'A' })).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Decline' })).toBeDisabled();
  });

  it('renders labels and descriptions as text, never HTML', () => {
    const evil = '<img src=x onerror="alert(1)"><script>alert(2)</script>';
    setup({ input: 'choice', options: [{ id: 'x', label: evil, description: evil }] });
    expect(document.querySelector('img, script')).toBeNull();
    expect(screen.getAllByText(evil)).toHaveLength(2);
  });
});
