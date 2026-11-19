// "Don't ask again" on approval cards (#555): the checkbox (off by default), the
// "Limit it" disclosure, the warning for steps that move money or delete, the
// answer it sends, and the settled text with its link to the rule.
import { fireEvent, render, screen, within } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { vi } from 'vitest';

import { RequestSettled, settledText } from '../components/ChatRequest';
import { QuestionAnswerForm } from '../components/QuestionAnswerForm';
import { answerText, type AskedQuestion, type Question, type Rememberable } from '../components/questions';
import { rememberRuleOf, NO_REMEMBER } from '../components/RememberRuleField';

const PAY: Rememberable = { kind: 'gate', host: 'example.com', category: 'payment', matchKey: 'Pay', summary: "Press 'Pay' on example.com", scopes: ['everywhere', 'this_task'] };
const DATES: Rememberable = { kind: 'ask', host: 'example.com', category: null, matchKey: 'choose_date', summary: 'Choose dates on example.com', scopes: ['everywhere'] };
const base: AskedQuestion = { kind: 'confirmation', input: 'confirm', options: null, constraints: null, confirmLabel: null, denyLabel: null, risk: 'low', viewerUrl: null };

function setup(q: Partial<AskedQuestion>, extra: { allowRemember?: boolean } = {}) {
  const onSubmit = vi.fn();
  render(<QuestionAnswerForm question={{ ...base, ...q }} onSubmit={onSubmit} {...extra} />);
  return onSubmit;
}

describe('"Don\'t ask again" (#555)', () => {
  it('is off by default: Approve sends a plain approval', () => {
    const onSubmit = setup({ rememberable: PAY });
    const box = screen.getByRole('checkbox', { name: "Don't ask again: Press 'Pay' on example.com" });
    expect(box).not.toBeChecked();
    expect(screen.queryByRole('button', { name: 'Limit it' })).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Approve' }));
    expect(onSubmit).toHaveBeenCalledWith({ outcome: 'completed', value: 'approve' });
  });

  it('ticked: the warning for a payment, the limits, and the rule in the answer', () => {
    const onSubmit = setup({ rememberable: PAY });
    fireEvent.click(screen.getByRole('checkbox', { name: /Don't ask again/ }));
    expect(screen.getByText(/The agent will do this without asking, whenever a job reaches this button on this site/)).toBeInTheDocument();
    const limit = screen.getByRole('button', { name: 'Limit it' });
    expect(limit).toHaveAttribute('aria-expanded', 'false');
    fireEvent.click(limit);
    expect(limit).toHaveAttribute('aria-expanded', 'true');
    fireEvent.click(screen.getByRole('radio', { name: 'Only in this task' }));
    fireEvent.change(screen.getByLabelText(/Up to an amount/), { target: { value: '50' } });
    fireEvent.click(screen.getByRole('button', { name: 'Approve' }));
    expect(onSubmit).toHaveBeenCalledWith({ outcome: 'completed', value: 'approve', rememberRule: { enabled: true, scope: 'this_task', maxAmount: 50 } });
  });

  it('a bad amount holds the approval until it is fixed; Deny never carries the rule', () => {
    const onSubmit = setup({ rememberable: PAY });
    fireEvent.click(screen.getByRole('checkbox', { name: /Don't ask again/ }));
    fireEvent.click(screen.getByRole('button', { name: 'Limit it' }));
    fireEvent.change(screen.getByLabelText(/Up to an amount/), { target: { value: 'lots' } });
    expect(screen.getByText('Enter an amount, like 50 or 49.99')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Approve' })).toBeDisabled();
    fireEvent.click(screen.getByRole('button', { name: 'Deny' }));
    expect(onSubmit).toHaveBeenCalledWith({ outcome: 'completed', value: 'deny' });
  });

  it('a high-risk approval keeps the tick through its second step', () => {
    const onSubmit = setup({ rememberable: PAY, risk: 'high' });
    fireEvent.click(screen.getByRole('checkbox', { name: /Don't ask again/ }));
    fireEvent.click(screen.getByRole('button', { name: 'Approve' }));
    fireEvent.click(screen.getByRole('button', { name: 'Yes, Approve' }));
    expect(onSubmit).toHaveBeenCalledWith({ outcome: 'completed', value: 'approve', rememberRule: { enabled: true } });
  });

  it('an ask: no warning and no amount; a confirmation with input none sends the rule with Approve', () => {
    const onSubmit = setup({ input: 'none', rememberable: DATES });
    fireEvent.click(screen.getByRole('checkbox', { name: "Don't ask again: Choose dates on example.com" }));
    expect(screen.queryByText(/The agent will do this without asking/)).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Limit it' }));
    expect(screen.queryByLabelText(/Up to an amount/)).not.toBeInTheDocument();
    // One scope only: no "Where" choice.
    expect(screen.queryByRole('radio')).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Approve' }));
    expect(onSubmit).toHaveBeenCalledWith({ outcome: 'completed', rememberRule: { enabled: true } });
  });

  it('is absent for a question that is not rememberable, for a secret, and where the channel cannot create a rule', () => {
    setup({});
    expect(screen.queryByTestId('remember-rule')).not.toBeInTheDocument();
  });

  it('is absent for a secret even with a rememberable (a rule never answers one)', () => {
    setup({ kind: 'code', input: 'secret', rememberable: PAY });
    expect(screen.queryByTestId('remember-rule')).not.toBeInTheDocument();
  });

  it('is absent with allowRemember false', () => {
    setup({ rememberable: PAY }, { allowRemember: false });
    expect(screen.queryByTestId('remember-rule')).not.toBeInTheDocument();
  });

  it('rememberRuleOf: the expiry choice, and the amount only for money', () => {
    expect(rememberRuleOf(PAY, NO_REMEMBER)).toBeUndefined();
    expect(rememberRuleOf(PAY, { ...NO_REMEMBER, ticked: true, days: '30' })).toEqual({ enabled: true, expiresInDays: 30 });
    expect(rememberRuleOf(DATES, { ...NO_REMEMBER, ticked: true, amount: '50' })).toEqual({ enabled: true });
    expect(rememberRuleOf(DATES, { ...NO_REMEMBER, ticked: true, scope: 'this_chat' })).toEqual({ enabled: true });
  });

  it('settled: "Allowed · won\'t ask again" with a link to the rule', () => {
    expect(settledText({ input: 'confirm' }, { outcome: 'completed', value: 'approve', rememberRule: { enabled: true } })).toBe("Allowed · won't ask again");
    expect(settledText({ input: 'confirm' }, { outcome: 'completed', value: 'approve' })).toBe('Allowed');
    render(
      <MemoryRouter>
        <RequestSettled text="Allowed · won't ask again" ruleId="11111111-1111-4111-8111-111111111111" />
      </MemoryRouter>,
    );
    const status = screen.getByRole('status');
    expect(within(status).getByRole('link', { name: 'See the saved approval' })).toHaveAttribute('href', '/settings/approvals#rule-11111111-1111-4111-8111-111111111111');
  });

  it("answerText: an answer that made a rule says it won't ask again", () => {
    const q = { ...base, status: 'answered', response: { outcome: 'completed', value: 'approve', valueWithheld: false, ruleId: 'r1' } } as unknown as Question;
    expect(answerText(q)).toBe("Approved · won't ask again: Approve");
  });
});
