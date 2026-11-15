import { fireEvent, render, screen } from '@testing-library/react';
import { vi } from 'vitest';

import { QuestionAnswerForm } from '../components/QuestionAnswerForm';
import type { AskedQuestion } from '../components/questions';

const base: AskedQuestion = { kind: 'other', input: 'none', options: null, constraints: null, confirmLabel: null, denyLabel: null, risk: null, viewerUrl: null };

function setup(q: Partial<AskedQuestion>, extra: { onOpenBrowser?: () => void } = {}) {
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
    const onSubmit = setup({ input: 'secret', kind: 'code' });
    const field = screen.getByLabelText(/Code or secret/);
    expect(field).toHaveAttribute('type', 'password');
    expect(field).toHaveAttribute('autocomplete', 'off');
    fireEvent.change(field, { target: { value: '424242' } });
    fireEvent.click(screen.getByRole('button', { name: 'Send' }));
    expect(onSubmit).toHaveBeenCalledWith({ outcome: 'completed', value: '424242' });
    expect(field).toHaveValue('');
  });

  it('takeover: open the browser, then Done', () => {
    const open = vi.fn();
    const onSubmit = setup({ input: 'takeover', viewerUrl: 'https://viewer.example.test/s' }, { onOpenBrowser: open });
    fireEvent.click(screen.getByRole('button', { name: 'Open the browser' }));
    expect(open).toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: 'Done' }));
    expect(onSubmit).toHaveBeenCalledWith({ outcome: 'completed' });
  });

  it('none: Done; every type can be declined', () => {
    const onSubmit = setup({ input: 'none' });
    fireEvent.click(screen.getByRole('button', { name: 'Done' }));
    expect(onSubmit).toHaveBeenLastCalledWith({ outcome: 'completed' });
    fireEvent.click(screen.getByRole('button', { name: 'Decline' }));
    expect(onSubmit).toHaveBeenLastCalledWith({ outcome: 'cancelled' });
  });
});
